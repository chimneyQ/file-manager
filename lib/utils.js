/**
 * 文件管理器 - 工具函数模块
 * 纯函数，无外部状态依赖
 */

const path = require('path');

// ============================================================================
// 文件名清洗 - 防止路径穿越和非法字符
// ============================================================================
const sanitizeFileName = (fileName) => {
  // 兜底：multer 1.x 中文文件名乱码修复
  if (typeof fileName === 'string' && /[\u0080-\u00ff]/.test(fileName)) {
    try {
      const bytes = Buffer.from(fileName, 'latin1');
      const fixed = bytes.toString('utf8');
      if (Buffer.from(fixed, 'utf8').equals(bytes) && !/[\u0080-\u00ff]/.test(fixed)) {
        fileName = fixed;
      }
    } catch (e) {}
  }

  // 移除所有路径分隔符，防止 ../
  let name = fileName.replace(/[\/\\]/g, '');
  // 移除或替换 Windows 非法字符
  name = name.replace(/[<>:"'|?*\x00-\x1f]/g, '_');
  // 移除开头和结尾的点/空格
  name = name.replace(/^[\s.]+|[\s.]+$/g, '');
  // 限制长度（MAX_PATH 防护）
  if (name.length > 200) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    name = base.substring(0, 200 - ext.length) + ext;
  }
  // 防止空文件名
  if (!name || name === '') {
    name = `file_${Date.now()}`;
  }
  return name;
};

// ============================================================================
// 格式化函数
// ============================================================================
const formatSize = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDate = (date) => {
  return new Date(date).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
};

const formatDateTime = (date) => {
  return new Date(date).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(/\//g, '-');
};

// ============================================================================
// 文件图标映射
// ============================================================================
const getFileIcon = (ext) => {
  const iconMap = {
    '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc',
    '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt',
    '.txt': 'txt', '.md': 'txt',
    '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image',
    '.bmp': 'image', '.svg': 'image', '.webp': 'image',
    '.mp4': 'video', '.avi': 'video', '.mkv': 'video', '.mov': 'video', '.wmv': 'video',
    '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio', '.aac': 'audio', '.ogg': 'audio',
    '.zip': 'archive', '.rar': 'archive', '.7z': 'archive', '.tar': 'archive', '.gz': 'archive',
    '.js': 'code', '.html': 'code', '.css': 'code', '.py': 'code', '.java': 'code',
    '.cpp': 'code', '.c': 'code', '.php': 'code', '.go': 'code',
    '.exe': 'app', '.msi': 'app', '.dmg': 'app',
  };
  return iconMap[ext] || 'file';
};

// ============================================================================
// 路径乱码修复
// ============================================================================
const fixGarbledPath = (p) => {
  if (!p || typeof p !== 'string') return p;
  if (/[À-ÿ][\x80-\xbf]/.test(p)) {
    try {
      const fixed = Buffer.from(p, 'latin1').toString('utf8');
      if (!/[À-ÿ][\x80-\xbf]/.test(fixed)) return fixed;
    } catch (e) {}
  }
  return p;
};

// ============================================================================
// IP 相关
// ============================================================================
const getClientIp = (req) => {
  const directIp = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
  if (directIp === '::1' || directIp === '::ffff:127.0.0.1') return '127.0.0.1';
  const cleanIp = directIp.replace(/^::ffff:/, '');
  
  if (cleanIp.startsWith('10.') || cleanIp.startsWith('192.168.') || 
      cleanIp.startsWith('172.') || cleanIp === '127.0.0.1') {
    return cleanIp;
  }
  
  // 默认不采信客户端自带的 X-Forwarded-For / X-Real-IP：
  // 无反代直连时这两个头完全由客户端控制，会让「登录 5 次/30 分钟锁定」按伪造 IP 分桶失效
  // （可无限爆破），并让日志里的来源 IP 可被任意伪造、追溯失真。
  // 注意反代场景本来就走不到这里——socket 为内网 IP 时上面已直接返回，不会读 XFF。
  // 如确需前置反代，显式设 TRUST_PROXY=1 再启用。
  const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = forwarded.split(',').map(ip => ip.trim());
      for (const ip of ips) {
        if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) {
          return ip;
        }
      }
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp && (realIp.startsWith('10.') || realIp.startsWith('192.168.') || realIp.startsWith('172.'))) {
      return realIp;
    }
  }

  return cleanIp;
};

const getClientExternalIp = (req) => {
  if (req.session?.externalIp) return req.session.externalIp;
  const headerIp = req.headers['x-client-external-ip'];
  if (headerIp) return headerIp;
  return 'unknown';
};

// ============================================================================
// 路径归一化 - 按身份把「相对 uploads 的路径」收敛到允许区域（上传/新建文件夹/下载共用）
//   · 超管：原样（仅清理反斜杠与首部斜杠）
//   · 已登录普通用户：users 虚拟根 → 本人私有目录；他人私有目录 → 本人私有目录；其它未知路径 → shared
//   · 游客：只允许 shared，其余一律落到 shared
// 返回归一化后的相对路径（POSIX 分隔符，无首部斜杠）
// ============================================================================
const normalizePathBySession = (req, isSuper, rawPath) => {
  let p = (rawPath === undefined || rawPath === null)
    ? String((req && ((req.body && req.body.path) || (req.query && req.query.path))) || '')
    : String(rawPath);
  p = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (isSuper) return p;
  const userFolder = 'users/' + ((req && req.session && req.session.username) || '');
  if (req && req.session && req.session.userId) {
    if (p === 'users' || p === 'users/') p = userFolder;
    else if (p.startsWith('users/') && p !== userFolder && !p.startsWith(userFolder + '/')) p = userFolder;
    else if (!p || (!p.startsWith('internal') && !p.startsWith('shared') && !p.startsWith('users'))) p = 'shared';
  } else {
    if (!p || !p.startsWith('shared')) p = 'shared';
  }
  return p;
};

module.exports = {
  sanitizeFileName,
  formatSize,
  formatDate,
  formatDateTime,
  getFileIcon,
  fixGarbledPath,
  getClientIp,
  getClientExternalIp,
  normalizePathBySession,
};
