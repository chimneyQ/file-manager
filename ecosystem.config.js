// PM2 进程配置：路径全部相对本文件，换机器/换目录不用改
const path = require('path');
const ROOT = __dirname;
const LOG_DIR = process.env.LOG_DIR || path.join(ROOT, 'logs');

module.exports = {
  apps: [{
    name: 'file-manager',
    script: 'server.js',
    cwd: ROOT,
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '5s',
    restart_delay: 4000,
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
    },
    // 日志轮转（防止 pm2-error.log / pm2-out.log 无限增长）
    error_file: path.join(LOG_DIR, 'pm2-error.log'),
    out_file: path.join(LOG_DIR, 'pm2-out.log'),
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_size: '10M',
    retain: 30,
  }],
};

