/**
 * 文件管理器 - 认证路由（登录/登出/注册/密码修改）
 */
const bcrypt = require('bcryptjs');

module.exports = function(app, ctx) {
  const { isAdmin, hasPermission, getClientIp, writeLog, createLogEntry, getLogFile,
          checkLoginAttempt, recordLoginAttempt, admin, features, saveRuntimeConfig, RUNTIME_CONFIG_PATH } = ctx;
  const users = require('../lib/users');

  // 登录页面
  app.get('/login', (req, res) => {
    if (req.session?.userId) return res.redirect('/');
    const clientIp = getClientIp(req);
    const check = checkLoginAttempt(clientIp);
    res.render('login', {
      error: null, locked: check.locked,
      waitSeconds: check.waitSeconds || 0, remaining: check.remaining, features,
    });
  });

  // 登录处理
  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const clientIp = getClientIp(req);

    const check = checkLoginAttempt(clientIp);
    if (!check.allowed) {
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: '未知', operation: '登录被锁定',
        path: '-', fileType: '-',
        message: `IP被锁定，还需等待 ${check.waitSeconds} 秒`,
      }));
      return res.render('login', {
        error: `登录失败次数过多，请 ${check.waitSeconds} 秒后重试`,
        locked: true, waitSeconds: check.waitSeconds, remaining: 0, features,
      });
    }

    const result = users.authenticate(username, password);
    if (result.error) {
      recordLoginAttempt(clientIp, false);
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: '未知', operation: '登录失败', path: '-', fileType: '-', username,
      }));
      const newCheck = checkLoginAttempt(clientIp);
      let errorMsg = result.error;
      if (!newCheck.allowed) {
        errorMsg += `（账号已锁定，请 ${newCheck.waitSeconds} 秒后重试）`;
      } else if (newCheck.remaining <= 2) {
        errorMsg += `（剩余 ${newCheck.remaining} 次尝试机会）`;
      }
      return res.render('login', {
        error: errorMsg, locked: newCheck.locked,
        waitSeconds: newCheck.waitSeconds || 0, remaining: newCheck.remaining, features,
      });
    }

    const user = result.user;
    recordLoginAttempt(clientIp, true);
    req.session.regenerate(() => {
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.userRole = user.role;
      req.session.userStatus = user.status;
      req.session.userPermissions = users.getFullPermissions(user);
      req.session.isAdmin = (user.role === 'superadmin');
      req.session.isSuperAdmin = (user.role === 'superadmin');
      req.session.darkMode = req.body.darkMode === 'true' || false;
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: user.role === 'superadmin' ? '超级管理员' : '管理员',
        operation: '登录成功', path: '-', fileType: '-',
      }));
      res.redirect('/');
    });
  });

  // 注册页面
  app.get('/register', (req, res) => {
    if (req.session?.userId) return res.redirect('/');
    res.render('register', { error: null, features });
  });

  // 注册处理
  app.post('/register', async (req, res) => {
    const { username, password, password2, phone, name } = req.body;
    if (!username || !password || !phone || !name) {
      return res.render('register', { error: '请填写所有字段', features });
    }
    if (username.length < 3 || username.length > 20) {
      return res.render('register', { error: '用户名长度 3-20 个字符', features });
    }
    // 用户名会被拼进私有目录路径 uploads/users/<username>，必须挡掉路径分隔符与 ..
    if (/[\/\\:*?"<>|]/.test(username) || username.includes('..') || username.startsWith('.') || username.endsWith('.')) {
      return res.render('register', { error: '用户名不能包含 / \\ : * ? " < > | 或连续/首尾的点', features });
    }
    if (password.length < 6) {
      return res.render('register', { error: '密码至少 6 个字符', features });
    }
    if (password !== password2) {
      return res.render('register', { error: '两次密码输入不一致', features });
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return res.render('register', { error: '手机号格式不正确', features });
    }
    if (name.length < 1 || name.length > 20) {
      return res.render('register', { error: '姓名长度 1-20 个字符', features });
    }
    const result = users.create({ username, password, phone, name });
    if (result.error) {
      return res.render('register', { error: result.error, features });
    }
    writeLog(getLogFile(), createLogEntry(req, {
      loginType: '游客', operation: '用户注册', path: '-', fileType: '-',
      message: `新用户注册: ${username}（${name}）`,
    }));
    res.render('register', { success: true, features });
  });

  // 登出
  app.get('/logout', (req, res) => {
    const userRole = req.session?.userRole || '游客';
    writeLog(getLogFile(), createLogEntry(req, {
      loginType: userRole === 'superadmin' ? '超级管理员' : userRole === 'admin' ? '管理员' : '游客',
      operation: '登出', path: '-', fileType: '-',
    }));
    req.session.destroy(() => res.redirect('/'));
  });

  // 修改密码
  app.post('/api/change-password', async (req, res) => {
    if (!req.session?.userId) return res.status(403).json({ success: false, message: '请先登录' });
    const { newPassword } = req.body;
    const currentPassword = req.body.currentPassword || req.body.oldPassword;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: '请填写当前密码和新密码' });
    }
    const user = users.findById(req.session.userId);
    if (!user || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
      return res.status(400).json({ success: false, message: '当前密码错误' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: '新密码至少6个字符' });
    }
    const newHash = bcrypt.hashSync(newPassword, 10);
    user.passwordHash = newHash;
    // 同步更新 users.json
    users.save();
    // 同步更新 runtime-config.json（如果是超级管理员）
    if (user.role === 'superadmin') {
      try {
        const fs = require('fs-extra');
        let config = {};
        if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
          config = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
        }
        if (!config.admin) config.admin = {};
        config.admin.passwordHash = newHash;
        saveRuntimeConfig(config);
      } catch (err) {
        console.error('保存密码失败:', err);
      }
    }
    writeLog(getLogFile(), createLogEntry(req, {
      loginType: user.role === 'superadmin' ? '超级管理员' : '管理员',
      operation: '密码修改成功', path: '-', fileType: '-',
    }));
    res.json({ success: true, message: '密码修改成功！请使用新密码重新登录' });
  });

  // ========== 用户管理 API（仅超级管理员）==========
  // 获取所有用户
  app.get('/api/users', (req, res) => {
    if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.status(403).json({ error: '需要管理员权限' });
    const allUsers = users.findAll().map(u => ({
      id: u.id, username: u.username, phone: u.phone, name: u.name,
      role: u.role, status: u.status, permissions: u.permissions,
      createdAt: u.createdAt, approvedAt: u.approvedAt,
    }));
    res.json(allUsers);
  });

  // 获取待审核用户
  app.get('/api/users/pending', (req, res) => {
    if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.status(403).json({ error: '需要管理员权限' });
    const pending = users.getPendingUsers().map(u => ({
      id: u.id, username: u.username, phone: u.phone, name: u.name,
      createdAt: u.createdAt,
    }));
    res.json(pending);
  });

  // 审核通过
  app.post('/api/users/:id/approve', (req, res) => {
    console.log('[APPROVE] called for id:', req.params.id, 'by:', req.session?.username);
    if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.status(403).json({ error: '需要管理员权限' });
    const { permissions } = req.body;
    console.log('[APPROVE] permissions:', permissions);
    const result = users.approve(req.params.id, permissions);
    console.log('[APPROVE] result:', result.error || 'success, status=' + result.user?.status);
    if (result.error) return res.status(400).json(result);
    // 审核通过时自动创建私有文件夹
    users.createPrivateFolder(result.user.username);
    res.json({ success: true, user: { id: result.user.id, username: result.user.username, status: 'approved' } });
  });

  // 审核拒绝
  app.post('/api/users/:id/reject', (req, res) => {
    console.log('[REJECT] called for id:', req.params.id, 'by:', req.session?.username);
    if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.status(403).json({ error: '需要管理员权限' });
    const result = users.reject(req.params.id);
    if (result.error) return res.status(400).json(result);
    res.json({ success: true });
  });

  // 更新权限
  app.post('/api/users/:id/permissions', (req, res) => {
    if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.status(403).json({ error: '需要管理员权限' });
    const { permissions } = req.body;
    const result = users.updatePermissions(req.params.id, permissions || []);
    if (result.error) return res.status(400).json(result);
    res.json({ success: true });
  });

  // 重置密码
  app.post('/api/users/:id/reset-password', (req, res) => {
    if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.status(403).json({ error: '需要管理员权限' });
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: '密码至少6个字符' });
    }
    const result = users.resetPassword(req.params.id, newPassword);
    if (result.error) return res.status(400).json(result);
    res.json({ success: true });
  });

  // 删除用户
  app.delete('/api/users/:id', (req, res) => {
    if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.status(403).json({ error: '需要管理员权限' });
    const result = users.remove(req.params.id);
    if (result.error) return res.status(400).json(result);
    res.json({ success: true });
  });

  // 权限列表
  app.get('/api/permissions', (req, res) => {
    if (!req.session?.isSuperAdmin && !hasPermission(req, 'manage_users')) return res.status(403).json({ error: '需要管理员权限' });
    res.json({ all: users.ALL_PERMISSIONS, labels: users.PERMISSION_LABELS });
  });
};
