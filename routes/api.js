/**
 * 文件管理器 - API 路由（文件夹列表、IP相关）
 */

module.exports = function(app, ctx) {
  const pathMod = require('path');
  const fs = require('fs-extra');
  const http = require('http');
  const https = require('https');
  const { isAdmin, UPLOAD_DIR, writeLog, createLogEntry, getLogFile,
          getIpLocation, getClientIp, performance: perfCfg, storage } = ctx;

  let serverSideExternalIp = null;
  let serverSideExternalIpTime = 0;
  const SERVER_IP_CACHE_TTL = 10 * 60 * 1000;

  const fetchExternalIpFromApi = (url) => new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.ip || json.origin || json.query || null);
        } catch { reject(new Error('解析失败')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
  });

  // 文件夹列表（懒加载）
  app.get('/api/folders', (req, res) => {
    const parent = String(req.query.parent || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const userFolder = 'users/' + (req.session?.username || '');
    if (!isAdmin(req)) {
      const guest = !req.session?.userId;
      // 身份可见范围：游客仅 shared/；已登录用户为 internal/ + shared/ + 本人私有目录
      const visibleRoots = guest ? ['shared'] : ['internal', 'shared', userFolder];
      const hasChildrenOf = (rel) => {
        try {
          const full = pathMod.join(UPLOAD_DIR, rel);
          return fs.existsSync(full) && fs.readdirSync(full, { withFileTypes: true }).some(e => e.isDirectory());
        } catch (e) { return false; }
      };
      if (parent === '') {
        return res.json(visibleRoots.map(rel => ({
          name: rel === userFolder ? '我的私有空间' : rel,
          path: rel,
          hasChildren: hasChildrenOf(rel),
        })));
      }
      if (!visibleRoots.some(r => parent === r || parent.startsWith(r + '/'))) {
        return res.status(403).json({
          error: 'Access denied',
          message: guest ? '游客只能访问 shared 目录' : '无权限访问该目录',
        });
      }
    }
    const fullPath = pathMod.join(UPLOAD_DIR, parent);
    const folders = [];
    if (!fs.existsSync(fullPath)) return res.json(folders);
    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      entries.filter(e => e.isDirectory()).forEach(folder => {
        const folderPath = parent ? parent + '/' + folder.name : folder.name;
        const childFullPath = pathMod.join(fullPath, folder.name);
        let hasChildren = false;
        try { hasChildren = fs.readdirSync(childFullPath, { withFileTypes: true }).some(e => e.isDirectory()); } catch (e) {}
        folders.push({ name: folder.name, path: folderPath.replace(/\\/g, '/'), hasChildren });
      });
    } catch (err) { console.error('[文件夹列表] 访问失败: ' + fullPath, err.message); }
    res.json(folders);
  });

  // 客户端IP
  // 存储用量与配额（仅超级管理员）——上传目录 38GB 长期无可见性，这里给出唯一观测入口
  app.get('/api/storage', (req, res) => {
    const isSuper = req.session?.isSuperAdmin === true || req.session?.userRole === 'superadmin';
    if (!isSuper) return res.status(403).json({ success: false, message: '仅超级管理员可查看' });
    if (!storage || typeof storage.getSnapshot !== 'function') {
      return res.json({ success: true, enabled: false, snapshot: null, message: '存储监控未启用' });
    }
    const snap = storage.getSnapshot();
    const cfg = typeof storage.getConfig === 'function' ? storage.getConfig() : {};
    const GB = 1024 * 1024 * 1024;
    const users = snap
      ? Object.keys(snap.users).map(n => ({ name: n, bytes: snap.users[n] })).sort((a, b) => b.bytes - a.bytes)
      : [];
    res.json({
      success: true,
      enabled: true,
      config: {
        privateQuotaGB: cfg.privateQuotaBytes ? +(cfg.privateQuotaBytes / GB).toFixed(4) : 0,
        totalWarnGB: cfg.totalWarnBytes ? +(cfg.totalWarnBytes / GB).toFixed(4) : 0,
        totalLimitGB: cfg.totalLimitBytes ? +(cfg.totalLimitBytes / GB).toFixed(4) : 0,
        scanIntervalMs: cfg.scanInterval || 0,
      },
      snapshot: snap ? {
        totalBytes: snap.total,
        totalGB: +(snap.total / GB).toFixed(2),
        files: snap.files,
        zones: snap.zones,
        users,
        scannedAt: new Date(snap.scannedAt).toISOString(),
      } : null,
    });
  });

  app.get('/api/client-ip', (req, res) => {
    res.json({
      internalIp: getClientIp(req),
      externalIp: req.session.externalIp || 'unknown',
    });
  });

  // 服务端代理获取外网IP
  app.get('/api/server-external-ip', async (req, res) => {
    const now = Date.now();
    // 缓存有效期内直接返回（包括成功和失败结果）
    if (now - serverSideExternalIpTime < SERVER_IP_CACHE_TTL) {
      return res.json({ 
        externalIp: serverSideExternalIp, 
        cached: true,
        error: serverSideExternalIp ? null : '之前获取失败，等待缓存过期重试'
      });
    }
    const apis = [
      'https://api.ipify.org?format=json',
      'https://api.ip.sb/jsonip',
      'https://httpbin.org/ip',
      'https://ifconfig.me/all.json',
    ];
    for (const api of apis) {
      try {
        const ip = await fetchExternalIpFromApi(api);
        if (ip) {
          serverSideExternalIp = ip;
          serverSideExternalIpTime = now;
          return res.json({ externalIp: ip, cached: false });
        }
      } catch {}
    }
    // 失败也缓存，10分钟内不再重试
    serverSideExternalIp = null;
    serverSideExternalIpTime = now;
    res.json({ externalIp: null, error: '所有API都失败，已缓存失败结果' });
  });

  // IP 地理位置查询代理
  app.get('/api/ip-location/:ip', async (req, res) => {
    const ip = req.params.ip;
    if (!ip || ip === 'unknown' || ip === '-') return res.json({ location: '未知', cached: false });
    if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
      return res.json({ location: '内网IP', cached: false });
    }
    const loc = await getIpLocation(ip, perfCfg);
    if (loc) {
      const text = [loc.country, loc.region, loc.city].filter(Boolean).join(' ').trim();
      return res.json({ location: text || '未知', cached: false });
    }
    res.json({ location: '查询失败', cached: false });
  });

  // 设置外网IP
  app.post('/api/set-external-ip', async (req, res) => {
    const { externalIp } = req.body;
    if (!externalIp) return res.status(400).json({ success: false });
    // 服务端复核格式：前端已有校验，但输入不可信。放行 IPv4 与 unknown，
    // 否则任意字符串会进 geo.js 的 URL 拼接并消耗 30 次/分的 geo 限流。
    const ipStr = String(externalIp);
    const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ipStr) && ipStr.split('.').every(n => Number(n) <= 255);
    if (ipStr !== 'unknown' && !isIpv4) {
      return res.status(400).json({ success: false, message: 'IP 格式不正确' });
    }
    req.session.externalIp = ipStr;
    let location = null;
    if (perfCfg.enableGeoLookup) {
      location = await getIpLocation(externalIp, perfCfg);
      if (location) req.session.externalIpLocation = location;
    }
    writeLog(getLogFile(), createLogEntry(req, {
      loginType: req.session?.isAdmin ? '管理员' : '游客',
      operation: '设置外网IP', path: '-', fileType: '-',
    }));
    res.json({ success: true });
  });
};
