/**
 * 文件管理器 - 服务器外网 IP 自动检测模块
 * 指数退避 + 静默化失败
 */

const https = require('https');

let serverExternalIp = 'unknown';
let _externalIpFailCount = 0;
let _externalIpLastLog = 0;
const _EXTERNAL_IP_WARN_INTERVAL = 30 * 60 * 1000;

const getServerExternalIp = () => serverExternalIp;

const createExternalIpChecker = (performanceCfg, writeLog, createLogEntry, getErrorLogFile) => {
  const updateServerExternalIp = async () => {
    if (!performanceCfg.enableExternalIpCheck) return;
    try {
      const data = await new Promise((resolve, reject) => {
        const req = https.get('https://api.ipify.org?format=json', (res) => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('解析失败')); } });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('超时')));
      });
      if (data && data.ip) {
        if (_externalIpFailCount > 0) {
          writeLog(getErrorLogFile(), createLogEntry({ session: {}, headers: {}, ip: '-' }, {
            loginType: '-', operation: '外网IP恢复',
            path: '-', fileType: '-',
            message: `外网IP恢复为 ${data.ip}（此前连续失败 ${_externalIpFailCount} 次）`,
          }));
        }
        serverExternalIp = data.ip;
        _externalIpFailCount = 0;
      }
    } catch (err) {
      _externalIpFailCount++;
      const now = Date.now();
      if (_externalIpFailCount === 1 || now - _externalIpLastLog > _EXTERNAL_IP_WARN_INTERVAL) {
        _externalIpLastLog = now;
        writeLog(getErrorLogFile(), createLogEntry({ session: {}, headers: {}, ip: '-' }, {
          loginType: '-', operation: '外网IP获取失败',
          path: '-', fileType: '-',
          message: `获取外网IP失败（连续第 ${_externalIpFailCount} 次）: ${err.message || err}`,
        }));
      }
    }
  };

  const scheduleNextExternalIpCheck = () => {
    const baseInterval = 10 * 60 * 1000;
    const backoff = Math.min(_externalIpFailCount, 5);
    const interval = backoff > 0
      ? baseInterval * Math.pow(2, backoff)
      : baseInterval;
    const capped = Math.min(interval, 60 * 60 * 1000);
    setTimeout(() => { updateServerExternalIp().finally(scheduleNextExternalIpCheck); }, capped);
  };

  return { updateServerExternalIp, scheduleNextExternalIpCheck, getServerExternalIp };
};

module.exports = { createExternalIpChecker, getServerExternalIp };
