/**
 * 文件管理器 - 日志系统模块
 * v2 (2026-10-09 优化)
 * 相对 v1 的改动（对外 API 完全不变）：
 *   1. 文件名按【本地日期】（v1 用 toISOString 取 UTC 日期，中国时区下 00:00-08:00 的日志
 *      会写进前一天的文件，导致日期筛选/查询错位）
 *   2. userAgent 默认压缩为摘要（如 "WeChat/7.0.20 Chrome/144 Windows10"），
 *      实测 UA 占日志体积约 90%；可用 logs.userAgentMode='raw' 恢复原始 UA
 *   3. 写入改为【批量落盘】（缓冲 500ms / 256KB 触发一次 appendFile），
 *      v1 是每条日志一次 appendFile（open+close）
 *   4. 轮转统一处理 access_* 与 error_*，且对【所有】超限文件按大小归档；
 *      v1 只检查当天那一个文件，历史 7MB 文件永远不会被轮转
 *   5. readLogs 增加读取上限，避免"本月"查询把上百 MB 日志全量读进内存
 */

const fs = require('fs-extra');
const path = require('path');
const { formatDateTime, fixGarbledPath, getClientIp, getClientExternalIp } = require('./utils');

// ---- 常量 ----
const LOG_QUEUE_MAX = 5000;          // 缓冲条数上限
const LOG_RETRY_MAX = 2;             // 单批写入重试次数
const LOG_WRITE_TIMEOUT = 5000;      // 单文件写入超时(ms)
const FLUSH_INTERVAL_MS = 500;       // 批量落盘间隔
const FLUSH_MAX_BYTES = 256 * 1024;  // 缓冲达到该字节数立即落盘
const DEFAULT_UA_MAX = 160;          // raw 模式下 UA 截断长度
const DEFAULT_MAX_READ = 200000;     // readLogs 单次最多返回条数

let _logDir = '';
let _logsCfg = {};
let _serverExternalIp = 'unknown';
let _isAdmin = () => false;

const initLogger = (logDir, logsCfg, getServerExternalIp, isAdminFn) => {
  _logDir = logDir;
  _logsCfg = logsCfg || {};
  _isAdmin = isAdminFn;
  Object.defineProperty(module.exports, 'serverExternalIp', {
    get: () => getServerExternalIp(),
  });
};

// ============================================================================
// 日志文件路径（本地日期）
// ============================================================================
const localDateStr = (d = new Date()) =>
  d.getFullYear() + '-' +
  String(d.getMonth() + 1).padStart(2, '0') + '-' +
  String(d.getDate()).padStart(2, '0');

const getLogFile = () => path.join(_logDir, 'access_' + localDateStr() + '.log');
const getErrorLogFile = () => path.join(_logDir, 'error_' + localDateStr() + '.log');

// ============================================================================
// userAgent 压缩
// ============================================================================
const summarizeUserAgent = (ua) => {
  if (typeof ua !== 'string' || !ua) return ua || 'unknown';
  const parts = [];
  const wechat = /MicroMessenger\/([\d.]+)/.exec(ua);
  if (wechat) parts.push('WeChat/' + wechat[1]);
  const edg = /Edg(?:e)?\/([\d.]+)/.exec(ua);
  if (edg) parts.push('Edge/' + edg[1]);
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome && !edg) parts.push('Chrome/' + chrome[1]);
  const ff = /Firefox\/([\d.]+)/.exec(ua);
  if (ff) parts.push('Firefox/' + ff[1]);
  if (!chrome && !edg) {
    const sf = /Version\/([\d.]+)[^)]*Safari/.exec(ua);
    if (sf) parts.push('Safari/' + sf[1]);
  }
  if (/curl\//i.test(ua)) parts.push('curl');
  const win = /Windows NT ([\d.]+)/.exec(ua);
  if (win) parts.push('Windows' + win[1]);
  else if (/Android/.test(ua)) parts.push('Android');
  else if (/iPhone|iPad|iOS/.test(ua)) parts.push('iOS');
  else if (/Mac OS X|Macintosh/.test(ua)) parts.push('macOS');
  else if (/Linux/.test(ua)) parts.push('Linux');
  if (parts.length === 0) {
    const max = _logsCfg.maxUserAgentLength || DEFAULT_UA_MAX;
    return ua.length > max ? ua.slice(0, max) + '~' : ua;
  }
  return parts.join(' ');
};

const normalizeUserAgent = (ua) => {
  if (typeof ua !== 'string') return ua;
  if ((_logsCfg.userAgentMode || 'summary') === 'raw') {
    const max = _logsCfg.maxUserAgentLength || DEFAULT_UA_MAX;
    return ua.length > max ? ua.slice(0, max) + '~' : ua;
  }
  return summarizeUserAgent(ua);
};

// ============================================================================
// 批量写入
// ============================================================================
let _buffer = [];
let _bufferBytes = 0;
let _flushTimer = null;
let _flushing = false;

const buildOverflowLine = () => JSON.stringify({
  timestamp: formatDateTime(new Date()),
  internalIp: '-', externalIp: '-', externalIpLocation: null,
  serverExternalIp: _serverExternalIp, loginType: '-', operation: '日志队列溢出',
  path: '-', fileType: '-',
  message: '日志缓冲超过 ' + LOG_QUEUE_MAX + ' 条上限，丢弃最旧条目',
}) + '\n';

const scheduleFlush = () => {
  if (_flushTimer || _flushing) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; flushBuffer(); }, FLUSH_INTERVAL_MS);
  if (_flushTimer && typeof _flushTimer.unref === 'function') _flushTimer.unref();
};

const flushBuffer = async () => {
  if (_flushing || _buffer.length === 0) return;
  _flushing = true;
  const items = _buffer;
  _buffer = [];
  _bufferBytes = 0;
  try {
    const byFile = new Map();
    for (const it of items) {
      if (!byFile.has(it.logFile)) byFile.set(it.logFile, []);
      byFile.get(it.logFile).push(it.line);
    }
    for (const group of byFile) {
      const file = group[0];
      const payload = group[1].join('');
      for (let attempt = 0; ; attempt++) {
        try {
          await Promise.race([
            fs.appendFile(file, payload, 'utf8'),
            new Promise((_, rej) => setTimeout(() => rej(new Error('写入超时')), LOG_WRITE_TIMEOUT)),
          ]);
          break;
        } catch (err) {
          if (attempt >= LOG_RETRY_MAX) {
            process.stderr.write('[日志写入] 放弃: ' + file + ' - ' + err.message + '\n');
            break;
          }
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        }
      }
    }
  } finally {
    _flushing = false;
    if (_buffer.length > 0) scheduleFlush();
  }
};

const writeLog = (logFile, logEntry) => {
  if (logEntry && logEntry.userAgent !== undefined) {
    logEntry.userAgent = normalizeUserAgent(logEntry.userAgent);
  }
  const line = JSON.stringify(logEntry) + '\n';
  if (_buffer.length >= LOG_QUEUE_MAX) {
    _buffer.splice(0, Math.ceil(LOG_QUEUE_MAX / 10));
    _buffer.push({ logFile: getErrorLogFile(), line: buildOverflowLine() });
  }
  _buffer.push({ logFile, line });
  _bufferBytes += Buffer.byteLength(line, 'utf8');
  if (_bufferBytes >= FLUSH_MAX_BYTES) { flushBuffer(); return; }
  scheduleFlush();
};

// ============================================================================
// 日志条目
// ============================================================================
const createLogEntry = (req, fields) => ({
  timestamp: formatDateTime(new Date()),
  internalIp: getClientIp(req),
  externalIp: getClientExternalIp(req),
  externalIpLocation: req.session?.externalIpLocation || null,
  serverExternalIp: _serverExternalIp,
  loginType: fields.loginType || (_isAdmin(req) ? '管理员' : '游客'),
  username: fields.username !== undefined ? fields.username : (req.session?.username || ''),
  ...fields,
});

// ============================================================================
// 日志清理 / 轮转
// ============================================================================
const MAX_ARCHIVES_PER_RUN = 20;

const rotateLogs = () => {
  try {
    const maxAge = _logsCfg.maxAge || 30 * 24 * 60 * 60 * 1000;
    const maxFiles = _logsCfg.maxFiles || 30;
    const maxFileSize = _logsCfg.maxFileSize || 10 * 1024 * 1024;
    const cutoff = Date.now() - maxAge;

    let files = [];
    try {
      files = fs.readdirSync(_logDir)
        .filter(f => f.endsWith('.log') && (f.startsWith('access_') || f.startsWith('error_')))
        .map(f => {
          const p = path.join(_logDir, f);
          const st = fs.statSync(p);
          return { name: f, p, size: st.size, time: st.mtimeMs };
        })
        .sort((a, b) => b.time - a.time);
    } catch (e) { return; }

    for (const f of files) {
      if (f.time < cutoff) { try { fs.removeSync(f.p); } catch (e) {} }
    }
    files = files.filter(f => f.time >= cutoff);

    const keep = maxFiles * 2;
    if (files.length > keep) {
      for (const f of files.slice(keep)) { try { fs.removeSync(f.p); } catch (e) {} }
      files = files.slice(0, keep);
    }

    let archived = 0;
    for (const f of files) {
      if (archived >= MAX_ARCHIVES_PER_RUN) break;
      if (f.size > maxFileSize) {
        try {
          fs.renameSync(f.p, f.p.replace(/\.log$/, '_' + Date.now() + '.log'));
          archived++;
        } catch (e) {}
      }
    }
  } catch (err) {
    process.stderr.write('[日志清理] 失败: ' + err.message + '\n');
  }
};

// ============================================================================
// 日志读取
// ============================================================================
const readLogs = (dateFilter = 'all') => {
  const allLogs = [];
  const maxRead = _logsCfg.maxReadLines || DEFAULT_MAX_READ;
  const now = new Date();
  let cutoffDate = null;

  if (dateFilter === 'today') {
    cutoffDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (dateFilter === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    cutoffDate = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
  } else if (dateFilter === 'week') {
    cutoffDate = new Date(now);
    cutoffDate.setDate(cutoffDate.getDate() - 7);
    cutoffDate.setHours(0, 0, 0, 0);
  } else if (dateFilter === 'month') {
    cutoffDate = new Date(now);
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    cutoffDate.setHours(0, 0, 0, 0);
  }

  let files = [];
  try {
    files = fs.readdirSync(_logDir)
      .filter(f => f.startsWith('access_') && f.endsWith('.log'))
      .sort()
      .reverse();
  } catch (e) { return allLogs; }

  outer:
  for (const file of files) {
    const filePath = path.join(_logDir, file);
    const fileDateMatch = file.match(/access_(\d{4}-\d{2}-\d{2})/);
    if (!fileDateMatch) continue;
    const fileDate = new Date(fileDateMatch[1] + 'T00:00:00');

    if (cutoffDate && fileDate < cutoffDate) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (!content.trim()) continue;
      const fileLines = content.split('\n');
      for (const line of fileLines) {
        if (!line.trim()) continue;
        try {
          const log = JSON.parse(line);
          if (log.path) log.path = fixGarbledPath(log.path);
          if (dateFilter === 'yesterday') {
            const logDate = new Date(log.timestamp);
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            if (logDate >= today) continue;
          }
          allLogs.push(log);
          if (allLogs.length >= maxRead) break outer;
        } catch { /* skip invalid lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  return allLogs;
};

// ============================================================================
// 下载次数统计（带缓存）
// ============================================================================
let _downloadCountCache = { data: {}, ts: 0 };

const getDownloadCounts = () => {
  const ttl = _logsCfg.downloadCountCacheMs || 300000;
  if (Date.now() - _downloadCountCache.ts < ttl) {
    return _downloadCountCache.data;
  }
  const counts = {};
  try {
    const files = fs.readdirSync(_logDir).filter(f => f.startsWith('access_') && f.endsWith('.log'));
    for (const f of files) {
      const fileLines = fs.readFileSync(path.join(_logDir, f), 'utf8').split('\n');
      for (const line of fileLines) {
        if (!line.trim()) continue;
        try {
          const log = JSON.parse(line);
          if (log.operation && log.operation.includes('下载')) {
            const p = fixGarbledPath(log.path);
            if (p) counts[p] = (counts[p] || 0) + 1;
          }
        } catch {}
      }
    }
  } catch {}
  _downloadCountCache = { data: counts, ts: Date.now() };
  return counts;
};

// 进程退出前同步刷掉缓冲，避免 pm2 restart / 关机丢掉最后一批日志
process.on('exit', () => {
  if (_buffer.length === 0) return;
  const byFile = new Map();
  for (const it of _buffer) {
    if (!byFile.has(it.logFile)) byFile.set(it.logFile, []);
    byFile.get(it.logFile).push(it.line);
  }
  for (const group of byFile) {
    try { fs.appendFileSync(group[0], group[1].join(''), 'utf8'); } catch (e) {}
  }
  _buffer = [];
});

module.exports = {
  initLogger,
  writeLog,
  createLogEntry,
  getLogFile,
  getErrorLogFile,
  rotateLogs,
  readLogs,
  getDownloadCounts,
};
