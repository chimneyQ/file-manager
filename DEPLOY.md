# 部署与运维手册

README 里的「部署方式」是简版，这份是运维细节。示例以 Linux 的 `/opt/file-manager` 为例，Windows 换成你的实际路径即可。

## 1. 一次性准备

```bash
cd /opt && git clone <仓库地址> file-manager && cd file-manager
npm ci --omit=dev            # 有 package-lock.json 时用 ci
cp .env.example .env
npm run gen:secret >> .env   # 追加一个随机 SESSION_SECRET
mkdir -p uploads logs .trash data
npm start                    # 记下控制台打印的初始管理员密码
```

> 不建目录也能跑：启动时会自动创建 `uploads/`、`logs/`、`.trash/`。

## 2. 常驻运行

### PM2
```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 logs file-manager
pm2 save && pm2 startup
```

### Docker
```bash
docker compose up -d --build
docker compose logs -f
docker compose exec file-manager sh   # 进容器排查
```

### systemd
见 README 的 unit 模板，改完执行 `systemctl restart file-manager && journalctl -u file-manager -f`。

## 3. 升级
```bash
git pull
npm ci --omit=dev
pm2 restart file-manager     # 或 docker compose up -d --build / systemctl restart file-manager
```
升级不会动 `runtime-config.json`、`data/`、`uploads/`。

## 4. 备份与迁移

要备份的只有三样：`uploads/`（文件）、`data/`（用户与分享链接）、`runtime-config.json`（会话密钥与管理员哈希）。
```bash
tar czf fm-backup-$(date +%F).tar.gz uploads data runtime-config.json
```
迁移：把这三样放到新机器上，装好依赖直接启动，**不用改任何代码**（目录默认相对项目根，或用 `.env` 指到别处）。

## 5. 日志与排查

| 文件 | 内容 |
| --- | --- |
| `logs/access-YYYY-MM-DD.log` | 访问日志（按天轮转，UA 已压缩为摘要） |
| `logs/error-*.log` | 错误日志 |
| `logs/pm2-out.log` / `pm2-error.log` | PM2 输出（10MB 轮转，保留 30 个） |
| `logs/sessions/` | session 文件（可随时清理，只会让用户重新登录） |

## 6. 对外提供服务前的安全清单

- [ ] 改掉初始管理员密码
- [ ] 启用 HTTPS，并把 `config.js` 的 `session.cookieSecure` 改为 `true`
- [ ] 视情况设置 `ALLOWED_ADMIN_IPS`
- [ ] 确认 `.env` / `runtime-config.json` / `data/` 未被提交、未被打进镜像
- [ ] 反向代理的上传体积上限与 `security.maxFileSize` 对齐
- [ ] `uploads/` 所在磁盘留足空间，并设置 `UPLOAD_TOTAL_WARN_GB` / `UPLOAD_TOTAL_LIMIT_GB`

