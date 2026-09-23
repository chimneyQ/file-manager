/**
 * 文件管理器 - 日志查看/导出路由
 */

module.exports = function(app, ctx) {
  const { isAdmin, hasPermission, readLogs, writeLog, createLogEntry, getLogFile, formatSize, formatDate,
          logsCfg, performance: perfCfg } = ctx;

  // 访问日志页面
  app.get('/logs', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'view_logs')) return res.status(403).send('需要查看日志权限');

    const dateFilter = ['all', 'today', 'yesterday', 'week', 'month'].includes(req.query.date)
      ? req.query.date : 'all';
    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || logsCfg.display.defaultPageSize, 1),
      logsCfg.display.maxPageSize
    );
    let offset = 0;
    if (req.query.page) {
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      offset = (page - 1) * limit;
    } else {
      offset = Math.max(parseInt(req.query.offset) || 0, 0);
    }

    const HIDE_OPS = ['设置外网IP', '服务启动'];
    const allLogs = readLogs(dateFilter).filter(l => !HIDE_OPS.includes(l.operation));
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

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
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    res.render('logs', {
      logs: paginatedLogs, total, offset, limit, dateFilter,
      hasMore: offset + limit < total, currentPage, totalPages,
      uniqueDeviceCount: uniqueIps.size, totalOps,
      opBreakdown, ipBreakdown, downloadRanking,
      formatSize, formatDate, darkMode: req.session?.darkMode || false,
    });
  });

  // JSON 格式日志 API
  app.get('/api/logs', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'view_logs')) return res.status(403).json({ success: false, message: '需要查看日志权限' });

    const dateFilter = ['all', 'today', 'yesterday', 'week', 'month'].includes(req.query.date)
      ? req.query.date : 'all';
    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || logsCfg.display.loadMoreSize, 1),
      logsCfg.display.maxPageSize
    );
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const HIDE_OPS = ['设置外网IP', '服务启动'];
    const allLogs = readLogs(dateFilter).filter(l => !HIDE_OPS.includes(l.operation));
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const total = allLogs.length;
    const logs = allLogs.slice(offset, offset + limit);

    res.json({ logs, total, offset, limit, hasMore: offset + limit < total });
  });

  // 导出日志（CSV / JSON）
  app.get('/api/logs/export', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'view_logs')) return res.status(403).json({ success: false, message: '需要查看日志权限' });

    const dateFilter = ['all', 'today', 'yesterday', 'week', 'month'].includes(req.query.date)
      ? req.query.date : 'all';
    const format = req.query.format === 'json' ? 'json' : 'csv';

    const HIDE_OPS = ['设置外网IP', '服务启动'];
    const allLogs = readLogs(dateFilter).filter(l => !HIDE_OPS.includes(l.operation));
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `logs_${dateFilter}_${dateStr}.${format}`;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.end(JSON.stringify(allLogs, null, 2));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (allLogs.length === 0) return res.end('');

    const fieldSet = new Set();
    allLogs.forEach(log => Object.keys(log).forEach(k => fieldSet.add(k)));
    const fields = ['timestamp', 'internalIp', 'externalIp', 'loginType', 'operation', 'method', 'path', 'status', 'duration', 'userAgent', 'message']
      .filter(f => fieldSet.has(f));

    res.write('\ufeff');

    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    res.write(fields.join(',') + '\r\n');

    let i = 0;
    const writeBatch = () => {
      let batch = '';
      const BATCH_SIZE = 500;
      while (i < allLogs.length && i < offset + BATCH_SIZE) {
        const log = allLogs[i++];
        batch += fields.map(f => csvEscape(log[f])).join(',') + '\r\n';
      }
      if (batch) {
        res.write(batch);
        if (i < allLogs.length) {
          setImmediate(writeBatch);
        } else {
          res.end();
        }
      } else {
        res.end();
      }
    };
    writeBatch();
  });
};
