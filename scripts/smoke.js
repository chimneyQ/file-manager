#!/usr/bin/env node
/**
 * 跨平台冒烟测试（Windows / macOS / Linux 通用，只用 Node 内置模块）
 *
 * 设计前提：**只在干净检出上跑破坏性验证**。
 * 若当前目录已有 .env / runtime-config.json / data/users.json（说明是真在用的部署），
 * 脚本会自动跳过自举与登录测试，只做静态检查，绝不改动任何现有文件。
 * CI 里是干净检出，因此自举路径照样被真正验证。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.SMOKE_PORT || '4399';

const RUNTIME_FILES = ['.env', 'runtime-config.json', 'runtime-config.json.bak', path.join('data', 'users.json'), path.join('data', 'share-links.json')];
const present = RUNTIME_FILES.filter(f => fs.existsSync(path.join(ROOT, f)));

function staticChecks() {
  const required = ['server.js', 'config.js', 'package.json', 'README.md', 'Dockerfile', 'docker-compose.yml', '.env.example', 'ecosystem.config.js'];
  const missing = required.filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) { console.error('\u2717 缺少必需文件: ' + missing.join(', ')); process.exit(1); }
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const rule of ['.env', 'runtime-config.json', 'data/users.json']) {
    if (!gi.includes(rule)) { console.error('\u2717 .gitignore 未忽略 ' + rule); process.exit(1); }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.engines || !pkg.engines.node) { console.error('\u2717 package.json 缺少 engines.node'); process.exit(1); }
  console.log('\u2713 静态检查通过（必需文件齐全、敏感文件已忽略、engines 已声明）');
}

function skipBoot() {
  console.log('\u2139 检测到运行期文件（' + present.join(', ') + '），判定为「已部署环境」，跳过首启自举测试以免破坏现有数据。');
  console.log('  要验证「下载即用」，请在干净检出（或 CI）中运行；本次只做静态检查。');
}

const waitFor = async (url, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const res = await fetch(url); if (res.status) return res; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
};

let child = null;
let dataDir = null;

function cleanup() {
  try { if (child) child.kill(); } catch {}
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} }
}
process.on('exit', cleanup);

(async () => {
  staticChecks();

  if (present.length) { skipBoot(); process.exit(0); }

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-smoke-'));
  const env = {
    ...process.env,
    PORT,
    NODE_ENV: 'production',
    UPLOAD_DIR: path.join(dataDir, 'uploads'),
    LOG_DIR: path.join(dataDir, 'logs'),
    RECYCLE_DIR: path.join(dataDir, '.trash'),
  };
  delete env.SESSION_SECRET;
  delete env.ADMIN_PASSWORD_HASH;

  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });

  const fail = (msg) => {
    console.error('\u2717 ' + msg);
    if (out.trim()) console.error('--- server output ---\n' + out.trim());
    cleanup();
    process.exit(1);
  };

  const base = 'http://127.0.0.1:' + PORT;
  const login = await waitFor(base + '/login', 25000);
  if (!login) fail('服务在 25 秒内未就绪');
  if (login.status !== 200) fail('GET /login 期望 200，实际 ' + login.status);

  const pwd = (out.match(/\u521d\u59cb\u5bc6\u7801\uff1a(\S+)/) || [])[1];
  if (!pwd) fail('控制台未打印初始管理员密码（首次启动自举失效）');

  for (const dir of ['uploads', 'logs', '.trash']) {
    if (!fs.existsSync(path.join(dataDir, dir))) fail('未自动创建目录: ' + dir);
  }

  const rcPath = path.join(ROOT, 'runtime-config.json');
  if (!fs.existsSync(rcPath)) fail('未生成 runtime-config.json');
  const rc = JSON.parse(fs.readFileSync(rcPath, 'utf8'));
  if (!rc.session || !rc.session.secret || rc.session.secret.length < 32) fail('SESSION_SECRET 未正确落盘');
  if (!rc.admin || !rc.admin.passwordHash) fail('管理员密码哈希未落盘');

  const res = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: pwd }),
    redirect: 'manual',
  });
  if (res.status !== 302) fail('POST /login 期望 302，实际 ' + res.status);
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const sid = raw.map(c => String(c).split(';')[0]).find(c => c.startsWith('fm_sid='));
  if (!sid) fail('登录成功但未下发 fm_sid 会话 cookie');

  const home = await fetch(base + '/', { headers: { cookie: sid }, redirect: 'manual' });
  if (home.status !== 200) fail('登录后访问首页期望 200，实际 ' + home.status);

  child.kill();
  child = null;
  fs.rmSync(rcPath, { force: true });
  console.log('\u2713 首启自举冒烟通过（' + process.platform + ' / node ' + process.versions.node + '）');
  process.exit(0);
})().catch(err => { console.error('\u2717 ' + (err && err.message ? err.message : String(err))); cleanup(); process.exit(1); });

