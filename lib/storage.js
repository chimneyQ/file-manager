/**
 * 文件管理器 - 存储用量监控与配额
 *  · 异步递归统计上传目录用量（不阻塞事件循环，避免 38GB 目录同步遍历卡死服务）
 *  · 定时扫描并维护快照；上传前置守卫按快照做配额判定
 *  · 超过告警阈值时写一条错误日志（每次扫描最多一条）
 * 设计取舍：配额判定使用最近一次扫描的快照（近似值）；快照未就绪时放行（fail-open），
 *          保证监控异常永远不会阻塞正常上传；超管不参与私有配额。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_SCAN_INTERVAL = 6 * 60 * 60 * 1000;

function formatBytes(n) { return (Number(n || 0) / 1024 / 1024 / 1024).toFixed(2) + ' GB'; }

const createStorageMonitor = (opts) => {
  const {
    uploadDir,
    privateQuotaBytes = 0,
    totalWarnBytes = 0,
    totalLimitBytes = 0,
    scanInterval = DEFAULT_SCAN_INTERVAL,
    writeLog, getErrorLogFile, createLogEntry,
  } = opts || {};

  let snapshot = null;   // { total, files, users:{name:bytes}, zones:{shared,internal}, scannedAt }
  let scanning = false;
  let timer = null;

  const dirSize = async (dir) => {
    let total = 0, files = 0;
    const walk = async (d) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) { await walk(p); continue; }
        try { const st = await fsp.stat(p); total += st.size; files++; } catch {}
      }
    };
    await walk(dir);
    return { total, files };
  };

  const refresh = async () => {
    if (scanning) return snapshot;
    scanning = true;
    try {
      const root = await dirSize(uploadDir);
      const users = {};
      const usersDir = path.join(uploadDir, 'users');
      let entries = [];
      try { entries = await fsp.readdir(usersDir, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        users[entry.name] = (await dirSize(path.join(usersDir, entry.name))).total;
      }
      const zones = {};
      for (const z of ['shared', 'internal']) zones[z] = (await dirSize(path.join(uploadDir, z))).total;
      snapshot = { total: root.total, files: root.files, users, zones, scannedAt: Date.now() };

      if (totalWarnBytes > 0 && root.total > totalWarnBytes && writeLog && getErrorLogFile && createLogEntry) {
        const top = Object.keys(users).map(k => k + '=' + formatBytes(users[k])).join(', ') || '-';
        writeLog(getErrorLogFile(), createLogEntry({ session: {}, headers: {}, ip: '-' }, {
          loginType: '-', operation: '存储告警', path: '-', fileType: '-',
          message: '上传目录用量 ' + formatBytes(root.total) + ' 已超过告警阈值 ' + formatBytes(totalWarnBytes)
            + '（shared=' + formatBytes(zones.shared) + ' internal=' + formatBytes(zones.internal) + ' 私有=' + top + '）',
        }));
      }
    } catch (err) {
      console.error('[存储监控] 扫描失败:', err.message);
    } finally {
      scanning = false;
    }
    return snapshot;
  };

  const start = () => {
    refresh().catch(() => {});
    if (scanInterval > 0) {
      timer = setInterval(() => { refresh().catch(() => {}); }, scanInterval);
      if (timer.unref) timer.unref();
    }
  };

  const getSnapshot = () => snapshot;

  // 上传前置判定：返回 null 放行，否则返回可直接回给用户的文案
  const checkQuota = (req, relPath, incomingBytes) => {
    if (!snapshot) return null;                                  // 首次扫描未完成 → 放行
    const inc = Number(incomingBytes) || 0;
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const username = (req && req.session && req.session.username) || '';
    const isSuper = !!(req && req.session && (req.session.isSuperAdmin === true || req.session.userRole === 'superadmin'));

    if (totalLimitBytes > 0 && !isSuper && snapshot.total + inc > totalLimitBytes) {
      return '服务器存储空间已达上限（' + formatBytes(snapshot.total) + '/' + formatBytes(totalLimitBytes) + '），请联系管理员';
    }
    if (!isSuper && privateQuotaBytes > 0 && username) {
      const mine = 'users/' + username;
      if (rel === mine || rel.startsWith(mine + '/')) {
        const used = snapshot.users[username] || 0;
        if (used + inc > privateQuotaBytes) {
          return '你的私有空间配额已满（' + formatBytes(used) + '/' + formatBytes(privateQuotaBytes) + '），请清理后重试';
        }
      }
    }
    return null;
  };

  return { start, refresh, getSnapshot, checkQuota, dirSize };
};

module.exports = { createStorageMonitor, formatBytes };
