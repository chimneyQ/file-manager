/**
 * 文件管理器 - 登录限流模块
 * 防暴力破解：IP 级别计数 + 锁定
 */

const loginAttempts = new Map();

const createLoginLimiter = (securityCfg) => {
  const checkLoginAttempt = (ip) => {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    
    if (!record) return { allowed: true, remaining: securityCfg.loginMaxAttempts };
    
    if (record.lockedUntil && now < record.lockedUntil) {
      const waitSeconds = Math.ceil((record.lockedUntil - now) / 1000);
      return { allowed: false, remaining: 0, waitSeconds, locked: true };
    }
    
    if (record.lockedUntil && now >= record.lockedUntil) {
      loginAttempts.delete(ip);
      return { allowed: true, remaining: securityCfg.loginMaxAttempts };
    }
    
    const remaining = Math.max(0, securityCfg.loginMaxAttempts - record.count);
    return { allowed: true, remaining, locked: false };
  };

  const recordLoginAttempt = (ip, success) => {
    if (success) {
      loginAttempts.delete(ip);
      return;
    }
    
    const record = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
    record.count = (record.count || 0) + 1;
    
    if (record.count >= securityCfg.loginMaxAttempts) {
      record.lockedUntil = Date.now() + securityCfg.loginLockoutMinutes * 60 * 1000;
      console.warn(`[安全] 登录锁定 IP: ${ip}, 锁定 ${securityCfg.loginLockoutMinutes} 分钟`);
    }
    
    loginAttempts.set(ip, record);
  };

  return { checkLoginAttempt, recordLoginAttempt };
};

module.exports = { createLoginLimiter };
