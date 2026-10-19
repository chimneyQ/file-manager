let selectedFiles = [];
let expandedFolders = new Set();
let searchResults = null;
let darkMode = false;
const UPLOAD_CONFIG = {
concurrentMax: 3,
};
document.addEventListener('DOMContentLoaded', () => {
initDragAndDrop();
initDarkModeToggle();
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('q')) {
document.getElementById('searchInput')?.setAttribute('value', urlParams.get('q'));
performSearch(urlParams.get('q'));
}
});
function initDarkModeToggle() {
const toggle = document.getElementById('darkModeToggle');
if (toggle) {
    toggle.addEventListener('click', async () => {
      darkMode = !darkMode;
      document.body.classList.toggle('dark-mode', darkMode);
      const icon = toggle.querySelector('i');
      if (icon) {
        icon.className = darkMode ? 'fas fa-sun' : 'fas fa-moon';
      }
      try {
        await fetch('/api/dark-mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: darkMode }),
        });
      } catch (err) {
        console.error('保存深色模式偏好失败:', err);
      }
    });
}
}
function performSearch(keyword) {
if (!keyword || keyword.trim().length < 2) {
alert('关键词至少2个字符');
return;
}
const searchResultsContainer = document.getElementById('searchResults');
const fileList = document.getElementById('mainFileList');
if (!searchResultsContainer) return;
searchResultsContainer.style.display = 'block';
if (fileList) fileList.style.display = 'none';
fetch(`/search?q=${encodeURIComponent(keyword)}&limit=100`)
.then(r => r.json())
.then(data => {
if (data.success) {
searchResults = data.results;
renderSearchResults(data.results, keyword);
} else {
searchResultsContainer.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>${data.message}</p></div>`;
}
})
.catch(err => {
searchResultsContainer.innerHTML = `<div class=\"empty-state\"><i class=\"fas fa-exclamation-triangle\"></i><p>搜索失败: ${err.message}</p></div>`;
});
}
function renderSearchResults(results, keyword) {
const container = document.getElementById('searchResults');
if (!container) return;
if (results.length === 0) {
container.innerHTML = `<div class=\"empty-state\"><i class=\"fas fa-search\"></i><p>未找到包含\"${escapeHtml(keyword)}\"的文件</p></div>`;
return;
}
container.innerHTML = `
<div style="padding: 10px 15px; background: #e3f2fd; border-radius: 8px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
<span><i class=\"fas fa-search\"></i> 找到 <strong>${results.length}</strong> 个结果（关键词: \"${escapeHtml(keyword)}\"）</span>
<button class="btn btn-secondary" onclick="clearSearch()">
<i class=\"fas fa-times\"></i> 清除搜索
</button>
</div>
<table class="file-table">
<thead>
<tr>
<th class=\"col-name\">名称</th>
<th class=\"col-size\">大小</th>
<th class=\"col-date\">修改日期</th>
<th class=\"col-actions\">操作</th>
</tr>
</thead>
<tbody>
${results.map(item => `
<tr class="file-row" data-type="${item.type}" data-path="${item.path}" onclick="handleFileRowClick(event)">
<td class="col-name">
<span class="file-link">
<i class="fas fa-${item.type === 'folder' ? 'folder' : 'file'} file-icon ${item.type === 'folder' ? 'folder-icon' : getFileIcon(item.ext) + '-icon'}"></i>
<span class="file-name">${highlightKeyword(item.name, keyword)}</span>
</span>
</td>
<td class="col-size">${item.type === 'folder' ? '-' : formatFileSize(item.size)}</td>
<td class="col-date">${formatDateTime(item.modified)}</td>
<td class="col-actions">
${item.type === 'file' ? `
<a href=\"/download/${item.path}\" class=\"action-btn\" title=\"下载\">
<i class="fas fa-download"></i>
</a>
${isPreviewable(item.ext) ? `
<button class=\"action-btn\" onclick=\"previewItem('${item.path}', '${item.ext}')\" title=\"预览\">
<i class="fas fa-eye"></i>
</button>
` : ''}
` : `
<a href="/?path=${encodeURIComponent(item.path)}" class="btn btn-secondary btn-sm">
<i class=\"fas fa-folder-open\"></i> 打开
</a>
`}
</td>
</tr>
`).join('')}
</tbody>
</table>
`;
}
function clearSearch() {
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const fileList = document.getElementById('mainFileList');
if (searchInput) searchInput.value = '';
if (searchResults) {
searchResults.innerHTML = '';
searchResults.style.display = 'none';
}
if (fileList) fileList.style.display = 'block';
const url = new URL(window.location);
url.searchParams.delete('q');
window.history.replaceState({}, '', url);
searchResults = null;
}
function highlightKeyword(text, keyword) {
const regex = new RegExp(`(${escapeRegex(keyword)})`, 'gi');
return escapeHtml(text).replace(regex, '<mark style="background:#ffeb3b;padding:0 2px;border-radius:2px;">$1</mark>');
}
function escapeRegex(str) {
return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
async function loadFolderTree(parentPath) {
try {
let url = '/api/folders';
if (parentPath !== undefined && parentPath !== null) {
url += '?parent=' + encodeURIComponent(parentPath);
}
const response = await fetch(url);
const folders = await response.json();
renderFolderList(folders, parentPath);
} catch (err) {
console.error('加载文件夹树失败:', err);
}
}
function renderFolderList(folders, parentPath) {
const container = document.getElementById('folderTree');
if (!container) return;
const currentPath = document.getElementById('uploadPath')?.value || '';
let targetContainer;
if (parentPath === undefined || parentPath === null) {
container.innerHTML = '';
targetContainer = container;
const rootItem = document.createElement('div');
rootItem.className = 'folder-tree-item' + (currentPath === '' ? ' selected' : '');
rootItem.dataset.path = '';
rootItem.dataset.level = '0';
rootItem.innerHTML = '<i class=\"fas fa-chevron-right toggle-icon\" style=\"visibility:hidden\"></i><i class=\"fas fa-folder folder-icon\"></i><span class=\"folder-name\">根目录</span>';
rootItem.addEventListener('click', () => selectFolder('', '根目录'));
targetContainer.appendChild(rootItem);
} else {
targetContainer = document.querySelector(`.folder-tree-children[data-parent="${parentPath}"]`);
if (!targetContainer) return;
targetContainer.innerHTML = '';
expandedFolders.add(parentPath);
const toggleIcon = document.querySelector(`.folder-tree-item[data-path="${parentPath}"] .toggle-icon`);
if (toggleIcon) toggleIcon.classList.add('expanded');
targetContainer.classList.add('expanded');
}
folders.forEach(folder => {
const item = document.createElement('div');
item.className = 'folder-tree-item' + (folder.path === currentPath ? ' selected' : '');
item.dataset.path = folder.path;
const level = parentPath ? parentPath.split('/').filter(p => p).length + 1 : 0;
item.dataset.level = level;
const hasChildren = folder.hasChildren || false;
const isExpanded = expandedFolders.has(folder.path);
const toggleEl = document.createElement('i');
toggleEl.className = 'fas fa-chevron-right toggle-icon' + (isExpanded ? ' expanded' : '');
if (!hasChildren) toggleEl.style.visibility = 'hidden';
toggleEl.addEventListener('click', (e) => {
e.stopPropagation();
toggleFolder(folder.path);
});
item.appendChild(toggleEl);
const folderIcon = document.createElement('i');
folderIcon.className = 'fas fa-folder folder-icon';
item.appendChild(folderIcon);
const nameSpan = document.createElement('span');
nameSpan.className = 'folder-name';
nameSpan.textContent = folder.name;
item.appendChild(nameSpan);
item.addEventListener('click', (e) => {
if (!e.target.classList.contains('toggle-icon')) {
selectFolder(folder.path, folder.name);
}
});
targetContainer.appendChild(item);
const childrenContainer = document.createElement('div');
childrenContainer.className = 'folder-tree-children' + (isExpanded ? ' expanded' : '');
childrenContainer.dataset.parent = folder.path;
targetContainer.appendChild(childrenContainer);
if (isExpanded && hasChildren) {
loadFolderTree(folder.path);
}
});
}
function toggleFolder(folderPath) {
const childrenContainer = document.querySelector(`.folder-tree-children[data-parent="${folderPath}"]`);
const toggleIcon = document.querySelector(`.folder-tree-item[data-path="${folderPath}"] .toggle-icon`);
if (expandedFolders.has(folderPath)) {
expandedFolders.delete(folderPath);
toggleIcon?.classList.remove('expanded');
childrenContainer?.classList.remove('expanded');
} else {
expandedFolders.add(folderPath);
toggleIcon?.classList.add('expanded');
if (childrenContainer) {
childrenContainer.classList.add('expanded');
if (childrenContainer.children.length === 0) {
loadFolderTree(folderPath);
}
}
}
}
async function expandToPath(targetPath) {
if (!targetPath) return;
const parts = targetPath.split('/').filter(p => p);
for (let i = 0; i < parts.length; i++) {
const currentPartPath = parts.slice(0, i + 1).join('/');
const childrenContainer = document.querySelector(`.folder-tree-children[data-parent="${currentPartPath}"]`);
const toggleIcon = document.querySelector(`.folder-tree-item[data-path="${currentPartPath}"] .toggle-icon`);
if (childrenContainer) {
if (childrenContainer.children.length === 0 && toggleIcon && toggleIcon.style.visibility !== 'hidden') {
await loadFolderTree(currentPartPath);
}
expandedFolders.add(currentPartPath);
toggleIcon?.classList.add('expanded');
childrenContainer.classList.add('expanded');
} else {
const parentPartPath = i === 0 ? '' : parts.slice(0, i).join('/');
await loadFolderTree(parentPartPath);
await new Promise(resolve => setTimeout(resolve, 50));
const newContainer = document.querySelector(`.folder-tree-children[data-parent="${currentPartPath}"]`);
if (newContainer) {
expandedFolders.add(currentPartPath);
newContainer.classList.add('expanded');
document.querySelector(`.folder-tree-item[data-path="${currentPartPath}"] .toggle-icon`)?.classList.add("expanded");
}
}
}
}
function createFolderInUpload() {
const folderName = prompt('请输入新文件夹名称：');
if (!folderName || !folderName.trim()) return;
const currentPath = document.getElementById('uploadPath')?.value || '';
const name = folderName.trim();
fetch('/mkdir', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ path: currentPath, name }),
})
.then(r => r.json())
.then(result => {
if (result.success) {
const parentPath = currentPath || '';
loadFolderTree(parentPath);
} else {
alert('创建失败: ' + (result.message || '未知错误'));
}
})
.catch(err => alert('创建失败: ' + err.message));
}
function selectFolder(path, name) {
document.getElementById('uploadPath').value = path;
document.getElementById('selectedFolderName').textContent = name;
document.querySelectorAll('.folder-tree-item').forEach(i => i.classList.remove('selected'));
document.querySelector(`.folder-tree-item[data-path="${path}"]`)?.classList.add('selected');
closeFolderTree();
}
function toggleFolderTree() {
const tree = document.getElementById('folderTree');
const header = document.querySelector('.folder-tree-header');
const icon = document.getElementById('folderTreeIcon');
if (tree.style.display === 'none') {
tree.style.display = 'block';
header?.classList.add('expanded');
if (icon) icon.style.transform = 'rotate(180deg)';
} else {
closeFolderTree();
}
}
function closeFolderTree() {
const tree = document.getElementById('folderTree');
const header = document.querySelector('.folder-tree-header');
const icon = document.getElementById('folderTreeIcon');
if (tree) tree.style.display = 'none';
header?.classList.remove('expanded');
if (icon) icon.style.transform = 'rotate(0deg)';
}
document.addEventListener('click', (e) => {
const container = document.querySelector('.folder-tree-container');
if (container && !container.contains(e.target)) closeFolderTree();
});
function initDragAndDrop() {
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
if (!uploadArea) return;
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
e.preventDefault();
uploadArea.classList.remove('dragover');
handleFiles(e.dataTransfer.files);
});
fileInput?.addEventListener('change', (e) => handleFiles(e.target.files));
}
function handleFiles(files) {
for (const file of files) {
if (!selectedFiles.find(f => f.name === file.name && f.size === file.size)) {
selectedFiles.push(file);
}
}
updateUploadList();
}
function updateUploadList() {
const list = document.getElementById('uploadList');
const uploadBtn = document.getElementById('uploadBtn');
if (!list || selectedFiles.length === 0) {
if (uploadBtn) uploadBtn.disabled = true;
return;
}
list.innerHTML = selectedFiles.map((file, index) => `
<div class="upload-item" data-index="${index}">
<i class="fas fa-file"></i>
<span class="filename" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
<span class="filesize">${formatFileSize(file.size)}</span>
<button class=\"remove-btn\" onclick=\"removeFile(${index})\" title=\"移除\">
<i class="fas fa-times"></i>
</button>
<div class="upload-progress-container" id="progress-container-${index}" style="display:none; flex:1; min-width:120px;">
<div class="upload-progress">
<div class="upload-progress-bar" id="progress-bar-${index}" style="width:0%"></div>
</div>
<div class="upload-progress-text" id="progress-text-${index}">0%</div>
</div>
</div>
`).join('');
if (uploadBtn) {
uploadBtn.disabled = false;
uploadBtn.innerHTML = '<i class=\"fas fa-upload\"></i> 开始上传';
}
}
function removeFile(index) {
selectedFiles.splice(index, 1);
updateUploadList();
}
function startUpload() {
const uploadBtn = document.getElementById('uploadBtn');
const path = document.getElementById('uploadPath')?.value || '';
if (uploadBtn) {
uploadBtn.disabled = true;
uploadBtn.innerHTML = '<i class=\"fas fa-spinner fa-spin\"></i> 上传中...';
}
selectedFiles.forEach((_, index) => {
const container = document.getElementById(`progress-container-${index}`);
const removeBtn = document.querySelector(`.upload-item[data-index="${index}"] .remove-btn`);
if (container) container.style.display = 'block';
if (removeBtn) removeBtn.style.display = 'none';
});
const files = [...selectedFiles];
let successCount = 0, failCount = 0;
let completedCount = 0;
const total = files.length;
const maxConcurrent = UPLOAD_CONFIG.concurrentMax;
let activeCount = 0;
let queueIndex = 0;
return new Promise((resolve) => {
function uploadNext() {
  if (queueIndex >= total && activeCount === 0) {
const msg = failCount === 0
? `成功上传 ${successCount} 个文件`
: `上传完成：${successCount} 个成功，${failCount} 个失败`;
setTimeout(() => {
alert(msg);
window.location.reload();
resolve();
}, 500);
return;
}
while (activeCount < maxConcurrent && queueIndex < total) {
const idx = queueIndex++;
const file = files[idx];
activeCount++;
const formData = new FormData();
formData.append('file', file);
formData.append('path', path);
const url = path ? `/upload?path=${encodeURIComponent(path)}` : '/upload';
const xhr = new XMLHttpRequest();
xhr.upload.addEventListener('progress', (e) => {
if (e.lengthComputable) {
const pct = Math.round((e.loaded / e.total) * 100);
const bar = document.getElementById(`progress-bar-${idx}`);
const text = document.getElementById(`progress-text-${idx}`);
if (bar) bar.style.width = pct + '%';
if (text) text.textContent = pct + '%';
}
});
let done = false;
function finishUpload(type, msg) {
if (done) return;
done = true;
activeCount--;
completedCount++;
if (type === 'success') {
successCount++;
const bar = document.getElementById(`progress-bar-${idx}`);
const text = document.getElementById(`progress-text-${idx}`);
if (bar) bar.style.background = 'var(--success-color, #4CAF50)';
if (text) text.textContent = '100% ✓';
} else {
failCount++;
const text = document.getElementById(`progress-text-${idx}`);
if (text) text.textContent = msg || '失败 ✗';
}
uploadNext();
}
xhr.addEventListener('load', () => {
try {
const result = JSON.parse(xhr.responseText);
if (result.success) { finishUpload('success'); }
else { finishUpload('fail', '服务器拒绝 ✗'); }
} catch (err) {
finishUpload('fail', '响应解析失败 ✗');
}
});
xhr.addEventListener('error', () => { finishUpload('fail', '网络错误 ✗'); });
xhr.addEventListener('abort', () => { finishUpload('fail', '已取消 ✗'); });
xhr.addEventListener('timeout', () => { finishUpload('fail', '超时 ✗'); });
xhr.timeout = 300000;
xhr.open('POST', url);
xhr.send(formData);
}
}
uploadNext();
});
}
function showUploadModal() {
document.getElementById('uploadModal')?.classList.add('active');
selectedFiles = [];
expandedFolders.clear();
updateUploadList();
const currentPath = document.getElementById('uploadPath')?.value ||
new URLSearchParams(window.location.search).get('path') || '';
if (currentPath) {
const parts = currentPath.split('/');
const nameEl = document.getElementById('selectedFolderName');
if (nameEl) nameEl.textContent = parts[parts.length - 1] || '根目录';
loadFolderTree('').then(() => expandToPath(currentPath));
} else {
const nameEl = document.getElementById('selectedFolderName');
if (nameEl) nameEl.textContent = '根目录';
loadFolderTree('');
}
}
function closeUploadModal() {
document.getElementById('uploadModal')?.classList.remove('active');
selectedFiles = [];
const fileInput = document.getElementById('fileInput');
if (fileInput) fileInput.value = '';
closeFolderTree();
const uploadBtn = document.getElementById('uploadBtn');
if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.innerHTML = '<i class=\"fas fa-upload\"></i> 开始上传'; }
}
let recycleBinData = [];
function showRecycleBin() {
const modal = document.getElementById('recycleBinModal');
if (!modal) return;
const listEl = document.getElementById('recycleBinList');
if (listEl) listEl.innerHTML = '<div class=\"empty-state\"><i class=\"fas fa-spinner fa-spin\"></i><p>加载中...</p></div>';
modal.classList.add('active');
fetch('/api/recycle-bin/list')
.then(r => r.json())
.then(data => {
if (data.success && data.items) {
recycleBinData = data.items;
renderRecycleBin(data.items);
} else {
if (listEl) listEl.innerHTML = `<div class=\"empty-state\"><i class=\"fas fa-trash-alt\"></i><p>${data.message || '回收站为空'}</p></div>`;
}
})
.catch(err => {
if (listEl) listEl.innerHTML = `<div class=\"empty-state\"><i class=\"fas fa-exclamation-triangle\"></i><p>加载失败: ${err.message}</p></div>`;
});
}
function closeRecycleBin() {
document.getElementById('recycleBinModal')?.classList.remove('active');
recycleBinData = [];
}
function renderRecycleBin(files) {
const listEl = document.getElementById('recycleBinList');
if (!listEl) return;
if (!files || files.length === 0) {
listEl.innerHTML = '<div class=\"empty-state\"><i class=\"fas fa-trash-alt\"></i><p>回收站为空</p></div>';
return;
}
listEl.innerHTML = `
<table class="file-table">
<thead>
<tr>
<th class=\"col-name\">原路径</th>
<th class=\"col-date\">删除时间</th>
<th class=\"col-actions\">操作</th>
</tr>
</thead>
<tbody>
${files.map((item, index) => `
<tr class="file-row">
<td class="col-name">
<span class="file-link">
<i class="fas fa-${item.type === 'folder' ? 'folder' : 'file'} file-icon ${item.type === 'folder' ? 'folder-icon' : ''}"></i>
<span class="file-name" title="${escapeHtml(item.originalPath || item.name || '')}">${escapeHtml(item.originalPath || item.name || '')}</span>
</span>
</td>
<td class="col-date">${formatDateTime(item.modified || '')}</td>
<td class="col-actions">
<button class=\"action-btn\" onclick=\"restoreRecycleItem(${index})\" title=\"恢复\">
<i class="fas fa-undo"></i>
</button>
</td>
</tr>
`).join('')}
</tbody>
</table>
`;
}
function restoreRecycleItem(index) {
const item = recycleBinData[index];
if (!item) return;
const name = item.originalPath || item.name || '';
if (!confirm(`确定要恢复 \"${name}\" 吗？`)) return;
fetch('/api/recycle-bin/restore', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ path: item.path || item.name }),
})
.then(r => r.json())
.then(data => {
if (data.success) {
recycleBinData.splice(index, 1);
renderRecycleBin(recycleBinData);
if (recycleBinData.length === 0) closeRecycleBin();
setTimeout(() => window.location.reload(), 300);
} else {
alert('恢复失败: ' + (data.message || '未知错误'));
}
})
.catch(err => alert('恢复失败: ' + err.message));
}
function clearRecycleBin() {
if (!confirm('确定要清空回收站吗？此操作不可恢复。')) return;
fetch('/api/recycle-bin/empty', { method: 'POST' })
.then(r => r.json())
.then(data => {
if (data.success) {
recycleBinData = [];
renderRecycleBin([]);
closeRecycleBin();
setTimeout(() => window.location.reload(), 300);
} else {
alert('清空失败: ' + (data.message || '未知错误'));
}
})
.catch(err => alert('清空失败: ' + err.message));
}
function shareItem(filePath) {
const modal = document.getElementById('shareLinkModal');
if (!modal) return;
const linkInput = document.getElementById('shareLinkInput');
const expireInfo = document.getElementById('shareLinkExpire');
const copyBtn = document.getElementById('shareLinkCopyBtn');
if (linkInput) linkInput.value = '生成中...';
if (expireInfo) expireInfo.textContent = '';
if (copyBtn) copyBtn.disabled = true;
modal.classList.add('active');
const expireSelect = document.getElementById('shareExpireSelect');
const selectedHours = expireSelect ? parseInt(expireSelect.value) : 24;
fetch('/api/share', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ path: filePath, expireHours: selectedHours }),
})
.then(r => r.json())
.then(data => {
if (data.success && data.url) {
if (linkInput) linkInput.value = data.url;
if (expireInfo) expireInfo.textContent = data.expiresAt
? `截止时间: ${formatDateTime(data.expiresAt)}`
: (data.expireHours ? `有效期: ${data.expireHours} 小时` : '');
if (copyBtn) copyBtn.disabled = false;
} else {
if (linkInput) linkInput.value = '生成失败: ' + (data.message || '未知错误');
}
})
.catch(err => {
if (linkInput) linkInput.value = '网络错误: ' + err.message;
});
}
function closeShareLinkModal() {
document.getElementById('shareLinkModal')?.classList.remove('active');
}
function copyShareLink() {
const input = document.getElementById('shareLinkInput');
if (!input || !input.value) return;
input.select();
input.setSelectionRange(0, 99999);
try {
document.execCommand('copy');
const btn = document.getElementById('shareLinkCopyBtn');
if (btn) {
const orig = btn.innerHTML;
btn.innerHTML = '<i class=\"fas fa-check\"></i> 已复制';
setTimeout(() => { btn.innerHTML = orig; }, 2000);
}
} catch (err) {
alert('复制失败，请手动复制');
}
}
function showNewFolderModal() {
document.getElementById('newFolderModal')?.classList.add('active');
const nameInput = document.getElementById('folderName');
if (nameInput) { nameInput.value = ''; nameInput.focus(); }
}
function closeNewFolderModal() {
document.getElementById('newFolderModal')?.classList.remove('active');
}
function showChangePasswordModal() {
const modal = document.getElementById('changePasswordModal');
if (modal) {
modal.classList.add('active');
const oldPwd = document.getElementById('oldPassword');
if (oldPwd) {
oldPwd.value = '';
oldPwd.focus();
}
const newPwd = document.getElementById('newPassword');
if (newPwd) newPwd.value = '';
const confirmPwd = document.getElementById('confirmPassword');
if (confirmPwd) confirmPwd.value = '';
hideChangePasswordMessage();
}
}
function closeChangePasswordModal() {
document.getElementById('changePasswordModal')?.classList.remove('active');
}
function showChangePasswordMessage(type, text) {
const msgEl = document.getElementById('changePasswordMessage');
if (!msgEl) return;
msgEl.className = 'form-message form-message-' + type;
msgEl.innerHTML = '<i class="fas fa-' + (type === 'success' ? 'check-circle' : 'exclamation-circle') + '"></i> ' + escapeHtml(text);
msgEl.style.display = 'block';
}
function hideChangePasswordMessage() {
const msgEl = document.getElementById('changePasswordMessage');
if (msgEl) msgEl.style.display = 'none';
}
async function submitChangePassword() {
const oldPwd = document.getElementById('oldPassword')?.value;
const newPwd = document.getElementById('newPassword')?.value;
const confirmPwd = document.getElementById('confirmPassword')?.value;
const btn = document.getElementById('changePasswordBtn');
if (!oldPwd || !newPwd || !confirmPwd) {
showChangePasswordMessage('error', '所有字段都必须填写');
return;
}
if (newPwd.length < 6) {
showChangePasswordMessage('error', '新密码至少6个字符');
return;
}
if (newPwd !== confirmPwd) {
showChangePasswordMessage('error', '两次输入的新密码不一致');
return;
}
if (oldPwd === newPwd) {
showChangePasswordMessage('error', '新密码不能与旧密码相同');
return;
}
try {
const response = await fetch('/api/change-password', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
oldPassword: oldPwd,
newPassword: newPwd,
confirmPassword: confirmPwd
}),
});
const result = await response.json();
  if (result.success) {
    showChangePasswordMessage('success', result.message || '密码修改成功');
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    setTimeout(() => {
      closeChangePasswordModal();
      window.location.reload();
    }, 3000);
} else {
showChangePasswordMessage('error', result.message || '修改失败');
}
} catch (err) {
showChangePasswordMessage('error', '网络错误：' + err.message);
} finally {
if (btn) { btn.disabled = false; btn.innerHTML = '<i class=\"fas fa-check\"></i> 确认修改'; }
}
}
document.addEventListener('DOMContentLoaded', () => {
['oldPassword', 'newPassword', 'confirmPassword'].forEach(id => {
const el = document.getElementById(id);
if (el) {
el.addEventListener('keydown', (e) => {
if (e.key === 'Enter') { e.preventDefault(); submitChangePassword(); }
});
}
});
});
async function createFolder() {
const name = document.getElementById('folderName')?.value.trim();
if (!name) { alert('请输入文件夹名称'); return; }
const currentPath = new URLSearchParams(window.location.search).get('path') || '';
try {
const response = await fetch('/mkdir', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ path: currentPath, name }),
});
const result = await response.json();
if (result.success) {
alert('文件夹创建成功');
window.location.reload();
} else {
alert('创建失败: ' + result.message);
}
} catch (err) {
alert('创建失败: ' + err.message);
}
}
let selectedItems = new Set();
function toggleItemSelection(path, type) {
const key = `${type}:${path}`;
if (selectedItems.has(key)) {
selectedItems.delete(key);
} else {
selectedItems.add(key);
}
updateSelectionUI();
}
function updateSelectionUI() {
const count = selectedItems.size;
const batchDeleteBtn = document.getElementById('batchDeleteBtn');
const selectionCount = document.getElementById('selectionCount');
document.querySelectorAll('.file-row').forEach(row => {
const path = row.dataset.path;
const type = row.dataset.type;
const key = `${type}:${path}`;
row.classList.toggle('selected', selectedItems.has(key));
});
const batchActions = document.getElementById('batchActions');
if (batchActions) batchActions.style.display = count > 0 ? 'flex' : 'none';
if (batchDeleteBtn) batchDeleteBtn.style.display = count > 0 ? 'inline-flex' : 'none';
if (selectionCount) selectionCount.textContent = count > 0 ? `已选择 ${count} 项` : '';
}
function clearSelection() {
selectedItems.clear();
document.querySelectorAll('.file-row input[type=checkbox]').forEach(cb => cb.checked = false);
const selAll = document.getElementById('selectAll');
if (selAll) selAll.checked = false;
updateSelectionUI();
}
async function batchDelete() {
if (selectedItems.size === 0) return;
const items = Array.from(selectedItems).map(key => {
const [type, path] = key.split(':');
return { type, path };
});
const fileCount = items.filter(i => i.type === 'file').length;
const folderCount = items.filter(i => i.type === 'folder').length;
const msg = `确定要删除选中的 ${items.length} 个项目（${fileCount} 个文件，${folderCount} 个文件夹）吗？此操作不可恢复。`;
if (!confirm(msg)) return;
try {
const response = await fetch('/delete', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ paths: items.map(i => i.path) }),
});
const result = await response.json();
if (result.success) {
alert(result.message);
selectedItems.clear();
window.location.reload();
} else {
alert('删除失败: ' + result.message);
}
} catch (err) {
alert('删除失败: ' + err.message);
}
}
async function deleteItem(itemPath, type) {
const typeName = type === 'folder' ? '文件夹' : '文件';
if (!confirm(`确定要删除${typeName} \"${itemPath.split('/').pop()}\" 吗？此操作不可恢复。`)) {
return;
}
try {
const response = await fetch('/delete', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ path: itemPath }),
});
const result = await response.json();
alert(result.success ? '删除成功' : '删除失败: ' + result.message);
if (result.success) window.location.reload();
} catch (err) {
alert('删除失败: ' + err.message);
}
}
function isPreviewable(ext) {
return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
'.pdf', '.txt', '.md', '.mp4', '.webm', '.mp3', '.wav', '.ogg'].includes(ext);
}
function previewItem(path, ext) {
const previewableExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
const audioExts = ['.mp3', '.wav', '.ogg'];
if (previewableExts.includes(ext)) {
previewImage(path);
} else if (audioExts.includes(ext)) {
previewAudio(path);
} else if (ext === '.pdf' || ext === '.txt' || ext === '.md') {
previewDocument(path);
} else {
downloadItem(null, path);
}
}
function previewImage(path) {
const modal = document.getElementById('previewModal');
const img = document.getElementById('previewImage');
if (img) img.src = '/preview/' + path;
modal?.classList.add('active');
}
function previewAudio(path) {
const modal = document.getElementById('audioPreviewModal');
const audio = document.getElementById('previewAudio');
if (audio) {
audio.src = '/preview/' + path;
audio.controls = true;
}
modal?.classList.add('active');
}
function previewDocument(path) {
const modal = document.getElementById('docPreviewModal');
const iframe = document.getElementById('docPreviewFrame');
if (iframe) {
iframe.src = '/preview/' + path;
const ext = path.split('.').pop().toLowerCase();
if (ext === 'pdf') {
iframe.style.display = 'block';
}
}
modal?.classList.add('active');
}
function closePreview() {
document.getElementById('previewModal')?.classList.remove('active');
const img = document.getElementById('previewImage');
if (img) img.src = '';
const audioModal = document.getElementById('audioPreviewModal');
audioModal?.classList.remove('active');
const audio = document.getElementById('previewAudio');
if (audio) { audio.pause(); audio.src = ''; }
const docModal = document.getElementById('docPreviewModal');
docModal?.classList.remove('active');
const iframe = document.getElementById('docPreviewFrame');
if (iframe) iframe.src = 'about:blank';
}
function formatFileSize(bytes) {
if (bytes === 0) return '0 B';
const k = 1024;
const sizes = ['B', 'KB', 'MB', 'GB'];
const i = Math.floor(Math.log(bytes) / Math.log(k));
return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function formatDateTime(dateStr) {
const d = new Date(dateStr);
return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function getFileIcon(ext) {
const iconMap = {
'.pdf': 'file-pdf', '.doc': 'file-word', '.docx': 'file-word',
'.xls': 'file-excel', '.xlsx': 'file-excel', '.ppt': 'file-powerpoint', '.pptx': 'file-powerpoint',
'.txt': 'file-alt', '.md': 'file-alt',
'.jpg': 'file-image', '.jpeg': 'file-image', '.png': 'file-image', '.gif': 'file-image',
'.webp': 'file-image', '.bmp': 'file-image', '.svg': 'file-image',
'.mp4': 'file-video', '.webm': 'file-video', '.avi': 'file-video', '.mkv': 'file-video',
'.mp3': 'file-audio', '.wav': 'file-audio', '.ogg': 'file-audio', '.flac': 'file-audio',
'.zip': 'file-archive', '.rar': 'file-archive', '.7z': 'file-archive', '.tar': 'file-archive',
'.js': 'file-code', '.html': 'file-code', '.css': 'file-code', '.py': 'file-code',
'.java': 'file-code', '.cpp': 'file-code', '.go': 'file-code',
'.exe': 'application', '.msi': 'application',
};
return iconMap[ext] || 'file';
}
function escapeHtml(text) {
const div = document.createElement('div');
div.textContent = text;
return div.innerHTML;
}
document.addEventListener('keydown', (e) => {
if (e.key === 'Escape') {
closeUploadModal();
closeNewFolderModal();
closePreview();
closeFolderTree();
closeRecycleBin();
closeShareLinkModal();
}
if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
e.preventDefault();
document.getElementById('searchInput')?.focus();
}
});
document.querySelectorAll('.modal').forEach(modal => {
modal.addEventListener('click', (e) => {
if (e.target === modal) {
modal.classList.remove('active');
if (modal.id === 'previewModal') { const img = document.getElementById('previewImage'); if (img) img.src = ''; }
if (modal.id === 'audioPreviewModal') { const audio = document.getElementById('previewAudio'); if (audio) { audio.pause(); audio.src = ''; } }
if (modal.id === 'docPreviewModal') { const iframe = document.getElementById('docPreviewFrame'); if (iframe) iframe.src = 'about:blank'; }
if (modal.id === 'recycleBinModal') { recycleBinData = []; }
}
});
});

/* ===== 移动端交互修复 v4 ===== */
// 整行点击切换目录：仅文件夹行生效；锚点/按钮/复选框走各自逻辑
function handleFileRowClick(e) {
  var row = e.currentTarget;
  if (!row || !row.classList || !row.classList.contains('file-row')) return;
  if (e.target.closest && e.target.closest('a, button, input, label, .col-select')) return;
  if (row.dataset.type !== 'folder' || !row.dataset.path) return;
  window.location.href = '/?path=' + encodeURIComponent(row.dataset.path);
}

// 下载不跳页：写入隐藏 iframe，移动端点完仍停在当前目录
function downloadItem(e, path) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (!path) return false;
  var frame = document.getElementById('downloadFrame');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = 'downloadFrame';
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(frame);
  }
  frame.src = '/download/' + String(path).replace(/^\/+/, '');
  return false;
}

// 捕获阶段兜底：目录整行点击（即使模板被 view cache 缓存、行上没有内联处理器也生效）
document.addEventListener('click', function (e) {
  var row = e.target.closest && e.target.closest('tr.file-row');
  if (!row || row.dataset.type !== 'folder' || !row.dataset.path) return;
  if (row.getAttribute('onclick')) return; // 模板已挂内联处理器时交给它
  if (e.target.closest('a, button, input, label, .col-select, .col-actions')) return;
  e.preventDefault();
  window.location.href = '/?path=' + encodeURIComponent(row.dataset.path);
}, true);

// 捕获阶段兜底：任何未挂内联处理器的 /download/ 链接都不再整页跳转
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a[href^="/download/"]');
  if (!a || a.dataset.downloadPath) return;
  if ((a.getAttribute('onclick') || '').indexOf('downloadItem') >= 0) return; // 同上
  e.preventDefault();
  downloadItem(null, a.getAttribute('href').replace(/^\/download\//, ''));
}, true);
