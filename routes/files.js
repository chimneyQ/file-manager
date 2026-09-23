/**
 * 文件管理器 - 文件操作路由（上传/下载/删除/预览/搜索/创建文件夹）
 */

module.exports = function(app, ctx) {
  const pathMod = require('path');
  const fs = require('fs-extra');
  const { isAdmin, isUser, hasPermission, UPLOAD_DIR, RECYCLE_DIR, writeLog, createLogEntry, getLogFile,
          sanitizeFileName, formatSize, formatDate, getFileIcon, getDownloadCounts,
          storage, features, upload, searchFiles, getDirectoryContents, performance: perfCfg } = ctx;
  const { normalizePathBySession } = require('../lib/utils');

  // BASE（upload / download / view_shared）真正落地校验：
  //   · 超管直接通过
  //   · 已登录用户按 users.json 最新权限判定（BASE 由 getFullPermissions 自动附加，正常恒为真；
  //     显式校验是为了让"校验点"真实存在，异常快照/将来调整 BASE 时不会静默放行）
  //   · 游客按公开区语义，在 shared/ 内隐式拥有 BASE（否则游客浏览/上传/下载 shared 整体失效）
  const inSharedZone = (p) => {
    const n = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return n === 'shared' || n.startsWith('shared/');
  };
  const isGuest = (req) => !req.session?.userId;
  const canBase = (req, perm, relPath) => {
    if (isAdmin(req)) return true;
    if (hasPermission(req, perm)) return true;
    return isGuest(req) && inSharedZone(relPath);
  };

  // 是否处于"自己的私有空间"（含虚拟 users 根）：/mkdir 已放行该范围，
  // 页面上的"新建文件夹"按钮必须与之一致，否则出现"接口能建、按钮看不到"。
  const inOwnPrivateZone = (req, rawPath) => {
    if (!req.session?.userId) return false;
    const n = String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const mine = 'users/' + (req.session.username || '');
    return n === 'users' || n === 'users/' || n === mine || n.startsWith(mine + '/');
  };

  // 首页
  app.get('/', (req, res) => {
    let currentPath = req.query.path || '';
    const page = parseInt(req.query.page) || 1;
    const pageSize = perfCfg.folderPageSize;

    let virtualUsersRoot = false; // 非管理员位于 users 根: 渲染虚拟的"我的私有空间"层
    let myPrivate = '';

    if (!isAdmin(req)) {
      const userFolder = 'users/' + (req.session?.username || '');
      if (req.session?.userId) {
        // 已登录用户: 允许 internal/ shared/ 以及自己的私有文件夹 users/{username}
        myPrivate = userFolder; // users/{username}
        if (currentPath === 'users' || currentPath === 'users/') {
          // users 根目录 → 虚拟层: 只列出自己的私有空间。
          // 注意: 这里不能再直接跳进私有文件夹, 否则私有文件夹里的"返回上级"(→ users)
          // 会被本分支再次改写回私有文件夹, 表现为"返回上级无效"。
          currentPath = 'users';
          virtualUsersRoot = true;
        } else if (currentPath.startsWith('users/') && currentPath !== myPrivate && !currentPath.startsWith(myPrivate + '/')) {
          currentPath = myPrivate; // 别人的私有文件夹 → 强制改回自己的
        } else if (currentPath && !currentPath.startsWith('internal') && !currentPath.startsWith('shared') && !currentPath.startsWith('users')) {
          currentPath = 'shared';
        }
      } else {
        // 未登录: 空路径→shared, 且只能访问shared
        if (!currentPath || (!currentPath.startsWith('shared'))) currentPath = 'shared';
      }
    }

    // BASE 落地：查看 shared/ 需要 view_shared（游客按公开区语义隐式拥有；私有目录/内部目录不受此限）
    if (inSharedZone(currentPath) && !canBase(req, 'view_shared', currentPath)) {
      return res.status(403).send('无权限查看共享目录');
    }

    let items;
    if (virtualUsersRoot) {
      // 虚拟层: 只暴露自己的私有文件夹, 不列出其他用户目录
      const privateFull = pathMod.join(UPLOAD_DIR, myPrivate);
      let privateMtime = new Date();
      try { if (fs.existsSync(privateFull)) privateMtime = fs.statSync(privateFull).mtime; } catch (e) {}
      items = [{ name: '我的私有空间', type: 'folder', path: myPrivate, modified: privateMtime }];
    } else {
      items = getDirectoryContents(UPLOAD_DIR, currentPath);
    }
    const totalItems = items.length;
    
    const downloadCounts = getDownloadCounts();
    items = items.map(item => {
      if (item.type === 'file') {
        const fullPath = currentPath ? `${currentPath}/${item.name}` : item.name;
        item.downloadCount = downloadCounts[fullPath] || 0;
      } else {
        item.downloadCount = 0;
      }
      return item;
    });
    
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const paginatedItems = items.slice(start, end);
    const totalPages = Math.ceil(totalItems / pageSize);
    const breadcrumb = currentPath ? currentPath.split('/').filter(p => p) : [];

    writeLog(getLogFile(), createLogEntry(req, {
      operation: '查看文件列表',
      path: currentPath || '根目录',
      fileType: 'folder',
    }));

    res.render('index', {
      items: paginatedItems, currentPath, breadcrumb,
      uploadPath: virtualUsersRoot ? myPrivate : currentPath,
      isAdmin: isAdmin(req), isSuperAdmin: req.session?.isSuperAdmin || false, isUser: isUser(req),
      canViewLogs: isAdmin(req) || hasPermission(req, 'view_logs'), canRecycle: isAdmin(req) || hasPermission(req, 'recycle'), canShare: isAdmin(req) || hasPermission(req, 'share'),
      canDelete: isAdmin(req) || hasPermission(req, 'delete'), canManageUsers: isAdmin(req) || hasPermission(req, 'manage_users'), canCreateFolder: isAdmin(req) || hasPermission(req, 'create_folder'),
      // 按钮显示条件与 /mkdir 实际权限保持一致：有 create_folder 权限，或已登录且位于自己的私有空间
      canCreateFolderHere: isAdmin(req) || hasPermission(req, 'create_folder') || inOwnPrivateZone(req, currentPath),
      userName: req.session?.username || '', userRole: req.session?.userRole || '',
      formatSize, formatDate, getFileIcon,
      page, totalPages, totalItems, pageSize,
      features, darkMode: req.session?.darkMode || false,
    });
  });

  // 文件上传
  // 前置守卫：先校验 BASE 上传权限，通过后才交给 multer 落盘。
  //（原实现把权限判断放在处理器里，此时 multer 已经写完磁盘才回 403。）
  app.post('/upload', (req, res, next) => {
    const target = req._normalizedUploadPath
      || normalizePathBySession(req, isAdmin(req), req.query.path || req.body.path || '');
    if (!canBase(req, 'upload', target)) {
      return res.status(403).json({ success: false, message: '没有上传权限' });
    }
    // 存储配额（私有空间配额 / 整站硬上限）；快照未就绪时放行，保证监控异常不阻塞上传
    const quotaMsg = storage && typeof storage.checkQuota === 'function'
      ? storage.checkQuota(req, target, req.headers['content-length'])
      : null;
    if (quotaMsg) {
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: isAdmin(req) ? '管理员' : '游客',
        operation: '上传被拒', path: target, fileType: '-', message: quotaMsg,
      }));
      return res.status(413).json({ success: false, message: quotaMsg });
    }
    next();
  }, upload.single('file'), (req, res) => {
    try {
      // 落盘路径已在 multer destination 内按身份归一化（req._normalizedUploadPath），这里与之一致
      let currentPath = req._normalizedUploadPath || normalizePathBySession(req, isAdmin(req));

      if (!req.file) {
        writeLog(getLogFile(), createLogEntry(req, {
          loginType: isAdmin(req) ? '管理员' : '游客',
          operation: '上传失败', path: currentPath, fileType: '-', message: '没有文件被上传',
        }));
        return res.status(400).json({ success: false, message: '没有文件被上传' });
      }

      // 配额二次校验：以 multer 归一化后的真实落盘目标 + 文件实际大小为准。
      // 原因：multipart 的 body 字段在守卫阶段尚未解析（req.body.path 为 undefined），
      // 守卫只能覆盖带 ?path= 查询参数的上传；只带 body 字段的请求会绕过守卫判定，
      // 这里以 req._normalizedUploadPath（身份归一化后的落盘目录）复核并回滚已写入的文件。
      const quotaMsg = storage && typeof storage.checkQuota === 'function'
        ? storage.checkQuota(req, currentPath, req.file.size)
        : null;
      if (quotaMsg) {
        try { fs.removeSync(req.file.path); } catch (e) {}
        writeLog(getLogFile(), createLogEntry(req, {
          loginType: isAdmin(req) ? '管理员' : '游客',
          operation: '上传被拒', path: currentPath, fileType: '-', message: quotaMsg,
        }));
        return res.status(413).json({ success: false, message: quotaMsg });
      }

      const ext = pathMod.extname(req.file.filename).toLowerCase();
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: isAdmin(req) ? '管理员' : '游客',
        operation: '上传文件',
        path: pathMod.join(currentPath, req.file.filename).replace(/\\/g, '/'),
        fileType: ext || '-', fileSize: req.file.size,
      }));

      res.json({ success: true, message: '上传成功', filename: req.file.filename });
    } catch (err) {
      console.error('[上传错误]', err);
      try { res.status(500).json({ success: false, message: '上传处理失败: ' + err.message }); } catch {}
    }
  });

  // 创建文件夹
  app.post('/mkdir', (req, res) => {
    const { path: relativePath, name } = req.body;
    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: '文件夹名称不能为空' });
    }
    const safeName = sanitizeFileName(name.trim());
    // 先归一化、再判权限：原实现用「原始路径」判权限、之后才归一化，
    // 导致虚拟 users 根与私有目录根自身（users/<自己>）都被误判为非私有而返回 403。
    let targetPath = normalizePathBySession(req, isAdmin(req), relativePath || '');
    const userFolder = 'users/' + (req.session?.username || '');
    // 放宽：本人私有目录（含私有根自身）无需 create_folder 权限——那是用户自己的空间；
    // internal/ 与 shared/ 仍需要 create_folder 权限。
    const isInPrivateFolder = !isAdmin(req) && !!req.session?.userId &&
      (targetPath === userFolder || targetPath.startsWith(userFolder + '/'));
    if (!isAdmin(req) && !isInPrivateFolder && !hasPermission(req, 'create_folder')) {
      return res.status(403).json({ success: false, message: '没有创建文件夹权限' });
    }

    const fullPath = pathMod.join(UPLOAD_DIR, targetPath, safeName);
    try {
      if (!(fullPath === UPLOAD_DIR || fullPath.startsWith(UPLOAD_DIR + pathMod.sep))) throw new Error('非法路径');
      fs.ensureDirSync(fullPath);
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: isAdmin(req) ? '管理员' : '游客',
        operation: '创建文件夹',
        path: pathMod.join(targetPath, safeName).replace(/\\/g, '/'),
        fileType: 'folder',
      }));
      res.json({ success: true, message: '文件夹创建成功', name: safeName });
    } catch (err) {
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: isAdmin(req) ? '管理员' : '游客',
        operation: '创建文件夹失败',
        path: pathMod.join(targetPath, safeName).replace(/\\/g, '/'),
        fileType: 'folder', message: err.message,
      }));
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // 删除（支持单文件和批量）
  app.post('/delete', (req, res) => {
    const items = req.body.paths ? req.body.paths : [req.body.path];
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: '未指定要删除的文件' });
    }
    // 逐项鉴权：有 delete 权限可删任意对象；否则仅限自己的私有空间 users/<本人>/...
    // 注意：这里不能用 some() 整批放行——否则批量里混入一条自己的文件，就能连带删除
    // 共享目录甚至其他用户私有目录下的任意文件（已实测复现）。
    const canDeleteAny = isAdmin(req) || hasPermission(req, 'delete');
    const myPrivateRoot = 'users/' + (req.session?.username || '');
    const isMine = (p) => !!req.session?.userId && !!p && (p === myPrivateRoot || p.startsWith(myPrivateRoot + '/'));

    const deleted = [];
    const failed = [];

    for (const itemPath of items) {
      if (!itemPath) continue;
      if (!canDeleteAny && !isMine(itemPath)) {
        failed.push({ path: itemPath, error: '没有删除权限' });
        continue;
      }
      const fullPath = pathMod.join(UPLOAD_DIR, itemPath);
      if (!(fullPath === UPLOAD_DIR || fullPath.startsWith(UPLOAD_DIR + pathMod.sep))) {
        failed.push({ path: itemPath, error: '非法路径' });
        continue;
      }
      try {
        const stat = fs.statSync(fullPath);
        const fileType = stat.isDirectory() ? 'folder' : pathMod.extname(fullPath).toLowerCase() || 'file';
        if (features.enableRecycleBin) {
          const sanitizedPath = itemPath.replace(/:/g, '_').replace(/\\/g, '/');
          let recyclePath = pathMod.join(RECYCLE_DIR, sanitizedPath);
          fs.ensureDirSync(pathMod.dirname(recyclePath));
          if (fs.existsSync(recyclePath)) {
            recyclePath = pathMod.join(RECYCLE_DIR, sanitizedPath + '_' + Date.now());
            fs.ensureDirSync(pathMod.dirname(recyclePath));
          }
          fs.moveSync(fullPath, recyclePath);
        } else {
          fs.removeSync(fullPath);
        }
        deleted.push({ path: itemPath, type: fileType });
      } catch (err) {
        failed.push({ path: itemPath, error: err.message });
      }
    }

    deleted.forEach(item => {
      writeLog(getLogFile(), createLogEntry(req, {
        loginType: '管理员', operation: '删除',
        path: item.path, fileType: item.type,
      }));
    });

    if (deleted.length === 0 && failed.length > 0) {
      return res.status(403).json({ success: false, message: failed[0].error || '删除失败', deleted, failed });
    }

    if (deleted.length === 1 && failed.length === 0) {
      res.json({ success: true, message: '删除成功' });
    } else {
      res.json({
        success: failed.length === 0,
        message: `成功 ${deleted.length} 个，失败 ${failed.length} 个`,
        deleted, failed,
      });
    }
  });

  // 下载
  app.get('/download/*', (req, res) => {
    const filePath = req.params[0];
    const norm = filePath.replace(/^\//, '').replace(/\\/g, '/');
    if (!isAdmin(req)) {
      const userFolder = 'users/' + (req.session?.username || '');
      const inShared = norm === 'shared' || norm.startsWith('shared/');
      const inInternal = norm === 'internal' || norm.startsWith('internal/');
      const inMine = !!req.session?.userId && (norm === userFolder || norm.startsWith(userFolder + '/'));
      // 游客(未登录) 仅 shared/ —— 与 / 及 /api/folders 的目录语义保持一致
      if (!(inShared || (!!req.session?.userId && inInternal) || inMine)) {
        return res.status(403).send('无权限下载该文件');
      }
    }
    const fullPath = pathMod.resolve(UPLOAD_DIR, filePath);
    if (!(fullPath === UPLOAD_DIR || fullPath.startsWith(UPLOAD_DIR + pathMod.sep)) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).send('文件不存在');
    }
    // BASE 落地：下载需要 download 权限（游客在 shared/ 内隐式拥有；路径 ACL 已在其上层收窄）
    if (!canBase(req, 'download', norm)) {
      return res.status(403).send('无权限下载该文件');
    }
    writeLog(getLogFile(), createLogEntry(req, {
      loginType: isAdmin(req) ? '管理员' : '游客',
      operation: '下载文件', path: filePath,
      fileType: pathMod.extname(fullPath).toLowerCase() || '-',
    }));
    res.download(fullPath, pathMod.basename(fullPath));
  });

  // 预览
  app.get('/preview/*', (req, res) => {
    const filePath = req.params[0];
    const norm = filePath.replace(/^\//, '').replace(/\\/g, '/');
    if (!isAdmin(req)) {
      const userFolder = 'users/' + (req.session?.username || '');
      const inShared = norm === 'shared' || norm.startsWith('shared/');
      const inInternal = norm === 'internal' || norm.startsWith('internal/');
      const inMine = !!req.session?.userId && (norm === userFolder || norm.startsWith(userFolder + '/'));
      // 游客(未登录) 仅 shared/ —— 与 / 及 /api/folders 的目录语义保持一致
      if (!(inShared || (!!req.session?.userId && inInternal) || inMine)) {
        return res.status(403).send('无权限预览该文件');
      }
    }
    const fullPath = pathMod.resolve(UPLOAD_DIR, filePath);
    if (!(fullPath === UPLOAD_DIR || fullPath.startsWith(UPLOAD_DIR + pathMod.sep)) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return res.status(404).send('文件不存在');
    }
    // BASE 落地：预览需要 download 权限（游客在 shared/ 内隐式拥有；图片/音频/PDF/TXT 子资源预览不受影响）
    if (!canBase(req, 'download', norm)) {
      return res.status(403).send('无权限预览该文件');
    }
    // 阻断同源执行：上传的 html/svg/js 若被「直接打开 URL」会以当前登录者身份执行脚本
    // （CSP 的 script-src 含 'self' 与 'unsafe-inline'，拦不住同源脚本）。
    // 顶层导航(Sec-Fetch-Dest: document)时改走下载；img/audio/iframe 子资源预览不受影响。
    const EXEC_EXT = ['.html', '.htm', '.xhtml', '.xml', '.svg', '.js', '.mjs', '.css'];
    const fileExt = pathMod.extname(fullPath).toLowerCase();
    const dest = (req.headers && req.headers['sec-fetch-dest']) || '';
    const accept = (req.headers && req.headers['accept']) || '';
    // 顶层导航 = Sec-Fetch-Dest: document；不发该头的老浏览器用 Accept 兜底。
    // img/audio/iframe 子资源请求 Dest 分别是 image/audio/iframe（有值且非 document），
    // 故图片与 PDF/TXT 预览不受影响。
    const isNavigation = dest === 'document' || (!dest && accept.includes('text/html'));
    if (EXEC_EXT.includes(fileExt) && isNavigation) {
      // 跳转目标同样是"下载"，这里先判一次，避免通过预览入口绕过 download 校验
      if (!canBase(req, 'download', norm)) {
        return res.status(403).send('无权限下载该文件');
      }
      return res.redirect('/download/' + norm);
    }
    writeLog(getLogFile(), createLogEntry(req, {
      loginType: isAdmin(req) ? '管理员' : '游客',
      operation: '预览文件', path: filePath,
      fileType: fileExt || '-',
    }));
    res.sendFile(fullPath);
  });

  // 文件搜索
  app.get('/search', (req, res) => {
    if (!features.enableSearch) {
      return res.status(404).json({ success: false, message: '搜索功能已禁用' });
    }
    const keyword = (req.query.q || '').trim();
    if (!keyword) return res.json({ success: false, message: '请输入搜索关键词' });
    if (keyword.length < 2) return res.json({ success: false, message: '关键词至少2个字符' });

    // 搜索结果必须按身份可读范围过滤：游客仅 shared/；登录用户 internal + shared + 本人私有；超管全量。
    // 此处原为 isAdmin(req) ? UPLOAD_DIR : UPLOAD_DIR（两侧相同的死代码，收窄未实现），
    // 导致游客可搜索整个 uploads 并拿到他人私有目录的文件名。
    const userFolder = 'users/' + (req.session?.username || '');
    const canRead = (rel) => {
      if (isAdmin(req)) return true;
      const p = String(rel || '').replace(/\\/g, '/');
      // shared 结果需要 view_shared（BASE 三项之一）。正常账号由 getFullPermissions 自动持有，
      // 显式校验是为了让校验点真实存在：异常权限快照不会静默泄露共享区文件名。
      if (p === 'shared' || p.startsWith('shared/')) return canBase(req, 'view_shared', p);
      if (req.session?.userId) {
        if (p === 'internal' || p.startsWith('internal/')) return true;
        if (p === userFolder || p.startsWith(userFolder + '/')) return true;
      }
      return false;
    };
    const results = searchFiles(UPLOAD_DIR, keyword).filter(r => canRead(r.path));
    writeLog(getLogFile(), createLogEntry(req, {
      operation: '搜索文件', path: `关键词: ${keyword}`,
      fileType: '-', message: `找到 ${results.length} 个结果`,
    }));
    res.json({ success: true, results, keyword, total: results.length });
  });

  // 深色模式切换
  app.post('/api/dark-mode', (req, res) => {
    const enabled = req.body.enabled === true;
    req.session.darkMode = enabled;
    res.json({ success: true, darkMode: enabled });
  });
};

