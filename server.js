/**
 * 文件管理器 v2.0 - 重构版
 * 
 * 模块化拆分：
 * - lib/utils.js      工具函数（文件名清洗、格式化、IP）
 * - lib/logger.js     日志系统（写入队列、读取、清理）
 * - lib/geo.js        IP 地理位置查询
 * - lib/security.js   登录限流
 * - lib/ip-check.js   外网 IP 自动检测
 * - routes/auth.js    认证路由
 * - routes/files.js   文件操作路由
 * - routes/recycle.js 回收站路由
 * - routes/share.js   分享链接路由
 * - routes/api.js     API 路由
 * - routes/logs.js    日志路由
 */

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs-extra');

// 加载配置
const cfg = require('./config');

// 会话密钥为必填项：缺失时拒绝启动，避免用空/默认密钥签发 session cookie
if (!cfg.session.secret) {
  console.error('[FATAL] 缺少 SESSION_SECRET：请在 .env 中设置一个随机密钥后重启');
  process.exit(1);
}

// 生产环境抑制 console 输出
if (cfg.server.env === 'production') {
  console.log = () => {};
  console.warn = () => {};
}

// ============================================================================
// 运行时配置（允许通过 UI 动态修改，重启后保留）
// ============================================================================
const RUNTIME_CONFIG_PATH = path.join(__dirname, 'runtime-config.json');
const RUNTIME_CONFIG_BACKUP = RUNTIME_CONFIG_PATH + '.bak';

const loadRuntimeConfig = () => {
  try {
    if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('加载 runtime-config.json 失败:', err.message);
    try {
      if (fs.existsSync(RUNTIME_CONFIG_BACKUP)) {
        console.warn('正在从备份恢复...');
        const data = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_BACKUP, 'utf8'));
        fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(data, null, 2));
        return data;
      }
    } catch (e) { console.error('备份恢复失败:', e.message); }
  }
  return {};
};

const saveRuntimeConfig = (data) => {
  try {
    if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
      fs.copyFileSync(RUNTIME_CONFIG_PATH, RUNTIME_CONFIG_BACKUP);
    }
    fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) { console.error('保存 runtime-config.json 失败:', err.message); return false; }
};

const runtimeConfig = loadRuntimeConfig();
if (runtimeConfig.admin && runtimeConfig.admin.passwordHash) {
  cfg.admin.passwordHash = runtimeConfig.admin.passwordHash;
}

// ============================================================================
// 初始化
// ============================================================================
const app = express();
const PORT = cfg.server.port;
const UPLOAD_DIR = cfg.dirs.upload;
const LOG_DIR = cfg.dirs.logs;
const RECYCLE_DIR = cfg.recycleBin.dir;

fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(LOG_DIR);
fs.ensureDirSync(RECYCLE_DIR);

const {
  admin,
  session: sessionCfg,
  security,
  logs: logsCfg,
  performance: perfCfg,
  features,
  recycleBin: recycleBinCfg,
  storage: storageCfg,
  shareLink: shareLinkCfg,
} = cfg;

// 全局分享链接存储
const shareLinks = {};

// ============================================================================
// 工具模块
// ============================================================================
const { sanitizeFileName, formatSize, formatDate, formatDateTime, getFileIcon,
        fixGarbledPath, getClientIp, getClientExternalIp, normalizePathBySession } = require('./lib/utils');
const { createStorageMonitor } = require('./lib/storage');
const { initLogger, writeLog, createLogEntry, getLogFile, getErrorLogFile,
        rotateLogs, readLogs, getDownloadCounts } = require('./lib/logger');
const { getIpLocation } = require('./lib/geo');
const { createLoginLimiter } = require('./lib/security');
const { createExternalIpChecker, getServerExternalIp: getExtIp } = require('./lib/ip-check');
const users = require('./lib/users');

// 权限检查（兼容旧session + 新用户系统）
// isAdmin = 超级管理员（拥有全部权限）
const isAdmin = (req) => req.session?.isAdmin === true || req.session?.userRole === 'superadmin';
// isUser = 已审核通过的普通用户
const isUser = (req) => req.session?.userRole === 'admin' && req.session?.userStatus === 'approved';
const hasPermission = (req, perm) => {
  if (req.session?.isSuperAdmin) return true;
  // 5 秒 TTL 缓存，避免每次请求都读磁盘
  const now = Date.now();
  const userId = req.session?.userId;
  if (userId && hasPermission._cache && hasPermission._cache.has(userId)) {
    const cached = hasPermission._cache.get(userId);
    if (now - cached.ts < 5000) return cached.perms.includes(perm);
  }
  try {
    const { ensureLoaded, getFullPermissions } = require('./lib/users');
    const allUsers = ensureLoaded();
    const user = allUsers.find(u => u.id === userId);
    if (user && user.status === 'approved') {
      const latestPerms = getFullPermissions(user);
      req.session.userPermissions = latestPerms;
      if (!hasPermission._cache) hasPermission._cache = new Map();
      hasPermission._cache.set(userId, { perms: latestPerms, ts: now });
      return latestPerms.includes(perm);
    }
  } catch(e) {}
  const perms = req.session?.userPermissions || [];
  return perms.includes(perm);
};

// 初始化日志模块
initLogger(LOG_DIR, logsCfg, () => serverExternalIp, isAdmin);

// 初始化登录限流
const { checkLoginAttempt, recordLoginAttempt } = createLoginLimiter(security);

// 初始化外网IP检测
const ipChecker = createExternalIpChecker(perfCfg, writeLog, createLogEntry, getErrorLogFile);
let serverExternalIp = 'unknown';

// 外网IP getter（供日志模块使用）
const getServerExternalIp = () => serverExternalIp;

// ============================================================================
// 回收站定时清理
// ============================================================================
const cleanRecycleBin = () => {
  try {
    const maxAge = Date.now() - recycleBinCfg.daysToKeep * 24 * 60 * 60 * 1000;
    const cleanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (entry.isDirectory()) {
            cleanDir(fullPath);
            // 空目录删除
            if (fs.readdirSync(fullPath).length === 0) {
              fs.rmdirSync(fullPath);
            }
          } else if (stat.mtimeMs < maxAge) {
            fs.removeSync(fullPath);
          }
        } catch {}
      }
    };
    cleanDir(RECYCLE_DIR);
  } catch (err) {
    console.error('[回收站清理] 失败:', err.message);
  }
};
cleanRecycleBin();
setInterval(cleanRecycleBin, recycleBinCfg.cleanInterval);

// ============================================================================
// 存储用量监控（异步扫描，不阻塞；上传前置守卫按快照做配额判定）
// ============================================================================
const storageMonitor = createStorageMonitor({
  uploadDir: UPLOAD_DIR,
  privateQuotaBytes: (storageCfg.privateQuotaGB || 0) * 1024 * 1024 * 1024,
  totalWarnBytes: (storageCfg.totalWarnGB || 0) * 1024 * 1024 * 1024,
  totalLimitBytes: (storageCfg.totalLimitGB || 0) * 1024 * 1024 * 1024,
  scanInterval: storageCfg.scanInterval,
  writeLog, getErrorLogFile, createLogEntry,
});
storageMonitor.start();

// ============================================================================
// 权限检查
// ============================================================================
// ============================================================================
// 文件系统工具
// ============================================================================
const getDirectoryContents = (dirPath, relativePath = '') => {
  const items = [];
  const fullPath = path.join(dirPath, relativePath);
  if (!fs.existsSync(fullPath)) return items;

  const entries = fs.readdirSync(fullPath, { withFileTypes: true });
  const folders = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

  folders.forEach(folder => {
    const stats = fs.statSync(path.join(fullPath, folder.name));
    items.push({
      name: folder.name, type: 'folder',
      path: path.join(relativePath, folder.name).replace(/\\/g, '/'),
      modified: stats.mtime,
    });
  });

  files.forEach(file => {
    const stats = fs.statSync(path.join(fullPath, file.name));
    items.push({
      name: file.name, type: 'file',
      path: path.join(relativePath, file.name).replace(/\\/g, '/'),
      size: stats.size, modified: stats.mtime,
      ext: path.extname(file.name).toLowerCase(),
    });
  });

  return items;
};

const searchFiles = (dirPath, keyword, results = [], depth = 0) => {
  if (perfCfg.searchMaxDepth > 0 && depth >= perfCfg.searchMaxDepth) return results;
  if (results.length >= perfCfg.searchMaxResults) return results;
  if (!fs.existsSync(dirPath)) return results;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= perfCfg.searchMaxResults) break;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.name.toLowerCase().includes(keyword.toLowerCase())) {
        const stats = fs.statSync(fullPath);
        results.push({
          name: entry.name,
          type: entry.isDirectory() ? 'folder' : 'file',
          path: fullPath.replace(UPLOAD_DIR + '\\', '').replace(UPLOAD_DIR + '/', '').replace(/\\/g, '/'),
          size: entry.isFile() ? stats.size : 0,
          modified: stats.mtime,
          ext: entry.isFile() ? path.extname(entry.name).toLowerCase() : '',
        });
      }
      if (entry.isDirectory()) searchFiles(fullPath, keyword, results, depth + 1);
    }
  } catch (err) { console.error('[搜索] 访问失败:', dirPath, err.message); }
  return results;
};

// ============================================================================
// 中间件
// ============================================================================
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'", "https:", "http:"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
}));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { success: false, message: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true, lastModified: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(session({
  secret: sessionCfg.secret,
  name: 'fm_sid',
  rolling: true,  // 每次请求重置计时器，实现30分钟无操作超时
  resave: false,
  saveUninitialized: false,
  store: new FileStore({
    path: path.join(LOG_DIR, 'sessions'),
    logFn: cfg.server.env === 'production' ? () => {} : console.log,
    retries: 1,
    factor: 0.001,
    reapInterval: 3600,
    maxAge: sessionCfg.maxAge,
  }),
  cookie: {
    secure: sessionCfg.cookieSecure,
    httpOnly: sessionCfg.cookieHttpOnly,
    sameSite: sessionCfg.cookieSameSite,
    maxAge: sessionCfg.maxAge,
  },
}));

// 访问日志中间件
const SKIP_LOG_PREFIXES = ['/css/', '/js/', '/images/', '/fonts/', '/webfonts/', '/favicon.ico'];
app.use((req, res, next) => {
  if (SKIP_LOG_PREFIXES.some(p => req.path.startsWith(p))) return next();
  const isApiRequest = req.path.startsWith('/api/');
  const startTime = Date.now();
  res.on('finish', () => {
    // 接口类请求只在出错（4xx/5xx）时记录：正常接口请求占日志量约 85%，前端也不再展示
    if (isApiRequest && res.statusCode < 400) return;
    const duration = Date.now() - startTime;
    writeLog(getLogFile(), createLogEntry(req, {
      method: req.method, path: req.path,
      query: JSON.stringify(req.query), status: res.statusCode,
      duration: duration + 'ms',
      userAgent: req.headers['user-agent'] || 'unknown',
    }));
  });
  next();
});

// ============================================================================
// 会话吊销中间件：每次请求按 users.json 复核账号状态
// 账号被删除 / 审核被拒 / 非 approved 时，其已登录会话立即失效，不再等到 30 分钟超时。
// （原实现 hasPermission 在非 approved 时会回落 session 快照，撤权/删号后旧会话仍可用。）
// 放在访问日志中间件之后，保证吊销请求也会被记一条访问日志。
// ============================================================================
app.use((req, res, next) => {
  const userId = req.session && req.session.userId;
  if (!userId) return next(); // 游客 / 无会话
  let dbUser = null;
  try { dbUser = users.findById(userId); } catch (e) { dbUser = null; }
  if (!dbUser || dbUser.status !== 'approved') {
    writeLog(getLogFile(), createLogEntry(req, {
      loginType: '系统', operation: '会话吊销', path: req.path, fileType: '-',
      message: '账号 ' + (req.session.username || userId) + ' 已删除或非 approved，会话立即失效',
    }));
    req.session.destroy(() => {
      const wantsJson = req.path.startsWith('/api/') || req.path === '/upload' || req.path === '/mkdir'
        || req.path === '/delete' || (req.headers.accept || '').includes('application/json');
      if (wantsJson) return res.status(403).json({ success: false, message: '登录已失效，请重新登录' });
      res.redirect('/login');
    });
    return;
  }
  next();
});

// IP 白名单检查中间件
const ipWhitelistMiddleware = (req, res, next) => {
  if (security.allowedAdminIPs.length === 0) return next();
  const clientIp = getClientIp(req);
  if (security.allowedAdminIPs.includes(clientIp)) return next();
  if (clientIp.startsWith('192.168.') || clientIp.startsWith('10.') || clientIp.startsWith('172.')) return next();
  console.warn('[安全] IP 不在白名单，拒绝:', clientIp);
  return res.status(403).json({ success: false, message: 'IP不在允许列表中' });
};

// 模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ============================================================================
// Multer 配置
// ============================================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 身份 ACL：multer 直接用 query/body 里的 path 落盘，处理器层的归一化只影响日志、太晚，
    // 这里按身份先收敛（游客仅 shared；登录用户 internal/shared/本人私有；他人私有 → 本人私有），再落盘。
    const relativePath = normalizePathBySession(req, isAdmin(req), req.query.path || req.body.path || '');
    req._normalizedUploadPath = relativePath;
    const fullPath = path.join(UPLOAD_DIR, relativePath);
    // 越界保护：必须严格落在 uploads 内。原实现直接 ensureDir，可用 ../ 在路由归一化之前写到任意位置。
    if (!(fullPath === UPLOAD_DIR || fullPath.startsWith(UPLOAD_DIR + path.sep))) {
      return cb(new Error('非法上传路径'));
    }
    fs.ensureDirSync(fullPath);
    cb(null, fullPath);
  },
  filename: (req, file, cb) => {
    const safeName = sanitizeFileName(file.originalname);
    const ext = path.extname(safeName);
    const baseName = path.basename(safeName, ext);
    const relativePath = req._normalizedUploadPath || normalizePathBySession(req, isAdmin(req), req.body.path || '');
    const fullPath = path.join(UPLOAD_DIR, relativePath);
    if (cfg.security.allowOverwrite) { cb(null, safeName); return; }
    let finalName = safeName;
    let counter = 1;
    while (fs.existsSync(path.join(fullPath, finalName))) {
      finalName = `${baseName} (${counter})${ext}`;
      counter++;
    }
    cb(null, finalName);
  },
});

const fileFilter = (req, file, cb) => {
  if (cfg.security.allowedFileTypes.length === 0) return cb(null, true);
  const ext = path.extname(file.originalname).toLowerCase();
  if (cfg.security.allowedFileTypes.includes(ext)) cb(null, true);
  else cb(new Error(`不允许的文件类型: ${ext}`), false);
};

const upload = multer({
  storage, fileFilter,
  defParamCharset: 'utf8',
  limits: { fileSize: cfg.security.maxFileSize },
});

// ============================================================================
// 注册路由模块
// ============================================================================
// 构建上下文对象
const ctx = {
  isAdmin, isUser, hasPermission, users, UPLOAD_DIR, LOG_DIR, RECYCLE_DIR,
  writeLog, createLogEntry, getLogFile, getErrorLogFile,
  readLogs, getDownloadCounts, rotateLogs,
  sanitizeFileName, formatSize, formatDate, formatDateTime, getFileIcon,
  fixGarbledPath, getClientIp, getClientExternalIp,
  getIpLocation,
  checkLoginAttempt, recordLoginAttempt,
  admin, features, security, performance: perfCfg,
  logsCfg, shareLinkCfg, shareLinks,
  upload, searchFiles, getDirectoryContents,
  storage: storageMonitor,
  saveRuntimeConfig, RUNTIME_CONFIG_PATH,
  serverExternalIp,
};

// 路由
require('./routes/files')(app, ctx);
require('./routes/auth')(app, ctx);
require('./routes/recycle')(app, ctx);
require('./routes/share')(app, ctx);
require('./routes/api')(app, ctx);
require('./routes/logs')(app, ctx);

// 用户管理页面路由
app.get('/admin/users', (req, res) => {
  if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.redirect('/login');
  res.render('admin-users', { darkMode: req.session?.darkMode || false });
});

// ============================================================================
// 启动时清理日志
// ============================================================================
rotateLogs();
setInterval(rotateLogs, 60 * 60 * 1000);

// 启动外网IP检测
if (perfCfg.enableExternalIpCheck) {
  ipChecker.updateServerExternalIp().finally(ipChecker.scheduleNextExternalIpCheck);
}

// ============================================================================
// 错误处理
// ============================================================================
app.use((err, req, res, next) => {
  if (err.message?.includes('不允许的文件类型') || err.message?.includes('非法上传路径')) {
    return res.status(400).json({ success: false, message: err.message });
  }
  writeLog(getErrorLogFile(), createLogEntry(req, {
    loginType: req.session?.isSuperAdmin ? '超级管理员' : req.session?.isAdmin ? '管理员' : '游客',
    operation: '错误', path: req.path,
    message: err.message, stack: err.stack,
  }));
  console.error('[服务器错误]', err);
  res.status(500).send('服务器内部错误');
});

// ============================================================================
// 启动
// ============================================================================
app.listen(PORT, () => {
  if (cfg.server.env !== 'production') {
    console.log(`\n========================================`);
    console.log(`  文件管理器 v2.0 (模块化版)`);
    console.log(`========================================`);
    console.log(`  端口:     http://localhost:${PORT}`);
    console.log(`  上传目录: ${UPLOAD_DIR}`);
    console.log(`  日志目录: ${LOG_DIR}`);
    console.log(`  管理员:   ${admin.username}`);
    console.log(`  环境:     ${cfg.server.env}`);
    console.log(`========================================\n`);
  }

  writeLog(getLogFile(), createLogEntry({ session: {}, headers: {}, ip: '-' }, {
    loginType: '-', operation: '服务启动',
    path: '-', fileType: '-',
    message: `文件管理器 v2.0 运行在 http://localhost:${PORT}`,
  }));
});

