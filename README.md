# 文件管理器

一个简洁美观的文件上传下载管理系统，风格类似 h5ai。

## 功能特性

- **普通用户**：无需登录即可上传和下载文件
- **管理员**：登录后可进行上传、下载、删除、创建文件夹等操作
- **文件夹浏览**：按本地文件夹目录结构分类显示
- **拖拽上传**：支持拖拽文件上传
- **图片预览**：支持图片在线预览
- **响应式设计**：适配桌面和移动设备

## 默认账号

- **管理员账号**: `admin`
- **管理员密码**: `admin123`

## 使用方法

### 启动服务

```bash
# 使用管理脚本
manager.bat start

# 或直接运行
node server.js
```

### 停止服务

```bash
manager.bat stop
```

### 访问地址

打开浏览器访问: http://localhost:3000

## 配置说明

### 修改上传目录

编辑 `server.js` 文件，修改 `UPLOAD_DIR` 变量：

```javascript
const UPLOAD_DIR = 'D:\\Web\\uploads';
```

### 修改管理员密码

编辑 `server.js` 文件，修改密码哈希：

```javascript
const ADMIN_PASSWORD_HASH = bcrypt.hashSync('你的新密码', 10);
```

或使用环境变量：

```bash
set ADMIN_USERNAME=admin
set ADMIN_PASSWORD_HASH=你的密码哈希
node server.js
```

### 修改端口

```bash
set PORT=8080
node server.js
```

## 目录结构

```
file-manager/
├── server.js          # 主服务器文件
├── package.json       # 项目配置
├── manager.bat        # Windows 管理脚本
├── views/             # 页面模板
│   ├── index.ejs      # 文件列表页
│   └── login.ejs      # 登录页
├── public/            # 静态资源
│   ├── css/
│   │   └── style.css  # 样式文件
│   └── js/
│       └── app.js     # 前端脚本
└── README.md          # 说明文档
```

## 技术栈

- **后端**: Node.js + Express
- **模板引擎**: EJS
- **前端**: 原生 JavaScript + Font Awesome 图标
- **文件上传**: Multer

## 安全说明

- 所有文件操作都经过路径安全检查，防止目录遍历攻击
- 管理员会话使用加密存储
- 密码使用 bcrypt 加密存储
- 建议在生产环境中修改默认密码
