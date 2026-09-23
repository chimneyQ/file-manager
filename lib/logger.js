/**
 * 文件管理器 - 日志系统模块
 * 包含：日志写入队列、读取、清理、下载统计
 */

const fs = require('fs-extra');
const path = require('path');
const { formatDateTime, fixGarbledPath, getClientIp, getClientExternalIp } = require('./utils');

// 日志写入队列
const logQueue = [];
let logWriting = false;

const LOG_QUEUE_MAX = 5000;
const LOG_RETRY_MAX = 2;
const LOG_WRITE_TIMEOUT = 5000;

let _logDir = '';
let _logsCfg = {};
let _serverExternalIp = 'unknown';
let _isAdmin = () => false;

// 初始化（由 server.js 调用）
const initLogger = (logDir, logsCfg, getServerExternalIp, isAdminFn) => {
  _logDir = logDir;
  _logsCfg = logsCfg;
  _isAdmin = isAdminFn;
  
  // 读取 / 写入 serverExternalIp 的引用
  Object.defineProperty(module.exports, 'serverExternalIp', {
    get: () => getServerExternalIp(),
  });
};

// ============================================================================
// 日志文件路径
// ============================================================================
const getLogFile = () => {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(_logDir, `access_${date}.log`);
};

const getErrorLogFile = () => {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(_logDir, `error_${date}.log`);
};

// ============================================================================
// 日志写入（队列化）
// ============================================================================
const writeLog = (logFile, logEntry) => {
  if (logQueue.length >= LOG_QUEUE_MAX) {
    logQueue.shift();
    if (logQueue.length === LOG_QUEUE_MAX - 1) {
      logQueue.unshift({ logFile: getErrorLogFile(), logEntry: {
        timestamp: formatDateTime(new Date()),
        internalIp: '-', externalIp: '-', externalIpLocation: null,
        serverExternalIp: _serverExternalIp, loginType: '-', operation: '日志队列溢出',
        path: '-', fileType: '-', message: `日志队列超过 ${LOG_QUEUE_MAX} 上限，丢弃最旧条目`,
      }, _retry: 0 });
    }
  }
  logQueue.push({ logFile, logEntry, _retry: 0 });
  if (!logWriting) processLogQueue();
};

const processLogQueue = async () => {
  if (logQueue.length === 0) { logWriting = false; return; }
  logWriting = true;
  const item = logQueue.shift();
  try {
    const line = JSON.stringify(item.logEntry) + '\n';
    await Promise.race([
      fs.appendFile(item.logFile, line, 'utf8'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('写入超时')), LOG_WRITE_TIMEOUT)),
    ]);
  } catch (err) {
    if ((item._retry || 0) < LOG_RETRY_MAX) {
      item._retry = (item._retry || 0) + 1;
      logQueue.unshift(item);
    } else {
      process.stderr.write(`[日志写入] 放弃: ${item.logFile} - ${err.message}\n`);
    }
  }
  setImmediate(processLogQueue);
};

// ============================================================================
// 创建日志条目
// ============================================================================
const createLogEntry = (req, fields) => ({
  timestamp: formatDateTime(new Date()),
  internalIp: getClientIp(req),
  externalIp: getClientExternalIp(req),
  externalIpLocation: req.session?.externalIpLocation || null,
  serverExternalIp: _serverExternalIp,
  loginType: fields.loginType || (_isAdmin(req) ? '管理员' : '游客'),
  // 记录具体账号：loginType 只有 管理员/游客 两档，多账号时无法定位到人
  username: fields.username !== undefined ? fields.username : (req.session?.username || ''),
  ...fields,
});

// ============================================================================
// 日志清理
// ============================================================================
const rotateLogs = () => {
  try {
    const files = fs.readdirSync(_logDir)
      .filter(f => f.startsWith('access_') || f.startsWith('error_'))
      .map(f => ({
        name: f,
        p: path.join(_logDir, f),
        time: fs.statSync(path.join(_logDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    const maxAge = Date.now() - _logsCfg.maxAge;
    files.forEach(f => {
      if (f.time < maxAge) {
        fs.removeSync(f.p);
        console.log(`[日志清理] 删除过期日志: ${f.name}`);
      }
    });

    if (files.length > _logsCfg.maxFiles * 2) {
      files.slice(_logsCfg.maxFiles * 2).forEach(f => {
        fs.removeSync(f.p);
        console.log(`[日志清理] 删除多余日志: ${f.name}`);
      });
    }

    const currentLog = getLogFile();
    if (fs.existsSync(currentLog)) {
      const stat = fs.statSync(currentLog);
      if (stat.size > _logsCfg.maxFileSize) {
        const timestamp = Date.now();
        const archiveName = currentLog.replace('.log', `_${timestamp}.log`);
        fs.renameSync(currentLog, archiveName);
        console.log(`[日志滚动] ${currentLog} -> ${archiveName}`);
      }
    }
  } catch (err) {
    console.error('[日志清理] 失败:', err.message);
  }
};

// ============================================================================
// 日志读取
// ============================================================================
const readLogs = (dateFilter = 'all') => {
  const allLogs = [];
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
  if (Date.now() - _downloadCountCache.ts < 30000) {
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
