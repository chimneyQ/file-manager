/**
 * 文件管理器 - 多用户管理模块
 * 
 * 权限说明：
 *   基础权限（所有已审核用户自动拥有）：upload, download, view_shared
 *   管理权限（需超级管理员手动分配）：delete, create_folder, view_logs, manage_users, share, recycle
 * 
 * 私有文件夹：审核通过时自动创建 uploads/users/{username}/
 */

const fs = require('fs-extra');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const UPLOAD_DIR = require('../config').dirs.upload;

// 基础权限（所有已审核用户自动拥有，不需要手动分配）
const BASE_PERMISSIONS = ['upload', 'download', 'view_shared'];

// 可分配的管理权限
const MANAGE_PERMISSIONS = [
  'delete',           // 删除文件/文件夹
  'create_folder',    // 创建文件夹
  'view_logs',        // 查看访问日志
  'manage_users',     // 管理用户
  'share',            // 创建分享链接
  'recycle',          // 回收站操作
];

const ALL_PERMISSIONS = [...BASE_PERMISSIONS, ...MANAGE_PERMISSIONS];

const PERMISSION_LABELS = {
  upload: '上传文件',
  download: '下载文件',
  view_shared: '查看共享',
  delete: '删除文件',
  create_folder: '创建文件夹',
  view_logs: '查看日志',
  manage_users: '用户管理',
  share: '分享链接',
  recycle: '回收站',
};

// 超级管理员拥有所有权限
const SUPERADMIN_PERMISSIONS = [...ALL_PERMISSIONS];

let _users = [];
let _loaded = false;

function load() {
  try {
    fs.ensureDirSync(DATA_DIR);
    if (fs.existsSync(USERS_FILE)) {
      _users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (!Array.isArray(_users)) _users = [];
    } else {
      _users = [];
      const cfg = require('../config');
      let pwHash = cfg.admin.passwordHash || '';
      // 也检查 runtime-config.json
      if (!pwHash) {
        try {
          const rcPath = path.join(__dirname, '..', 'runtime-config.json');
          if (fs.existsSync(rcPath)) {
            const rc = JSON.parse(fs.readFileSync(rcPath, 'utf8'));
            if (rc.admin && rc.admin.passwordHash) pwHash = rc.admin.passwordHash;
          }
        } catch {}
      }
      if (pwHash) {
        _users.push({
          id: 'admin-001',
          username: cfg.admin.username || 'admin',
          passwordHash: pwHash,
          phone: '', name: '超级管理员',
          role: 'superadmin', status: 'approved',
          permissions: [...SUPERADMIN_PERMISSIONS],
          createdAt: new Date().toISOString(),
          approvedAt: new Date().toISOString(),
        });
        save();
      }
    }
    _loaded = true;
  } catch (err) {
    console.error('[用户管理] 加载失败:', err.message);
    _users = [];
    _loaded = true;
  }
}

function save() {
  try {
    fs.ensureDirSync(DATA_DIR);
    fs.writeFileSync(USERS_FILE, JSON.stringify(_users, null, 2), 'utf8');
  } catch (err) {
    console.error('[用户管理] 保存失败:', err.message);
  }
}

function ensureLoaded() { if (!_loaded) load(); return _users; }

function findAll()  { ensureLoaded(); return [..._users]; }
function findById(id) { ensureLoaded(); return _users.find(u => u.id === id) || null; }
function findByUsername(username) { ensureLoaded(); return _users.find(u => u.username === username) || null; }
function getPendingUsers() { ensureLoaded(); return _users.filter(u => u.status === 'pending'); }

// 获取用户完整权限（基础权限 + 分配的管理权限）
function getFullPermissions(user) {
  if (user.role === 'superadmin') return [...SUPERADMIN_PERMISSIONS];
  return [...new Set([...BASE_PERMISSIONS, ...(user.permissions || [])])];
}

// 创建用户私有文件夹
function createPrivateFolder(username) {
  const privateDir = path.join(UPLOAD_DIR, 'users', username);
  fs.ensureDirSync(privateDir);
  return privateDir;
}

function create({ username, password, phone, name }) {
  ensureLoaded();
  if (findByUsername(username)) return { error: '用户名已存在' };
  const user = {
    id: 'user-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username, passwordHash: bcrypt.hashSync(password, 10),
    phone: phone || '', name: name || '',
    role: 'admin', status: 'pending',
    permissions: [],  // 管理权限，默认空（基础权限自动拥有）
    createdAt: new Date().toISOString(), approvedAt: null,
  };
  _users.push(user);
  save();
  return { user };
}

function approve(id, permissions) {
  ensureLoaded();
  const user = findById(id);
  if (!user) return { error: '用户不存在' };
  if (user.role === 'superadmin') return { error: '不能修改超级管理员' };
  user.status = 'approved';
  // 只保存管理权限（基础权限自动拥有）
  user.permissions = (permissions || []).filter(p => MANAGE_PERMISSIONS.includes(p));
  user.approvedAt = new Date().toISOString();
  // 自动创建私有文件夹
  createPrivateFolder(user.username);
  save();
  return { user };
}

function reject(id) {
  ensureLoaded();
  const user = findById(id);
  if (!user) return { error: '用户不存在' };
  if (user.role === 'superadmin') return { error: '不能修改超级管理员' };
  user.status = 'rejected';
  save();
  return { user };
}

function updatePermissions(id, permissions) {
  ensureLoaded();
  const user = findById(id);
  if (!user) return { error: '用户不存在' };
  if (user.role === 'superadmin') return { error: '超级管理员权限不可修改' };
  // 只保存管理权限
  user.permissions = (permissions || []).filter(p => MANAGE_PERMISSIONS.includes(p));
  save();
  return { user };
}

function remove(id) {
  ensureLoaded();
  const user = findById(id);
  if (!user) return { error: '用户不存在' };
  if (user.role === 'superadmin') return { error: '不能删除超级管理员' };
  _users = _users.filter(u => u.id !== id);
  save();
  return { ok: true };
}

function resetPassword(id, newPassword) {
  ensureLoaded();
  const user = findById(id);
  if (!user) return { error: '用户不存在' };
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  save();
  return { user };
}

function authenticate(username, password) {
  ensureLoaded();
  const user = findByUsername(username);
  if (!user) return { error: '用户名不存在' };
  if (user.status === 'pending') return { error: '账号待审核，请等待管理员审核' };
  if (user.status === 'rejected') return { error: '账号已被拒绝' };
  if (!user.passwordHash) return { error: '密码未设置' };
  if (!bcrypt.compareSync(password, user.passwordHash)) return { error: '密码错误' };
  return { user };
}

load();

module.exports = {
  BASE_PERMISSIONS, MANAGE_PERMISSIONS, ALL_PERMISSIONS,
  PERMISSION_LABELS, SUPERADMIN_PERMISSIONS,
  getFullPermissions, createPrivateFolder,
  load, save, ensureLoaded, findAll, findById, findByUsername, getPendingUsers,
  create, approve, reject, remove, updatePermissions, resetPassword, authenticate,
};
