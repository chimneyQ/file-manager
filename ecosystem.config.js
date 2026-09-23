module.exports = {
  apps: [{
    name: 'file-manager',
    script: 'server.js',
    cwd: 'D:\\Web\\file-manager',
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '5s',
    restart_delay: 4000,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    // ===== 日志输出配置（防止 pm2-error.log / pm2-out.log 无限增长）=====
    // PM2 默认日志目录：C:\Users\<user>\.pm2\logs
    error_file: 'D:\\Web\\logs\\pm2-error.log',
    out_file:   'D:\\Web\\logs\\pm2-out.log',
    merge_logs: true,
    // 日志轮转（pm2-logrotate 风格的内建配置）
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_size: '10M',          // 单文件最大 10MB，超过自动轮转
    retain: 30,                // 保留最近 30 个轮转文件
  }],
};
