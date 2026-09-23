/**
 * 文件管理器配置文件
 * 所有敏感配置统一管理，支持环境变量覆盖
 */

// 读取环境变量中的非负数（支持显式 0 与小数，如 0.5；非法值回退默认）
const envNum = (name, dflt) => {
  const n = parseFloat(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

module.exports = {
  // ========== 服务器基础配置 ==========
  server: {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'production',
  },

  // ========== 目录配置 ==========
  dirs: {
    upload: process.env.UPLOAD_DIR || 'D:\\Web\\uploads',
    logs: process.env.LOG_DIR || 'D:\\Web\\logs',
  },

  // ========== 管理员账号 ==========
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    // 密码哈希 - 来源优先级（自上向下）：
    //   1) runtime-config.json（前端“修改密码”功能写入，重启后保留）
    //   2) process.env.ADMIN_PASSWORD_HASH（由 .env 加载）
    //   3) ''  —— 无默认值，启动时如果三者都没有则拒绝登录
    // 手动修改 .env 的方法：
    //   node -e "console.log(require('bcryptjs').hashSync('你的密码', 10))"
    // 然后把输出填入 .env 的 ADMIN_PASSWORD_HASH= 后面
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
  },

  // ========== Session 安全配置 ==========
  session: {
    secret: process.env.SESSION_SECRET || '',
    maxAge: 30 * 60 * 1000,             // 30分钟（配合rolling实现无操作超时）
    cookieSecure: false, // 强制关闭，HTTP 环境需要设为 false,
    cookieHttpOnly: true,
    cookieSameSite: 'lax',               // lax 兼顾安全与体验
  },

  // ========== 安全策略 ==========
  security: {
    // 登录失败锁定
    loginMaxAttempts: 5,                 // 最多失败次数
    loginLockoutMinutes: 30,             // 锁定时间（分钟）
    
    // IP 白名单（空 = 允许所有）
    // 示例: ['127.0.0.1', '192.168.1.100']
    allowedAdminIPs: (process.env.ALLOWED_ADMIN_IPS || '').split(',').filter(Boolean),
    
    // 上传文件大小限制 (字节)
    maxFileSize: 500 * 1024 * 1024,      // 500MB
    
    // 允许的文件类型 (空 = 允许所有)
    // 示例: ['.jpg', '.png', '.pdf', '.doc', '.docx']
    allowedFileTypes: [],
    
    // 是否允许覆盖已有文件
    allowOverwrite: false,
  },

  // ========== 日志配置 ==========
  logs: {
    // 日志保留策略
    maxFileSize: 10 * 1024 * 1024,       // 单文件最大 10MB
    maxFiles: 30,                         // 保留文件数量
    maxAge: 30 * 24 * 60 * 60 * 1000,   // 最多保留 30 天

    // 日志页面显示配置
    display: {
      defaultPageSize: 1000,              // 默认每页显示条数
      maxPageSize: 5000,                  // 单次最大加载条数（防止卡顿）
      loadMoreSize: 200,                  // "加载更多"每次增加的条数
    },
  },

  // ========== 性能配置 ==========
  performance: {
    // 文件夹列表分页
    folderPageSize: 100,
    
    // IP 地理位置缓存时间（毫秒）
    geoCacheTime: 10 * 60 * 1000,        // 10分钟
    
    // IP 地理位置 API 请求限制（每分钟）
    geoApiRateLimit: 30,                  // 每分钟最多 30 次（ip-api.com 免费版 45次/分，留余量）
    geoTimeoutMs: 3000,                   // 单个地理查询源超时（毫秒）；主源失败自动切备用源
    geoFailCacheTime: 5 * 60 * 1000,      // 查询失败结果的短缓存（毫秒），避免每条日志重查；0 = 关闭
    
    // 是否启用 IP 地理位置查询
    enableGeoLookup: true,

    // 是否启用服务器外网IP自动检测（关闭后外网IP显示 unknown，减少网络请求）
    enableExternalIpCheck: true,
    
    // 搜索最大深度（0=不限制）
    searchMaxDepth: 5,
    
    // 搜索最大结果数
    searchMaxResults: 100,
    
    // 文件夹树懒加载（按需加载子目录）
    lazyLoadFolders: true,
  },

  // ========== 功能开关 ==========
  features: {
    // 是否允许游客查看所有文件（危险！仅内网使用）
    publicBrowseAll: false,
    
    // 是否允许游客创建文件夹
    publicCreateFolder: true,
    
    // 启用文件搜索
    enableSearch: true,
    
    // 启用批量删除
    enableBatchDelete: true,
    
    // 启用批量下载（ZIP）
    enableBatchDownload: false,           // 大文件服务器压力大，默认关闭
    
    // 启用深色模式
    enableDarkMode: true,
    
    // 启用回收站
    enableRecycleBin: true,
    
    // 启用分享链接
    enableShareLink: true,
  },

  // ========== 回收站配置 ==========
  recycleBin: {
    // 回收站目录
    dir: process.env.RECYCLE_DIR || 'D:\\\\Web\\\\.trash',
    // 文件保留天数
    daysToKeep: 7,
    // 定时清理间隔（毫秒）
    cleanInterval: 24 * 60 * 60 * 1000,   // 每天检查一次
  },

  // ========== 分享链接配置 ==========
  shareLink: {
    // 链接有效期（小时）
    expireHours: 24,
    // Token 长度（字节）
    tokenBytes: 16,
  },

  // ========== 存储配额与用量监控 ==========
  // 现状（2026-09-23 实测）：uploads 共 38.72GB，其中 shared=4.29GB、internal=34.43GB，
  // 所有用户私有目录均为 0 字节 —— 因此私有配额默认值对现有用户零影响。
  storage: {
    // 单个用户私有目录（uploads/users/<用户名>）配额，单位 GB；0 = 不限制。超管不受限。
    privateQuotaGB: envNum('UPLOAD_PRIVATE_QUOTA_GB', 5),
    // 整站上传目录用量告警阈值（只写日志告警，不拦截）；0 = 关闭
    totalWarnGB: envNum('UPLOAD_TOTAL_WARN_GB', 45),
    // 整站上传目录硬上限（超过后拒绝非超管上传）；0 = 不限制
    totalLimitGB: envNum('UPLOAD_TOTAL_LIMIT_GB', 0),
    // 用量扫描间隔（毫秒），默认 6 小时；0 = 不周期扫描
    scanInterval: envNum('UPLOAD_SCAN_INTERVAL_MS', 6 * 60 * 60 * 1000),
  },

  // ========== 上传配置 ==========
  upload: {
    // 最大并发上传数
    concurrentMax: 3,
  },
};
