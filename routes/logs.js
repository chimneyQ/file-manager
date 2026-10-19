/**
 * 文件管理器 - 日志查看/导出路由（体验优化 v3 · 2026-10-09）
 *
 * v2: 修导出崩溃(offset) + 解析缓存 + 筛选 q/onlyError/user
 * v3:
 *   1. 接口类请求（/api/**）默认不在页面显示，可用 showApi=1 显示；同时给出被隐藏条数
 *   2. 登录成功等条目补「姓名」：优先用日志里的 name，历史条目按 username 回查 users 模块
 *   3. 统计口径与导出继承上述筛选；导出字段增加 username / name
 */

module.exports = function(app, ctx) {
  const { isAdmin, hasPermission, readLogs, writeLog, createLogEntry, getLogFile, formatSize, formatDate,
          logsCfg, performance: perfCfg } = ctx;

  const fs = require('fs');
  const path = require('path');

  const HIDE_OPS = ['设置外网IP', '服务启动'];
  const API_PREFIXES = ['/api/', '/socket.io/'];
  const CACHE_TTL_MS = 20000;
  const CRLF = String.fromCharCode(13, 10);
  const BOM = String.fromCharCode(0xFEFF);
  const _cache = new Map();

  const display = (logsCfg && logsCfg.display) || {};
  const DEFAULT_PAGE_SIZE = display.defaultPageSize || 1000;
  const MAX_PAGE_SIZE = display.maxPageSize || 5000;
  const LOAD_MORE_SIZE = display.loadMoreSize || 200;

  const localDateStr = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  const isApiPath = (p) => typeof p === 'string' && API_PREFIXES.some(pre => p.startsWith(pre));
  const showApiOf = (query) => query.showApi === '1' || query.showApi === 'true';
  const isOnlyError = (query) => query.onlyError === '1' || query.onlyError === 'true';

  // 用户名 -> 姓名（历史日志里没有 name 字段时回填）
  let _nameMap = null;
  const getNameMap = () => {
    if (_nameMap) return _nameMap;
    _nameMap = new Map();
    try {
      const usersMod = require('../lib/users');
      const all = (usersMod.findAll && usersMod.findAll()) || [];
      all.forEach(u => { if (u && u.username) _nameMap.set(u.username, u.name || ''); });
    } catch (e) {
      process.stderr.write('[logs] 用户姓名表加载失败: ' + (e && e.message) + String.fromCharCode(10));
    }
    return _nameMap;
  };
  const enrichNames = (logs) => {
    const map = getNameMap();
    if (!map.size) return logs;
    logs.forEach(l => {
      if (l && l.username && !l.name) {
        const n = map.get(l.username);
        if (n) l.name = n;
      }
    });
    return logs;
  };

  const dirSignature = () => {
    try {
      const dir = path.dirname(getLogFile());
      return fs.readdirSync(dir)
        .filter(f => f.startsWith('access_') && f.endsWith('.log'))
        .sort()
        .map(f => {
          try {
            const st = fs.statSync(path.join(dir, f));
            return f + ':' + st.size + ':' + st.mtimeMs;
          } catch (e) { return f + ':ERR'; }
        })
        .join('|');
    } catch (e) { return 'NOSIG'; }
  };

  const getCachedLogs = (dateFilter) => {
    const sig = dirSignature();
    const hit = _cache.get(dateFilter);
    if (hit && hit.sig === sig && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.logs;
    const logs = enrichNames(readLogs(dateFilter)
      .filter(l => !HIDE_OPS.includes(l.operation))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
    _cache.set(dateFilter, { logs, ts: Date.now(), sig });
    return logs;
  };

  // 关键词/只看异常/账号（不含接口过滤）
  const applyFilters = (logs, query) => {
    let out = logs;
    if (isOnlyError(query)) out = out.filter(l => Number(l.status) >= 400 || l.operation === '错误');
    const user = String(query.user || '').trim().toLowerCase();
    if (user) out = out.filter(l => String(l.username || '').toLowerCase().includes(user));
    const q = String(query.q || '').trim().toLowerCase();
    if (q) {
      out = out.filter(l =>
        String(l.path || '').toLowerCase().includes(q) ||
        String(l.internalIp || '').includes(q) ||
        String(l.externalIp || '').includes(q) ||
        String(l.username || '').toLowerCase().includes(q) ||
        String(l.name || '').toLowerCase().includes(q) ||
        String(l.operation || '').toLowerCase().includes(q));
    }
    return out;
  };

  // 返回 { logs, apiCount }
  const selectLogs = (dateFilter, query) => {
    const base = applyFilters(getCachedLogs(dateFilter), query);
    const apiLogs = base.filter(l => isApiPath(l.path));
    const showApi = showApiOf(query);
    return {
      logs: showApi ? base : base.filter(l => !isApiPath(l.path)),
      apiCount: apiLogs.length,
      showApi,
    };
  };

  const exportQuery = (req) => {
    const parts = ['date=' + encodeURIComponent(req.query.date || 'all')];
    if (isOnlyError(req.query)) parts.push('onlyError=1');
    if (showApiOf(req.query)) parts.push('showApi=1');
    if (req.query.q) parts.push('q=' + encodeURIComponent(req.query.q));
    if (req.query.user) parts.push('user=' + encodeURIComponent(req.query.user));
    return parts.join('&');
  };

  app.get('/logs', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'view_logs')) return res.status(403).send('需要查看日志权限');

    const dateFilter = ['all', 'today', 'yesterday', 'week', 'month'].includes(req.query.date)
      ? req.query.date : 'all';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    let offset = 0;
    if (req.query.page) {
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      offset = (page - 1) * limit;
    } else {
      offset = Math.max(parseInt(req.query.offset) || 0, 0);
    }

    const picked = selectLogs(dateFilter, req.query);
    const allLogs = picked.logs;

    const uniqueIps = new Set();
    let totalOps = 0;
    const opBreakdown = {};
    const ipBreakdown = {};
    const downloadBreakdown = {};
    allLogs.forEach(log => {
      const ip = (log.externalIp && log.externalIp !== '-' && log.externalIp !== 'unknown')
        ? log.externalIp : (log.internalIp || '-');
      if (ip && ip !== '-') uniqueIps.add(ip);
      ipBreakdown[ip] = (ipBreakdown[ip] || 0) + 1;
      const op = log.operation ? log.operation.replace(/s$/, '') : 'other';
      opBreakdown[op] = (opBreakdown[op] || 0) + 1;
      totalOps++;
      if (log.operation && log.operation.includes('下载') && log.path) {
        downloadBreakdown[log.path] = (downloadBreakdown[log.path] || 0) + 1;
      }
    });

    const total = allLogs.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const currentPage = Math.floor(offset / limit) + 1;
    const paginatedLogs = allLogs.slice(offset, offset + limit);

    const downloadRanking = Object.entries(downloadBreakdown)
      .map(([p, count]) => ({ path: p, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    res.render('logs', {
      logs: paginatedLogs, total, offset, limit, dateFilter,
      hasMore: offset + limit < total, currentPage, totalPages,
      uniqueDeviceCount: uniqueIps.size, totalOps,
      opBreakdown, ipBreakdown, ipCounts: ipBreakdown, downloadRanking,
      q: String(req.query.q || ''), onlyError: isOnlyError(req.query),
      showApi: picked.showApi, apiCount: picked.apiCount,
      exportQuery: exportQuery(req),
      formatSize, formatDate, darkMode: req.session && req.session.darkMode || false,
    });
  });

  app.get('/api/logs', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'view_logs')) return res.status(403).json({ success: false, message: '需要查看日志权限' });

    const dateFilter = ['all', 'today', 'yesterday', 'week', 'month'].includes(req.query.date)
      ? req.query.date : 'all';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || LOAD_MORE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const picked = selectLogs(dateFilter, req.query);
    const allLogs = picked.logs;
    const total = allLogs.length;
    const logs = allLogs.slice(offset, offset + limit);

    res.json({ logs, total, offset, limit, hasMore: offset + limit < total, apiCount: picked.apiCount, showApi: picked.showApi });
  });

  app.get('/api/logs/export', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'view_logs')) return res.status(403).json({ success: false, message: '需要查看日志权限' });

    const dateFilter = ['all', 'today', 'yesterday', 'week', 'month'].includes(req.query.date)
      ? req.query.date : 'all';
    const format = req.query.format === 'json' ? 'json' : 'csv';

    const allLogs = selectLogs(dateFilter, req.query).logs;
    const filename = 'logs_' + dateFilter + '_' + localDateStr() + '.' + format;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      return res.end(JSON.stringify(allLogs, null, 2));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');

    if (allLogs.length === 0) return res.end('');

    const fieldSet = new Set();
    allLogs.forEach(log => Object.keys(log).forEach(k => fieldSet.add(k)));
    const fields = ['timestamp', 'internalIp', 'externalIp', 'loginType', 'username', 'name', 'operation', 'method', 'path', 'status', 'duration', 'userAgent', 'message']
      .filter(f => fieldSet.has(f));

    res.write(BOM);

    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes(String.fromCharCode(10)) || s.includes(String.fromCharCode(13))) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    res.write(fields.join(',') + CRLF);

    let i = 0;
    const BATCH_SIZE = 500;
    const writeBatch = () => {
      let batch = '';
      let n = 0;
      while (i < allLogs.length && n < BATCH_SIZE) {
        const log = allLogs[i++];
        batch += fields.map(f => csvEscape(log[f])).join(',') + CRLF;
        n++;
      }
      if (batch) res.write(batch);
      if (i < allLogs.length) setImmediate(writeBatch);
      else res.end();
    };
    writeBatch();
  });
};
