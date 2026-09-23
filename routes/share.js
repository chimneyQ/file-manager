/**
 * 文件管理器 - 分享链接路由
 */
const crypto = require('crypto');

module.exports = function(app, ctx) {
  const pathMod = require('path');
  const fs = require('fs-extra');
  const { isAdmin, hasPermission, UPLOAD_DIR, writeLog, createLogEntry, getLogFile, shareLinks, shareLinkCfg } = ctx;
  const SHARE_LINKS_FILE = require('path').join(__dirname, '..', 'data', 'share-links.json');
  try {
    const persisted = fs.readJsonSync(SHARE_LINKS_FILE);
    const now = Date.now();
    Object.entries(persisted).forEach(([k,v]) => { if (v.expiresAt > now) shareLinks[k] = v; });
  } catch(_) {}
  setInterval(() => {
    try { fs.writeJsonSync(SHARE_LINKS_FILE, shareLinks); } catch(_) {}
  }, 30000);
  process.on('exit', () => { try { fs.writeJsonSync(SHARE_LINKS_FILE, shareLinks); } catch(_) {} });

  // 生成分享链接
  app.post('/api/share', (req, res) => {
    if (!isAdmin(req) && !hasPermission(req, 'share')) return res.status(403).json({ success: false, message: '需要分享权限' });
    const { filePath = req.body.path, expireHours } = req.body || {};
    if (!filePath) return res.status(400).json({ success: false, message: '未指定文件路径' });
    
    const fullPath = pathMod.join(UPLOAD_DIR, filePath);
    if (!(fullPath === UPLOAD_DIR || fullPath.startsWith(UPLOAD_DIR + pathMod.sep)) || !fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, message: '文件不存在' });
    }

    const token = crypto.randomBytes(shareLinkCfg.tokenBytes).toString('hex');
    const expire = expireHours || shareLinkCfg.expireHours;
    const expiresAt = Date.now() + expire * 60 * 60 * 1000;

    shareLinks[token] = {
      filePath,
      fileName: pathMod.basename(fullPath),
      expiresAt,
      createdBy: req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '',
      createdAt: Date.now(),
    };

    const host = req.headers.host || 'localhost';
    const protocol = req.protocol || 'http';
    const shareUrl = `${protocol}://${host}/share/${token}`;

    writeLog(getLogFile(), createLogEntry(req, {
      loginType: '管理员', operation: '生成分享链接',
      path: filePath, fileType: '-',
    }));

    res.json({ success: true, url: shareUrl, expiresAt: new Date(expiresAt).toISOString() });
  });

  // 访问分享链接
  app.get('/share/:token', (req, res) => {
    const { token } = req.params;
    const link = shareLinks[token];
    
    if (!link) return res.status(404).send('分享链接不存在或已失效');
    if (Date.now() > link.expiresAt) {
      delete shareLinks[token];
      return res.status(410).send('分享链接已过期');
    }

    const fullPath = pathMod.join(UPLOAD_DIR, link.filePath);
    if (!(fullPath === UPLOAD_DIR || fullPath.startsWith(UPLOAD_DIR + pathMod.sep)) || !fs.existsSync(fullPath)) {
      return res.status(404).send('文件已被删除');
    }

    writeLog(getLogFile(), createLogEntry(req, {
      loginType: '游客', operation: '访问分享链接',
      path: link.filePath, fileType: '-',
    }));

    if (fs.statSync(fullPath).isDirectory()) {
      return res.status(400).send('暂不支持分享文件夹');
    }

    res.download(fullPath, link.fileName);
  });
};
