// Tìm đường dẫn thật của file đã lưu vào "thư mục tự chọn" (File System Access không cho biết đường dẫn).
// Chỉ biết tên thư mục, tên file và dung lượng: thử các vị trí đã biết trước, rồi quét có giới hạn các ổ đĩa.
const { t } = require('../lib/i18n.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKIP = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'appdata', 'node_modules',
  'system volume information', 'recovery', 'msocache', 'perflogs', '$recycle.bin', '$windows.~bt', '$windows.~ws', 'windowsapps']);
const plainName = (s) => typeof s === 'string' && s.length > 0 && s.length < 260 && !/[\\/\0\r\n"]/.test(s) && s !== '.' && s !== '..';

function matchFile(dir, name, size) {
  try {
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    return st.isFile() && (!size || st.size === size) ? file : null;
  } catch { return null; }
}
function defaultRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; try { fs.accessSync(d); roots.push(d); } catch { /* không có ổ */ } }
  } else roots.push('/');
  return roots;
}
// folder: tên thư mục (handle.name), hoặc "D:\" nếu chọn cả ổ. names: [{name,size}]. hints: thư mục đã tìm thấy trước đây.
function locate({ folder, files, hints = [], roots = defaultRoots(), home = os.homedir(), budgetMs = 6000, maxDepth = 5 }) {
  const list = (files || []).filter((f) => f && plainName(f.name)).map((f) => ({ name: f.name, size: Number(f.size) || 0 }));
  if (!list.length) throw new Error(t('thieu_ten_file_da_5me8'));
  const found = (dir) => { for (const f of list) { const file = matchFile(dir, f.name, f.size); if (file) return file; } return null; };
  const drive = /^([A-Za-z]):\\?$/.exec(folder || '');
  if (drive) return found(`${drive[1].toUpperCase()}:\\`);
  if (!plainName(folder)) throw new Error(t('ten_thu_muc_khong_xw6k'));
  const want = folder.toLowerCase();
  const sameName = (dir) => path.basename(dir).toLowerCase() === want;
  // Gợi ý lấy từ storage của tiện ích (content script ghi được): chỉ nhận đường dẫn trên ổ đĩa cục bộ, không nhận
  // đường dẫn mạng \\máy\chia-sẻ – Windows sẽ kết nối SMB và có thể gửi thông tin đăng nhập NTLM (SEC-008)
  const localPath = (h) => (process.platform === 'win32' || path.sep === '\\' ? /^[A-Za-z]:[\\/]/.test(h) : path.isAbsolute(h) && !/^[\\/]{2}/.test(h));
  for (const h of hints) if (typeof h === 'string' && localPath(h) && sameName(h)) { const f = found(h); if (f) return f; }
  const quick = [...roots.map((r) => path.join(r, folder)), path.join(home, folder),
    ...['Videos', 'Downloads', 'Desktop', 'Documents', 'Music', 'Pictures', 'OneDrive'].map((d) => path.join(home, d, folder))];
  for (const d of quick) { const f = found(d); if (f) return f; }
  // Quét theo chiều rộng, giới hạn độ sâu và thời gian
  const deadline = Date.now() + budgetMs;
  const queue = roots.map((r) => [r, 0]);
  while (queue.length && Date.now() < deadline) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const lower = e.name.toLowerCase();
      const full = path.join(dir, e.name);
      if (lower === want) { const f = found(full); if (f) return f; }
      if (depth + 1 < maxDepth && !SKIP.has(lower) && !e.name.startsWith('.') && !e.name.startsWith('$')) queue.push([full, depth + 1]);
    }
  }
  return null;
}
module.exports = { locate };
