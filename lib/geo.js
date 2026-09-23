/**
 * 文件管理器 - IP 地理位置查询模块
 * 带缓存 + 频率限制 + 显式超时 + 备用数据源
 *
 * 修复背景（2026-09-22 错误日志）：原实现对 http.get 未设置超时，
 * ip-api.com 不可达时请求挂在 TCP 层直到系统超时（实测 connect ETIMEDOUT，日志持续刷
 * [IP查询] 失败）。现在每次请求 3s 超时并主动 destroy，主源失败后自动切换备用源。
 */

const http = require('http');
const https = require('https');

const GEO_TIMEOUT_MS = 3000;
const GEO_MAX_BYTES = 64 * 1024;

const geoCache = new Map();
// 失败短缓存：查询失败（含超时/无结果）的 IP 在 TTL 内直接返回 null，
// 避免公网 IP 的每条访问日志都触发一次多源查询（每次最长 6s + 消耗限流配额）
const geoFailCache = new Map();
let geoRequestCount = 0;
let geoResetTime = Date.now() + 60000;

const fetchJson = (url, timeoutMs) => new Promise((resolve, reject) => {
  const mod = url.startsWith('https:') ? https : http;
  let settled = false;
  const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
  const req = mod.get(url, (res) => {
    let raw = '';
    res.on('data', (c) => {
      raw += c;
      if (raw.length > GEO_MAX_BYTES) req.destroy(new Error('响应超长'));
    });
    res.on('end', () => { try { done(resolve, JSON.parse(raw)); } catch { done(reject, new Error('JSON解析失败')); } });
    res.on('aborted', () => done(reject, new Error('连接被中断')));
  });
  req.on('error', (err) => done(reject, err));
  req.setTimeout(timeoutMs, () => req.destroy(new Error('查询超时 ' + timeoutMs + 'ms')));
});

// 主源 + 备用源（任一命中即返回）
const providers = [
  {
    name: 'ip-api',
    url: (ip) => 'http://ip-api.com/json/' + ip + '?fields=status,message,country,regionName,city,zip,timezone,isp,org,query&lang=zh-CN',
    map: (d) => (d && d.status === 'success' ? {
      country: d.country || '', region: d.regionName || '', city: d.city || '',
      zip: d.zip || '', timezone: d.timezone || '', isp: d.isp || '',
      org: d.org || '', query: d.query || '',
    } : null),
  },
  {
    name: 'ipapi.co',
    url: (ip) => 'https://ipapi.co/' + ip + '/json/',
    map: (d) => (d && !d.error && (d.country_name || d.city || d.ip) ? {
      country: d.country_name || '', region: d.region || '', city: d.city || '',
      zip: d.postal || '', timezone: d.timezone || '', isp: d.org || '',
      org: d.org || '', query: d.ip || '',
    } : null),
  },
];

const getIpLocation = async (ip, performanceCfg) => {
  const cfg = performanceCfg || {};
  if (!cfg.enableGeoLookup) return null;

  if (!ip || ip === 'unknown' || ip === '-' ||
      ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return null;
  }

  if (geoCache.has(ip)) {
    const cached = geoCache.get(ip);
    if (Date.now() - cached.timestamp < cfg.geoCacheTime) {
      return cached.location;
    }
    geoCache.delete(ip);
  }

  const failTtl = cfg.geoFailCacheTime === undefined ? 5 * 60 * 1000 : cfg.geoFailCacheTime;
  if (failTtl > 0 && geoFailCache.has(ip) && Date.now() - geoFailCache.get(ip) < failTtl) {
    return null;
  }

  const now = Date.now();
  if (now > geoResetTime) {
    geoRequestCount = 0;
    geoResetTime = now + 60000;
  }
  if (geoRequestCount >= cfg.geoApiRateLimit) {
    console.warn('[IP查询] 频率超限，跳过: ' + ip);
    return null;
  }
  geoRequestCount++;

  const timeoutMs = cfg.geoTimeoutMs || GEO_TIMEOUT_MS;
  const errors = [];
  for (const p of providers) {
    try {
      const data = await fetchJson(p.url(ip), timeoutMs);
      const location = p.map(data);
      if (location) {
        if (!location.query) location.query = ip;
        geoCache.set(ip, { location, timestamp: Date.now() });
        geoFailCache.delete(ip);
        return location;
      }
      errors.push(p.name + ': 无结果');
    } catch (err) {
      errors.push(p.name + ': ' + (err.message || err));
    }
  }
  console.error('[IP查询] 失败 ' + ip + ' -> ' + errors.join(' | '));
  geoFailCache.set(ip, Date.now());
  return null;
};

module.exports = { getIpLocation };
