/**
 * 文件管理器 - 回收站路由
 */

module.exports = function(app, ctx) {
  const pathMod = require('path');
  const fs = require('fs-extra');
  const { isAdmin, hasPermission, RECYCLE_DIR, UPLOAD_DIR, writeLog, createLogEntry, getLogFile } = ctx;

  // 回收站 - 列表
  app.get('/api/recycle-bin/list', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'recycle')) return res.status(403).json({ success: false, message: '需要回收站权限' });
    try {
      const items = [];
      const readDir = (dir, relativePath = '') => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const itemRelPath = relativePath ? relativePath + '/' + entry.name : entry.name;
          const fullPath = pathMod.join(dir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            if (entry.isDirectory()) {
              readDir(fullPath, itemRelPath);
            } else {
              items.push({
                name: entry.name,
                path: itemRelPath,
                size: stat.size,
                modified: stat.mtime,
                originalPath: entry.name.replace(/_\d{13}$/, '').replace(/_/g, ':'),
              });
            }
          } catch {}
        }
      };
      readDir(RECYCLE_DIR);
      items.sort((a, b) => new Date(b.modified) - new Date(a.modified));
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 回收站 - 恢复
  app.post('/api/recycle-bin/restore', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'recycle')) return res.status(403).json({ success: false, message: '需要回收站权限' });
    const { path: recycleItemPath } = req.body;
    if (!recycleItemPath) return res.status(400).json({ success: false, message: '未指定恢复路径' });
    try {
      const sourcePath = pathMod.resolve(RECYCLE_DIR, recycleItemPath);
      const origRel = String(recycleItemPath).replace(/\\/g, '/').replace(/_\d{13}$/, '');
      const destPath = pathMod.resolve(UPLOAD_DIR, origRel);
      // 源与目标都必须严格位于各自根目录内，否则 ../ 可越界搬移任意文件
      if (!sourcePath.startsWith(RECYCLE_DIR + pathMod.sep) || !destPath.startsWith(UPLOAD_DIR + pathMod.sep)) {
        return res.status(400).json({ success: false, message: '非法路径' });
      }
      fs.ensureDirSync(pathMod.dirname(destPath));
      if (fs.existsSync(destPath)) {
        return res.status(400).json({ success: false, message: '目标位置已存在同名文件' });
      }
      fs.moveSync(sourcePath, destPath);
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: '管理员', operation: '恢复文件',
        path: recycleItemPath, fileType: 'file',
      }));
      res.json({ success: true, message: '恢复成功' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 回收站 - 清空
  app.post('/api/recycle-bin/empty', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'recycle')) return res.status(403).json({ success: false, message: '需要回收站权限' });
    try {
      fs.emptyDirSync(RECYCLE_DIR);
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: '管理员', operation: '清空回收站',
        path: '-', fileType: '-',
      }));
      res.json({ success: true, message: '回收站已清空' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
};
