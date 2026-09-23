# 文件管理器部署说明

## 快速开始

### 1. 访问网站

打开浏览器访问：**http://localhost:3000**

### 2. 默认账号

- **管理员账号**: `admin`
- **管理员密码**: `admin123`

### 3. 功能说明

#### 普通用户（无需登录）
- ✅ 浏览文件和文件夹
- ✅ 下载文件
- ✅ 上传文件到当前目录

#### 管理员（需要登录）
- ✅ 所有普通用户功能
- ✅ 删除文件/文件夹
- ✅ 创建新文件夹
- ✅ 管理文件结构

### 4. 管理命令

```bash
# 启动服务
manager.bat start

# 停止服务
manager.bat stop

# 重启服务
manager.bat restart

# 查看状态
manager.bat status
```

### 5. 设置开机自启

运行 `setup-autostart.bat`，选择选项 1 添加到开机自启。

### 6. 修改配置

编辑 `server.js` 文件：

```javascript
// 修改上传目录
const UPLOAD_DIR = 'D:\\Web\\uploads';

// 修改管理员账号
const ADMIN_USERNAME = 'admin';

// 修改管理员密码
const ADMIN_PASSWORD_HASH = bcrypt.hashSync('新密码', 10);
```

或使用环境变量：

```bash
set UPLOAD_DIR=D:\\Web\\uploads
set ADMIN_USERNAME=admin
set ADMIN_PASSWORD_HASH=密码哈希
set PORT=3000
node server.js
```

## 文件结构

```
D:\Web\uploads\          # 文件上传目录（可自定义）
file-manager\            # 项目目录
├── server.js            # 主服务器
├── manager.bat          # 管理脚本
├── setup-autostart.bat  # 开机自启设置
├── views\               # 页面模板
│   ├── index.ejs        # 文件列表页
│   └── login.ejs        # 登录页
└── public\              # 静态资源
    ├── css\style.css    # 样式
    └── js\app.js        # 前端脚本
```

## 安全建议

1. **修改默认密码**：首次使用后请修改管理员密码
2. **设置防火墙**：如果对外提供服务，请配置防火墙规则
3. **使用 HTTPS**：生产环境建议使用 HTTPS
4. **定期备份**：定期备份上传目录中的重要文件

## 故障排除

### 端口被占用
修改 `server.js` 中的端口或使用环境变量：
```bash
set PORT=8080
node server.js
```

### 权限问题
确保 Node.js 有权限访问上传目录：
```bash
# 检查目录权限
icacls "D:\Web\uploads"
```

### 服务无法启动
检查日志文件 `server.log` 获取详细错误信息。
