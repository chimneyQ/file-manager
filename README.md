# 文件管理器（自托管 / Self-hosted File Manager）

一个开箱即用的自托管文件管理器：上传、下载、在线预览、回收站、分享链接、多用户与配额，界面风格接近 h5ai。

基于 **Node.js + Express + EJS**，**没有数据库、不依赖任何外部服务**，clone 下来 `npm install && npm start` 就能跑。

## 特性

| 分类 | 能力 |
| --- | --- |
| 文件 | 上传（拖拽）、下载、在线预览、搜索、批量删除、新建文件夹 |
| 组织 | 游客/用户私有目录、共享目录、文件夹树懒加载 |
| 安全 | 登录限流锁定、IP 白名单、Helmet 安全头、权限位（读/写/删除/管理等） |
| 运维 | 回收站（可设保留天数）、分享链接（可设有效期）、日志（按天轮转、UA 摘要）、存储配额与用量告警 |
| 部署 | 直接 `node`、PM2、Docker / docker compose 三种方式，路径零硬编码 |

## 快速开始

前置条件：**Node.js 18+**（推荐 20 LTS）。

```bash
git clone <仓库地址> file-manager
cd file-manager
npm install
npm start
```

启动后控制台会打印首次启动的账号信息：

```
================================================================
  首次启动：已自动创建管理员账号
  用户名：admin
  初始密码：xxxxxxxxxxx
  请登录后立即用「修改密码」更换（此密码只在本次显示）
================================================================
```

浏览器打开 <http://localhost:3000>，用上面的账号登录即可；游客也能直接浏览/上传（行为由 `config.js` 的 `features` 决定）。

> 首次启动会生成 `runtime-config.json`，里面存会话密钥与管理员密码哈希 —— 已在 `.gitignore` 中，**不要提交、不要外传**。
> 想换密码：登录后在页面里点「修改密码」；想重置：删掉 `runtime-config.json` 重启，会重新生成初始密码。

## 配置

所有可变项都走环境变量，复制模板后按需修改：

```bash
cp .env.example .env
npm run gen:secret     # 生成一个随机 SESSION_SECRET，贴进 .env
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `NODE_ENV` | `production` | `production` 会关闭控制台日志，`development` 便于排查 |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥。不设则首次启动随机生成并写入 `runtime-config.json`；多实例部署必须显式设置且一致 |
| `UPLOAD_DIR` | `./uploads` | 上传根目录，支持绝对路径 |
| `LOG_DIR` | `./logs` | 访问日志与 session 文件目录（`logs/sessions`） |
| `RECYCLE_DIR` | `./.trash` | 回收站目录 |
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD_HASH` | 空 | 管理员密码的 bcrypt 哈希；留空则首次启动自动生成初始密码 |
| `ALLOWED_ADMIN_IPS` | 空 | 管理后台 IP 白名单，逗号分隔，留空表示不限制 |
| `UPLOAD_PRIVATE_QUOTA_GB` | `5` | 单用户私有目录配额（GB），`0` = 不限 |
| `UPLOAD_TOTAL_WARN_GB` | `45` | 整站用量告警阈值（GB），只告警不拦截 |
| `UPLOAD_TOTAL_LIMIT_GB` | `0` | 整站硬上限（GB），`0` = 不限 |
| `UPLOAD_SCAN_INTERVAL_MS` | `21600000` | 用量扫描间隔，`0` = 不周期扫描 |

其余功能开关（是否允许游客浏览全部文件、是否启用回收站/分享链接/搜索等）在 `config.js` 的 `features` 段。

## 运行期目录

默认全部落在项目目录内，删掉项目目录即彻底清理；换机器只需搬这个目录：

| 路径 | 用途 | 是否入库 |
| --- | --- | --- |
| `uploads/` | 上传的文件 | 否 |
| `logs/` | 访问日志、PM2 日志、会话文件 | 否 |
| `.trash/` | 回收站 | 否 |
| `data/users.json` | 用户表（含密码哈希、手机号） | 否 |
| `data/share-links.json` | 分享链接（含访问 token） | 否 |
| `runtime-config.json` | 会话密钥 + 管理员密码哈希 | 否 |

## 平台支持

纯 Node.js 实现，不调用任何平台专有命令（无 `cmd`/`sh`、无 `du`/`df`、无硬编码路径），因此：

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10/11（x64/ARM64） | ✅ 已在用 | 开发与生产环境均为 Windows |
| Linux（Debian/Ubuntu/CentOS/Alpine） | ✅ CI 覆盖 | 提供 systemd 与 Docker 两种方式 |
| macOS（Intel / Apple Silicon） | ✅ CI 覆盖 | 与 Linux 用法一致 |
| Docker（任意宿主） | ✅ 提供镜像定义 | `docker compose up -d` |

CI 在 **Ubuntu / Windows / macOS × Node 18 / 20 / 22** 九种组合上跑同一套冒烟测试（`.github/workflows/ci.yml`），验证首启自举与登录链路。

本地自测：`npm run smoke`（在已部署目录中只做静态检查，不会改动现有数据；在干净检出中会完整验证首次启动流程）。

## 部署方式

### A. 直接运行（前台）

```bash
npm start
```

### B. PM2（Linux / Windows 长期运行）

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save                 # 保存进程列表
pm2 startup              # 生成开机自启命令（按提示执行）
```

`ecosystem.config.js` 里的路径全部相对项目目录，日志写在 `logs/` 并自动按 10MB 轮转。

### C. Docker / docker compose

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d
# 打开 http://localhost:3000 ；初始管理员密码在日志里：docker compose logs -f
```

数据通过 `./uploads`、`./logs`、`./.trash` 三个目录挂载到宿主机，容器重建不丢数据。

### D. systemd（Linux 原生）

`/etc/systemd/system/file-manager.service`：

```ini
[Unit]
Description=Self-hosted File Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/file-manager
Environment=NODE_ENV=production
EnvironmentFile=-/opt/file-manager/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now file-manager
```

### 反向代理（可选，Nginx）

```nginx
server {
  listen 80;
  server_name files.example.com;
  client_max_body_size 500m;        # 与上传上限保持一致
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

> 走 HTTPS 时，把 `config.js` 里的 `session.cookieSecure` 设为 `true`。

## 安全建议

1. 登录后第一件事：**修改初始密码**。
2. 公网部署请上 HTTPS，并按需配置 `ALLOWED_ADMIN_IPS`。
3. `.env`、`runtime-config.json`、`data/` 已在 `.gitignore`；换机器搬目录时注意这些文件含凭据。
4. 定期备份 `uploads/`；回收站只做误删缓冲，不是备份。

## 常见问题

- **启动报 `缺少 SESSION_SECRET`**：当前版本会自动生成密钥，正常不会出现；若出现，请确认项目目录可写（需要写 `runtime-config.json`）。
- **端口被占用**：`PORT=8080 npm start`（Windows：`set PORT=8080 && npm start`）。
- **上传大文件失败**：反向代理的 `client_max_body_size` 与 `config.js` 的 `security.maxFileSize` 都要放开。
- **忘了管理员密码**：停服务 → 删除或改坏 `runtime-config.json` 中的 `admin.passwordHash` → 重启，控制台会给出新的初始密码。

## 目录结构

```
file-manager/
├── server.js            # 入口：中间件、路由挂载、首次启动引导
├── config.js            # 全部配置与功能开关（可被环境变量覆盖）
├── ecosystem.config.js  # PM2 配置
├── Dockerfile / docker-compose.yml
├── lib/                 # 工具、日志、用户、存储配额、安全、地理IP
├── routes/              # auth / files / recycle / share / api / logs
├── views/               # EJS 模板
├── public/              # 前端静态资源
└── scripts/gen-secret.js
```

## 许可证

仓库当前未附带 LICENSE 文件。如果打算让其他人自由使用/二次分发，请在根目录添加 LICENSE（MIT 或 Apache-2.0 是这类工具最常见的两种选择）。

## 说明

这是一个面向局域网/个人自用的文件管理器，默认配置偏“好用”而非“对公网开放”。对外提供服务前，请按上面的安全建议逐条过一遍。

