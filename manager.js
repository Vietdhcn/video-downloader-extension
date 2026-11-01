// Video Catcher – trình tải (giống hộp thoại tải của IDM)
// HLS (thường / live / AES-128 / tiếng riêng), DASH, file lớn tải nhiều luồng; ghép hình + tiếng thành 1 file MP4.

const SEG_CONCURRENCY = 16;   // nhiều kết nối để tận dụng băng thông khi CDN giới hạn từng request
let jobConcurrency = 5;      // mặc định tải tối đa năm video cùng lúc
const NETWORK_CONCURRENCY = 16; // ngân sách chung cho tất cả video, không nhân theo số mục
const MAX_AHEAD = 40;          // không tải vượt quá N đoạn so với đoạn đang chờ ghép (giới hạn RAM)
const RETRIES = 5;
const CHUNK = 4 * 1024 * 1024; // file lớn: chia khúc 4 MB
const CHUNK_CONCURRENCY = 8;

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
};

const jobs = [];
const seenIds = new Set();
const HISTORY_MAX = 200;
const INTERRUPTED = VCI18n.t('bi_gian_doan_vi_ul6v');
const YT_BROWSER_CONCURRENCY = 2; // mỗi lượt YouTube trong trình duyệt mở một tab phát video
// Cổng dữ liệu từ tab thu YouTube: tên cổng = vc-yt:<id tác vụ>:<token ngẫu nhiên>
const ytPorts = new Map();
chrome.runtime.onConnect?.addListener((port) => {
  const handler = ytPorts.get(port.name);
  if (handler) handler(port);
});
function fromBase64(text) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}
function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
function sanitize(name) {
  const out = (name || 'video')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // ký tự đảo chiều chữ giả đuôi file khi hiển thị
    .replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'video';
  // Tên dành riêng của Windows (CON, NUL, COM1…): không tạo được file -> thêm dấu _
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(out) ? `_${out}` : out;
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(abortErr()); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
});
const abortErr = () => new DOMException(VCI18n.t('da_huy_1ltx'), 'AbortError');

// Máy trong mạng nội bộ / chính máy này: chỉ gửi request tới đó khi trang nguồn của mục tải cũng nằm trong mạng
// nội bộ (vd Jellyfin trên NAS). Playlist của trang công khai không được khiến Trình tải gửi request kèm cookie
// tới router, NAS, dịch vụ localhost. Chỉ tải link http(s) (SEC-005). Giữ giống isPrivateHost trong background.js.
function isPrivateHost(host) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || /\.(localhost|local|lan|internal|intranet|home\.arpa)$/.test(host)) return true;
  if (host.includes(':')) return host === '::' || host === '::1' || /^(f[cd]|fe[89ab])/.test(host) || host.startsWith('::ffff:');
  if (!host.includes('.')) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]), b = Number(v4[2]);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return (/^[a-z][\w+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(String(u || '')) || [])[1] || ''; } };
function checkNet(url, page) {
  if (/^[a-z][\w+.-]*:/i.test(String(url || '')) && !/^https?:\/\//i.test(url)) throw Object.assign(new Error(VCI18n.t('link_khong_phai_http_xs01')), { noRetry: true });
  if (/^https?:/i.test(String(url || '')) && isPrivateHost(hostOf(url)) && !(/^https?:/i.test(String(page || '')) && isPrivateHost(hostOf(page)))) {
    throw Object.assign(new Error(VCI18n.t('khong_tai_tu_dia_12jo')), { noRetry: true });
  }
}

// Tạm dừng một lượt tải: chặn request mới và ngắt request đang chạy; khi tiếp tục, đoạn bị ngắt
// được tải lại (không tính là một lần thử lỗi), các đoạn đã xong được giữ nguyên.
class Gate {
  constructor(page = '') { this.page = page; this.paused = false; this.waiters = []; this.ctrl = new AbortController(); }
  pause() { if (this.paused) return; this.paused = true; this.ctrl.abort(); }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.ctrl = new AbortController();
    this.waiters.splice(0).forEach((wake) => wake());
  }
  wait(signal) {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortErr()); return; }
      const abort = () => { const i = this.waiters.indexOf(wake); if (i >= 0) this.waiters.splice(i, 1); reject(abortErr()); };
      const wake = () => { signal?.removeEventListener('abort', abort); resolve(); };
      this.waiters.push(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

let networkActive = 0;
const networkQueue = [];
function acquireNetwork(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortErr()); return; }
    const entry = { start: () => {
      signal.removeEventListener('abort', abort);
      networkActive++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        networkActive--;
        networkQueue.shift()?.start();
      });
    } };
    const abort = () => {
      const index = networkQueue.indexOf(entry);
      if (index >= 0) networkQueue.splice(index, 1);
      reject(abortErr());
    };
    if (networkActive < NETWORK_CONCURRENCY) entry.start();
    else { networkQueue.push(entry); signal.addEventListener('abort', abort, { once: true }); }
  });
}

// ---------- Bộ đệm trên đĩa (spool) ----------
// Dữ liệu tải về được ghi dần vào file tạm trong Origin Private File System của tiện ích thay vì giữ
// trong RAM. Ghi theo vị trí nên các khúc tải song song có thể tới không theo thứ tự. Chỉ đọc lại
// được sau finalize() (FileSystemWritableFileStream chỉ chốt dữ liệu khi đóng); khi đó File trả về
// nằm trên đĩa và các lát cắt (slice) của nó được ghép thành file kết quả mà không nạp vào RAM.
// Mỗi file tạm được giữ một Web Lock; lúc mở Trình tải, file không còn ai giữ khóa sẽ bị dọn.
const SPOOL_DIR = 'vc-spool';
const SPOOL_BACKLOG = 32 * 1024 * 1024; // dữ liệu chờ ghi tối đa trước khi bắt bộ tải chờ đĩa
const spoolLockName = (name) => `vc-spool:${name.replace(/\.crswap$/, '')}`;
function holdLock(name) {
  return new Promise((resolve, reject) => {
    navigator.locks.request(name, () => new Promise((release) => resolve(release))).catch(reject);
  });
}
class SpoolRef {
  constructor(spool, offset, length) { Object.assign(this, { spool, offset, length }); }
  get size() { return this.length; }
  resolve() { return this.spool.slice(this.offset, this.length); }
}
class Spool {
  static async open(tag) {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
    let release;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(SPOOL_DIR, { create: true });
      const name = `${String(tag).replace(/[^\w-]/g, '_')}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.bin`;
      release = await holdLock(spoolLockName(name));
      const handle = await dir.getFileHandle(name, { create: true });
      const writer = await handle.createWritable({ keepExistingData: false });
      return new Spool(dir, name, handle, writer, release);
    } catch {
      if (release) release();
      return null; // không có bộ nhớ riêng: quay về giữ dữ liệu như trước
    }
  }
  constructor(dir, name, handle, writer, release) {
    Object.assign(this, { dir, name, handle, writer, release, size: 0, queued: 0, pending: Promise.resolve(), error: null, file: null, closed: false });
  }
  reserve(length) { const offset = this.size; this.size += length; return offset; }
  write(position, data) {
    if (this.file || this.closed) throw new Error(VCI18n.t('bo_dem_dia_da_1g22'));
    const n = data.byteLength ?? data.size ?? 0;
    this.queued += n;
    this.pending = this.pending
      .then(() => (this.error ? null : this.writer.write({ type: 'write', position, data })))
      .then(() => { this.queued -= n; }, (error) => { this.error = this.error || error; this.queued -= n; });
  }
  append(parts) {
    const length = parts.reduce((n, p) => n + (p.byteLength ?? p.size ?? 0), 0);
    const offset = this.reserve(length);
    this.write(offset, parts.length === 1 ? parts[0] : new Blob(parts));
    return new SpoolRef(this, offset, length);
  }
  async drain(limit = SPOOL_BACKLOG) {
    if (this.queued > limit) await this.pending;
    if (this.error) throw this.error;
  }
  async finalize() {
    if (!this.file) {
      await this.pending;
      if (this.error) throw this.error;
      await this.writer.close();
      this.file = await this.handle.getFile();
    }
    return this.file;
  }
  slice(offset, length) {
    if (!this.file) throw new Error(VCI18n.t('bo_dem_dia_chua_135m'));
    return this.file.slice(offset, offset + length);
  }
  async discard() {
    if (this.closed) return;
    this.closed = true;
    try { if (!this.file) await this.writer.abort(); } catch { /* đã đóng */ }
    try { await this.dir.removeEntry(this.name); } catch { /* đã xóa */ }
    this.release();
  }
}
const resolveRef = (x) => (x && typeof x.resolve === 'function' ? x.resolve() : x);
// Dọn file tạm của các lần mở Trình tải trước (đóng cửa sổ giữa chừng, trình duyệt tắt…)
async function cleanupSpools() {
  try {
    if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(SPOOL_DIR, { create: true });
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    for (const name of names) {
      await navigator.locks.request(spoolLockName(name), { ifAvailable: true }, async (lock) => {
        if (lock) await dir.removeEntry(name).catch(() => {});
      });
    }
  } catch { /* bỏ qua */ }
}

// ---------- mạng ----------
async function fetchBytes(url, range, signal, onBytes, opts = {}) {
  checkNet(url, opts.page ?? opts.gate?.page);
  let lastErr;
  // Tải nguyên file một luồng (opts.resumable): mất kết nối hoặc tạm dừng giữa chừng thì giữ phần đã
  // nhận và xin tiếp phần còn lại (Range: bytes=n-) thay vì tải lại từ đầu.
  // Cả khúc có khoảng byte (file chia khúc, đoạn HLS) cũng tải tiếp được: xin phần còn lại của khúc (ISSUE-001)
  const resumable = !!opts.resumable && !opts.rangeParam;
  let kept = [], keptLen = 0;
  const dropKept = () => { if (keptLen && onBytes) onBytes(-keptLen); kept = []; keptLen = 0; };
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (signal.aborted) throw abortErr();
    if (opts.gate) await opts.gate.wait(signal);
    const release = await acquireNetwork(signal);
    if (signal.aborted) { release(); throw abortErr(); }
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    const pauseSignal = opts.gate?.ctrl.signal;
    pauseSignal?.addEventListener('abort', abort, { once: true });
    if (pauseSignal?.aborted) request.abort();
    let timer, timedOut = false, reader, received = 0;
    let chunks = [];
    const watch = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; request.abort(); }, ms);
    };
    watch(opts.connectTimeoutMs ?? 30000);
    try {
      const headers = range && !opts.rangeParam ? { Range: `bytes=${range.offset + keptLen}-${range.offset + range.length - 1}` }
        : resumable && keptLen ? { Range: `bytes=${keptLen}-` } : {};
      let u = url;
      if (range && opts.rangeParam) u += `${u.includes('?') ? '&' : '?'}range=${range.offset}-${range.offset + range.length - 1}`;
      const res = await fetch(u, { method: opts.method || 'GET', headers, credentials: 'include', cache: 'no-store', signal: request.signal });
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      if (range && res.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(res.headers.get('content-range') || '');
        if (!match || Number(match[1]) !== range.offset + keptLen || Number(match[2]) !== range.offset + range.length - 1) {
          res.body?.cancel().catch(() => {});
          throw Object.assign(new Error(VCI18n.t('may_chu_tra_sai_1k9t')), { noRetry: true });
        }
      }
      if (range && opts.strictRange && res.status !== 206 && !opts.rangeParam) {
        res.body?.cancel().catch(() => {});
        throw Object.assign(new Error(VCI18n.t('may_chu_khong_con_19tu')), { rangeUnsupported: true, noRetry: true });
      }
      if (resumable && keptLen) {
        const start = /^bytes (\d+)-/i.exec(res.headers.get('content-range') || '');
        if (res.status !== 206 || !start || Number(start[1]) !== (range ? range.offset : 0) + keptLen) dropKept(); // máy chủ gửi lại từ đầu
      }
      reader = res.body.getReader();
      // Biết trước dung lượng -> ghi thẳng vào 1 bộ đệm (không gom mảnh rồi copy lần nữa)
      const len = res.headers.get('content-encoding') || resumable ? 0 : Number(res.headers.get('content-length')) || 0;
      let buf = len ? new Uint8Array(len) : null;
      let total = 0;
      for (;;) {
        watch(opts.idleTimeoutMs ?? 15000); // làm mới khi có dữ liệu, không giới hạn tổng thời gian tải
        const { value, done } = await reader.read();
        if (done) break;
        if (buf && total + value.length <= buf.length) buf.set(value, total);
        else {
          if (buf) { chunks.push(buf.subarray(0, total)); buf = null; }
          chunks.push(value);
        }
        total += value.length;
        received += value.length;
        if (onBytes) onBytes(value.length);
      }
      if (buf) buf = total === buf.length ? buf : buf.subarray(0, total);
      else {
        const all = kept.concat(chunks);
        buf = new Uint8Array(keptLen + total);
        let o = 0;
        for (const c of all) { buf.set(c, o); o += c.length; }
        kept = []; keptLen = 0;
      }
      // HLS BYTERANGE vẫn dùng được khi máy chủ trả toàn bộ tài nguyên.
      if (range && res.status === 200 && !opts.rangeParam) buf = buf.slice(range.offset, range.offset + range.length);
      if (range && buf.length !== range.length) throw new Error(VCI18n.t('doan_tai_bi_thieu_1g0s'));
      return buf;
    } catch (e) {
      const paused = !signal.aborted && !timedOut && pauseSignal?.aborted;
      if (resumable && received && !signal.aborted && !e.noRetry) { kept.push(...chunks); keptLen += received; } // giữ để tải tiếp
      else if (onBytes && received) onBytes(-received); // lượt lỗi sẽ tải lại; không cộng trùng vào %/ETA
      if (paused) { attempt--; continue; } // tạm dừng: chờ rồi tải lại / tải tiếp đoạn này
      if (signal.aborted || (e.name === 'AbortError' && !timedOut)) { dropKept(); throw e; } // huỷ thật: bỏ phần đã giữ khỏi tiến độ
      lastErr = timedOut ? new Error(VCI18n.t('may_chu_khong_gui_dt2e')) : e;
      if (e.noRetry || e.status === 404 || e.status === 410 || (e.status === 403 && attempt >= 1)) break;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      pauseSignal?.removeEventListener('abort', abort);
      reader?.cancel().catch(() => {});
      release();
    }
    if (attempt + 1 < RETRIES) {
      opts.onRetry?.(lastErr, url);
      await sleep((opts.retryDelayMs ?? 800) * (attempt + 1), signal);
    }
  }
  dropKept();
  throw lastErr || new Error(VCI18n.t('tai_that_bai_13wq'));
}

// Trang lỗi (HTML) hoặc dữ liệu quá ít so với dung lượng đã biết: thường do link hết hạn / tab nguồn đã đóng
function checkWhole(buf, size) {
  const head = new TextDecoder().decode(buf.subarray(0, 64)).trimStart().toLowerCase();
  if (buf.length < 2e6 && (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('{"error') || head.startsWith('<?xml'))) {
    throw new Error(VCI18n.t('may_chu_tra_ve_49kz'));
  }
  if (size && buf.length < size * 0.9) throw new Error(VCI18n.t('may_chu_chi_tra_1bzx', [fmtSize(buf.length), fmtSize(size)]));
  return buf;
}

async function fetchManifest(url, signal, page) {
  checkNet(url, page);
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal.aborted) throw abortErr();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30000);
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) { res.body?.cancel().catch(() => {}); throw Object.assign(new Error(VCI18n.t('khong_tai_duoc_playlist_1s99', [res.status])), { status: res.status }); }
    return { text: await res.text(), base: res.url || url };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
async function fetchText(url, signal, page) {
  return (await fetchManifest(url, signal, page)).text;
}

// Dung lượng + server có hỗ trợ Range không
async function probeSize(url, signal, opts = {}) {
  // Hỏi lỗi / quá lâu thì hỏi lại một lần: nếu không, file lớn bị tải một luồng (chậm, dễ đứt)
  const first = await probeOnce(url, signal, opts, 10000);
  if (first.size || first.rangeOk || !first.failed) return first;
  return probeOnce(url, signal, opts, 20000);
}
async function probeOnce(url, signal, opts, ms) {
  checkNet(url, opts.page);
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal.aborted) throw abortErr();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ms);
  try {
    if (opts.rangeParam) {
      const res = await fetch(url, { method: 'HEAD', credentials: 'include', signal: ctrl.signal });
      const n = Number(res.headers.get('content-length'));
      return { size: res.ok && n ? n : 0, rangeOk: true };
    }
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', cache: 'no-store', signal: ctrl.signal });
    const cr = res.headers.get('content-range') || '';
    const m = /\/(\d+)\s*$/.exec(cr);
    if (res.body) res.body.cancel().catch(() => {});
    if (res.status === 206 && /^bytes 0-0\//i.test(cr) && m) return { size: Number(m[1]), rangeOk: true };
    return { size: Number(res.headers.get('content-length')) || 0, rangeOk: false };
  } catch (e) {
    if (signal.aborted) throw e;
    return { size: 0, rangeOk: false, failed: true };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

// File lớn: chia khúc tải song song (giống IDM)
async function downloadLarge(job, url, opts = {}) {
  const signal = job.ctrl.signal;
  const probe = await probeSize(url, signal, { ...opts, page: job.gate?.page ?? job.referer });
  if (signal.aborted) throw abortErr();
  const size = probe.size || opts.size || 0;
  const rangeOk = probe.rangeOk;
  job.logEvent?.(size ? VCI18n.t('dung_luong_1wgn', [fmtSize(size), !rangeOk ? VCI18n.t('may_chu_khong_cho_2oxp') : size > CHUNK ? VCI18n.t('chia_khuc_song_song_1mj7', [Math.ceil(size / CHUNK)]) : VCI18n.t('tai_mot_luong_lamn')])
    : VCI18n.t('khong_biet_dung_luong_dnwz'));
  if (size) job.byteTotal += size;
  if (!size || !rangeOk) {
    const buf = await fetchBytes(url, null, signal, (n) => job.addBytes(n), { gate: job.gate, onRetry: job.onRetry, resumable: true });
    return new Blob([checkWhole(buf, size)]);
  }
  const n = Math.ceil(size / CHUNK);
  const parts = new Array(n);
  const spool = await Spool.open(`${job.id || 'file'}-dl`);
  if (spool) (job.spools || (job.spools = [])).push(spool);
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal.addEventListener('abort', abort, { once: true });
  const before = job.bytes || 0;
  let failure;
  let i = 0;
  let chunksDone = 0;
  const hedger = new Hedger(ctrl.signal, job.hedgeMs);
  const hedgeTimer = setInterval(() => {
    if (failure) return;
    if (job.gate?.paused) { hedger.touch(); return; }
    if (i >= n) { // hết khúc mới: tải song song khúc chậm nhất
      const k = hedger.oldest();
      if (k !== null && hedger.hedge(k)) job.logEvent?.(VCI18n.t('khuc_cham_bat_thuong_7lf1', [k + 1, n]), 'warn');
    }
  }, hedgeTick(job));
  const worker = async () => {
    while (!failure && i < n) {
      const k = i++;
      const offset = k * CHUNK;
      const length = Math.min(CHUNK, size - offset);
      try {
        const bytes = await hedger.run(k, (sig) => fetchBytes(url, { offset, length }, sig, (x) => job.addBytes(x), { ...opts, strictRange: true, gate: job.gate, onRetry: job.onRetry, resumable: true }));
        if (spool) { spool.write(offset, bytes); await spool.drain(); } else parts[k] = new Blob([bytes]);
        chunksDone++;
      } catch (error) { failure = failure || error; ctrl.abort(); }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, n) }, worker)); } finally { clearInterval(hedgeTimer); }
  signal.removeEventListener('abort', abort);
  if (failure) {
    if (!failure.rangeUnsupported || signal.aborted) throw failure;
    // Đã tải được nhiều khúc rồi máy chủ mới thôi trả từng đoạn: gần như chắc chắn link đã hết hạn.
    // Báo lỗi rõ thay vì xoá tiến độ để tải lại cả file (lượt tải lại thường chỉ nhận về trang lỗi).
    if (chunksDone) throw new Error(VCI18n.t('may_chu_ngung_tra_gwzq'));
    job.addBytes(before - (job.bytes || 0));
    return new Blob([checkWhole(await fetchBytes(url, null, signal, (x) => job.addBytes(x), { ...opts, gate: job.gate, onRetry: job.onRetry, resumable: true }), size)]);
  }
  if (spool) { spool.reserve(size); return spool.finalize(); } // File nằm trên đĩa
  return new Blob(parts);
}

// ---------- AES-128 (HLS) ----------
function ivFor(seg) {
  const iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    let n = seg.seq; // mặc định IV = số thứ tự đoạn
    for (let i = 15; i >= 0 && n > 0; i--) { iv[i] = n % 256; n = Math.floor(n / 256); }
  }
  return iv;
}
async function decryptSeg(job, buf, seg, signal = job.ctrl.signal) {
  if (!job.keys) job.keys = new Map();
  if (!job.keys.has(seg.key.uri)) {
    job.keys.set(seg.key.uri, fetchBytes(seg.key.uri, null, signal, null, { page: job.referer })
      .then((k) => crypto.subtle.importKey('raw', k, 'AES-CBC', false, ['decrypt'])));
  }
  const key = await job.keys.get(seg.key.uri);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, key, buf));
}

// ---------- Đoạn chậm bất thường ----------
// Video phải ghép đúng thứ tự, nên một đoạn tải lâu bất thường (máy chủ/CDN đứng) giữ chân cả hàng: các
// luồng khác tải trước tới giới hạn rồi đứng chờ, tốc độ tụt về 0 rồi vọt lên. Khi đoạn đầu hàng (hoặc
// khúc cuối của file) chậm gấp 3 lần thường lệ, mở thêm một request cho chính đoạn đó, lấy bản về trước
// và huỷ bản còn lại. Mỗi đoạn chỉ mở thêm tối đa một lần.
const HEDGE_MS = 4000;
class Hedger {
  constructor(parentSignal, minMs = HEDGE_MS) { this.parent = parentSignal; this.min = minMs; this.flight = new Map(); this.times = []; }
  run(key, fn) {
    return new Promise((resolve, reject) => {
      const entry = { started: Date.now(), hedged: false, ctrls: [], live: 0, done: false };
      this.flight.set(key, entry);
      const start = () => {
        const c = new AbortController();
        const onParent = () => c.abort();
        if (this.parent.aborted) c.abort();
        else this.parent.addEventListener('abort', onParent, { once: true });
        entry.ctrls.push(c);
        entry.live++;
        fn(c.signal).then((value) => {
          if (entry.done) return;
          entry.done = true;
          this.flight.delete(key);
          this.times.push(Date.now() - entry.started);
          if (this.times.length > 30) this.times.shift();
          entry.ctrls.forEach((x) => { if (x !== c) x.abort(); });
          resolve(value);
        }, (error) => {
          entry.live--;
          if (entry.done || (entry.live > 0 && !this.parent.aborted)) return; // bản còn lại vẫn đang tải
          entry.done = true;
          this.flight.delete(key);
          reject(error);
        }).finally(() => this.parent.removeEventListener('abort', onParent));
      };
      entry.backup = start;
      start();
    });
  }
  limit() {
    // Cần ít nhất 2 request đã xong để biết thế nào là "chậm bất thường"; chưa có thì mạng chậm đều,
    // mở thêm request chỉ chia đôi băng thông (ISSUE-002)
    const t = this.times.slice().sort((a, b) => a - b);
    if (t.length < 2) return Infinity;
    return Math.max(this.min, t[t.length >> 1] * 3);
  }
  hedge(key) {
    const e = this.flight.get(key);
    if (!e || e.hedged || e.done || Date.now() - e.started < this.limit()) return false;
    e.hedged = true;
    e.backup();
    return true;
  }
  oldest() {
    let best = null;
    for (const [k, e] of this.flight) if (!e.hedged && (!best || e.started < best[1].started)) best = [k, e];
    return best ? best[0] : null;
  }
  touch() { const now = Date.now(); for (const e of this.flight.values()) e.started = now; } // đang tạm dừng: không tính giờ
}
const hedgeTick = (job) => Math.min(1000, Math.max(10, (job.hedgeMs ?? HEDGE_MS) / 2));

// ---------- Tải danh sách đoạn song song, ghép đúng thứ tự ----------
async function runOrdered(job, segs, consume) {
  const ctrl = new AbortController();
  const parent = job.ctrl.signal;
  const abort = () => ctrl.abort();
  if (parent.aborted) throw abortErr();
  parent.addEventListener('abort', abort, { once: true });
  const ready = new Map();
  let readyBytes = 0;
  let next = 0;
  let cursor = 0;
  let stopAt = segs.length;
  let failed = null;
  const wake = [];
  const notify = () => { while (wake.length) wake.shift()(); };
  const fail = (error) => { failed = failed || error; ctrl.abort(); notify(); };
  const hedger = new Hedger(ctrl.signal, job.hedgeMs);
  const hedgeTimer = setInterval(() => {
    if (failed) return;
    if (job.gate?.paused) { hedger.touch(); return; }
    // đoạn đầu hàng chậm trong khi các đoạn sau đã chạy
    if (cursor > next + 1 && hedger.hedge(next)) job.logEvent?.(VCI18n.t('doan_cham_bat_thuong_1hia', [next + 1, segs.length]), 'warn');
  }, hedgeTick(job));
  let chain = Promise.resolve();
  const drain = () => {
    chain = chain.then(async () => {
      while (next < stopAt && ready.has(next)) {
        const b = ready.get(next);
        ready.delete(next);
        readyBytes -= b?.byteLength || 0;
        if (b) await consume(b, segs[next]);
        next++;
      }
      notify();
    }).catch(fail);
    return chain;
  };
  const worker = async () => {
    while (!failed && cursor < stopAt) {
      if (ctrl.signal.aborted) { fail(abortErr()); break; }
      if (cursor - next >= MAX_AHEAD || readyBytes >= 64 * 1024 * 1024) { await new Promise((r) => wake.push(r)); continue; }
      const i = cursor++;
      const sg = segs[i];
      try {
        let buf = await hedger.run(i, (signal) => fetchBytes(sg.url, sg.range, signal, (n) => job.addBytes(n), { gate: job.gate, onRetry: job.onRetry, resumable: true }));
        if (sg.key) buf = await decryptSeg(job, buf, sg, ctrl.signal);
        if (!failed && i < stopAt) { ready.set(i, buf); readyBytes += buf.byteLength; job.segDone(); }
      } catch (e) {
        if (sg.tail && e.status === 404) { stopAt = Math.min(stopAt, i); notify(); } // hết đoạn (số đoạn trong manifest chỉ là ước tính)
        else fail(e);
      }
      drain();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(SEG_CONCURRENCY, segs.length)) }, worker));
    await chain;
    if (failed) throw failed;
  } finally { clearInterval(hedgeTimer); parent.removeEventListener('abort', abort); ready.clear(); }
}

// ---------- Nơi nhận dữ liệu: gom thành 1 track fMP4 (TS -> MP4 bằng mux.js) ----------
// Đoạn MPEG-TS bị nguỵ trang (vd: chèn header PNG/JPG giả ở đầu): tìm vị trí gói TS đầu tiên (byte 0x47 lặp mỗi 188 byte)
function tsOffset(buf) {
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 0;
  const lim = Math.min(buf.length - 377, 65536);
  for (let k = 1; k < lim; k++) {
    if (buf[k] === 0x47 && buf[k + 188] === 0x47 && buf[k + 376] === 0x47) return k;
  }
  return -1;
}
function sniffKind(buf) {
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'ts';
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'ts'; // ID3 + AAC/TS
  if (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0) return 'ts';            // ADTS AAC
  const t = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  if (['ftyp', 'styp', 'moof', 'moov', 'sidx', 'free'].includes(t)) return 'fmp4';
  if (tsOffset(buf) > 0) return 'ts';
  return 'raw';
}
class Sink {
  constructor(raw, spool = null) {
    this.mode = raw ? 'raw' : null;
    this.spool = spool;
    this.track = new VCFMP4.Track();
    this.track.spool = spool;
    this.raw = [];
    this.pending = [];
    this.gotInit = false;
    this.pushes = 0;
  }
  async push(buf) {
    this.pushes++;
    if (!this.mode) {
      this.mode = sniffKind(buf);
      if (this.mode === 'ts') {
        this.tm = new muxjs.Transmuxer({ remux: true });
        this.tm.on('data', (s) => {
          if (!this.gotInit && s.initSegment && s.initSegment.byteLength) { this.pending.push(s.initSegment); this.gotInit = true; }
          if (s.data && s.data.byteLength) this.pending.push(s.data);
        });
      }
    }
    if (this.mode === 'ts' && buf[0] !== 0x47) {
      const off = tsOffset(buf);
      if (off > 0) buf = buf.subarray(off); // bỏ phần đầu giả
    }
    if (this.mode === 'raw') { this.raw.push(this.spool ? this.spool.append([buf]) : new Blob([buf])); await this.spool?.drain(); return; }
    if (this.mode === 'fmp4') { await this.track.add(buf); await this.spool?.drain(); return; }
    try {
      this.tm.push(buf);
      this.tm.flush();
    } catch (e) {
      throw Object.assign(new Error('MUX_FAILED'), { mux: true });
    }
    const out = this.pending;
    this.pending = [];
    for (const o of out) await this.track.add(o);
    await this.spool?.drain();
    if (this.pushes >= 3 && !this.gotInit) throw Object.assign(new Error('MUX_FAILED'), { mux: true });
  }
  get ok() { return this.mode !== 'raw' && !!this.track.moov && this.track.frags.length > 0; }
}

// ---------- Lưu file ----------
const asciiName = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\x20-\x7e]/g, '_');
async function startSave(url, filename, saveAs) {
  let lastErr;
  for (const name of [...new Set([filename, asciiName(filename)])]) {
    try {
      // Chrome có lúc bỏ qua filename với blob: URL → service worker ép lại tên trong onDeterminingFilename
      await chrome.runtime.sendMessage({ type: 'vc:expectName', url, filename: name }).catch(() => {});
      return await chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify', saveAs: !!saveAs });
    } catch (e) {
      lastErr = e;
      if (!/filename/i.test(e.message)) break;
    }
  }
  if (lastErr && /filename/i.test(lastErr.message)) return chrome.downloads.download({ url, conflictAction: 'uniquify', saveAs: !!saveAs });
  throw lastErr;
}
async function saveBlob(blob, filename, saveAs) {
  const url = URL.createObjectURL(blob);
  let id;
  try {
    id = await startSave(url, filename, saveAs);
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error(VCI18n.t('khong_luu_duoc_file_15ia', [e.message]));
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (state) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (state === 'complete') resolve(id);
      else chrome.downloads.search({ id }).then(([d]) => d && d.error).catch(() => '').then((err) =>
        reject(new Error(err === 'USER_CANCELED' ? VCI18n.t('ban_da_dong_hop_kmr1') : VCI18n.t('luu_file_bi_gian_14kc'))));
    };
    const onChanged = (d) => { if (d.id === id && d.state && d.state.current !== 'in_progress') finish(d.state.current); };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([d]) => { if (d && d.state !== 'in_progress') finish(d.state); });
  });
}

// ---------- HLS ----------
// Nội dung manifest: qua mạng; nếu là link blob: hoặc nội dung bị giấu thì hỏi bản trang đã dựng (hook.js)
// Bản sao playlist gửi kèm mục tải (xem inlineSnapshot ở background.js): dùng khi tab nguồn đã đóng
function snapshotText(job, url) {
  const snap = job.inline;
  if (!snap || !url) return null;
  if (snap[url]) return snap[url];
  const bare = (u) => String(u).split('#')[0].split('?')[0];
  const keys = Object.keys(snap).filter((k) => bare(k) === bare(url));
  return keys.length ? snap[keys[0]] : null;
}
async function pageManifest(job, url) {
  const r = await chrome.runtime.sendMessage({ type: 'vc:manifestText', tabId: job.tabId, url }).catch(() => null);
  return r && r.text ? r : snapshotText(job, url);
}
async function manifestText(job, url) {
  const looks = (t) => /^\uFEFF?\s*(#EXTM3U|(<\?xml[^>]*>\s*)?<MPD[\s>])/i.test(t) || /#EXTM3U\s*[\r\n]+#EXT/.test(t.slice(0, 4096));
  const captured = await pageManifest(job, url);
  if (captured?.text && !VCM3U8.isWrapped(captured.text)) return { text: captured.text, base: captured.base || url };
  let netErr = null;
  if (/^https?:/i.test(url)) {
    try {
      const manifest = await fetchManifest(url, job.ctrl.signal, job.referer);
      if (looks(manifest.text)) return manifest;
    } catch (e) {
      if (job.ctrl.signal.aborted) throw e;
      netErr = e;
    }
  }
  const r = await pageManifest(job, url);
  if (r && r.text) return { text: r.text, base: /^https?:/i.test(url) ? url : r.base };
  throw netErr || new Error(VCI18n.t('playlist_chi_ton_tai_1xep'));
}

async function loadHls(job, url) {
  let m = await manifestText(job, url);
  let pl = VCM3U8.parse(m.text, m.base);
  if (pl.type === 'master') {
    if (!pl.variants.length) throw new Error(VCI18n.t('playlist_khong_co_luong_5yif'));
    url = pl.variants[0].url; // chất lượng cao nhất
    await job.setRef([url]);
    m = await manifestText(job, url);
    pl = VCM3U8.parse(m.text, m.base);
  }
  if (pl.drm) throw new Error(VCI18n.t('luong_duoc_bao_ve_1p11'));
  job.logEvent?.(VCI18n.t('playlist_doan_xptf', [pl.endList ? '' : VCI18n.t('truc_tiep_1ute'), pl.segments.length, pl.duration ? ` · ${fmtTime(pl.duration)}` : '', pl.segments.some((s) => s.key) ? VCI18n.t('ma_hoa_aes_128_l1ac') : '', /^https?:/i.test(url) ? '' : VCI18n.t('playlist_do_trang_tu_1w1b')]));
  await job.setRef([...new Set([pl.map && pl.map.url, ...pl.segments.map((s) => s.url), ...pl.segments.map((s) => s.key && s.key.uri)].filter(Boolean).map((u) => new URL(u).origin + '/'))]);
  pl.url = url;
  return pl;
}

async function hlsTrack(job, pl, sink) {
  if (pl.map) await sink.push(await fetchBytes(pl.map.url, pl.map.range, job.ctrl.signal, (n) => job.addBytes(n), { gate: job.gate, onRetry: job.onRetry }));
  await runOrdered(job, pl.segments, async (b, sg) => { await sink.push(b); job.mediaSec += sg.duration || 0; });
}

// Livestream: đọc lại playlist định kỳ, tải đoạn mới cho tới khi bấm "Dừng & lưu" (hoặc luồng kết thúc)
async function hlsLive(job, firstPl, sink) {
  let pl = firstPl;
  let lastSeq = -1;
  let mapDone = false;
  for (;;) {
    if (pl.map && !mapDone) { await sink.push(await fetchBytes(pl.map.url, pl.map.range, job.ctrl.signal, (n) => job.addBytes(n), { gate: job.gate, onRetry: job.onRetry })); mapDone = true; }
    const fresh = pl.segments.filter((s) => s.seq > lastSeq);
    if (fresh.length) {
      job.segTotal += fresh.length;
      await runOrdered(job, fresh, async (b, sg) => { await sink.push(b); job.mediaSec += sg.duration || 0; });
      lastSeq = fresh[fresh.length - 1].seq;
    }
    if (pl.endList || job.stopLive) return;
    const wait = Math.max(1000, (pl.targetDuration || 4) * 500);
    await new Promise((r) => { const t = setTimeout(r, wait); job.wakeLive = () => { clearTimeout(t); r(); }; });
    if (job.stopLive) return;
    const u = pl.url;
    const m = await manifestText(job, u);
    pl = VCM3U8.parse(m.text, m.base);
    pl.url = u;
  }
}

async function runHls(job, raw) {
  const video = await loadHls(job, job.url);
  const audio = job.audioUrl ? await loadHls(job, job.audioUrl) : null;
  const live = !video.endList;
  if (!live) job.duration = job.duration || video.duration;
  const vs = new Sink(raw, job.spool);
  const as = audio ? new Sink(raw, job.spool) : null;
  if (live) {
    job.live = true;
    job.render();
    await Promise.all([hlsLive(job, video, vs), audio ? hlsLive(job, audio, as) : null]);
  } else {
    job.segTotal = video.segments.length + (audio ? audio.segments.length : 0);
    await hlsTrack(job, video, vs);
    if (audio) await hlsTrack(job, audio, as);
  }
  return finishTracks(job, [vs, as].filter(Boolean), live ? job.mediaSec / (audio ? 2 : 1) : video.duration);
}

// ---------- DASH ----------
async function runDash(job) {
  const mt = await manifestText(job, job.url);
  const info = VCMPD.parse(mt.text, mt.base);
  if (info.drm) throw new Error(VCI18n.t('luong_dash_duoc_bao_78m2'));
  if (info.live) throw new Error(VCI18n.t('livestream_dash_chua_ho_u1hf'));
  job.duration = job.duration || info.duration;
  const picks = info.periods.map((p) => {
    const v = job.videoId !== null && job.videoId !== undefined ? VCMPD.pick(p.video, job.videoId, job.height || 0, job.bandwidth || 0) : null;
    const a = job.audioId !== null && job.audioId !== undefined ? (VCMPD.pick(p.audio, job.audioId, 0, 0)) : VCMPD.bestAudio(p.audio);
    return { p, v, a };
  });
  const allReps = picks.flatMap((x) => [x.v, x.a]).filter(Boolean);
  if (!allReps.length) throw new Error(VCI18n.t('khong_tim_thay_luong_owx9'));
  job.logEvent?.(VCI18n.t('manifest_dash_phan_luong_73a3', [picks.length, allReps.length, info.duration ? ` · ${fmtTime(info.duration)}` : '']));
  const urls = allReps.flatMap((r) => [r.init && r.init.url, ...r.segments.map((s) => s.url)]).filter(Boolean);
  await job.setRef([...new Set(urls.map((u) => new URL(u).origin + '/'))]);

  const mp4 = allReps.every((r) => VCMPD.isMp4(r));
  const vs = new Sink(!mp4, job.spool);
  const as = new Sink(!mp4, job.spool);
  job.segTotal = allReps.reduce((n, r) => n + (r.segments[0] && r.segments[0].whole ? 0 : r.segments.length + (r.extra ? r.extra.length : 0)), 0);
  let start = 0;
  for (const { p, v, a } of picks) {
    for (const [rep, sink] of [[v, vs], [a, as]]) {
      if (!rep) continue;
      sink.track.offset = start;
      if (rep.init) await sink.push(await fetchBytes(rep.init.url, rep.init.range, job.ctrl.signal, (n) => job.addBytes(n), { gate: job.gate, onRetry: job.onRetry }));
      if (rep.segments[0] && rep.segments[0].whole) {
        const blob = await downloadLarge(job, rep.segments[0].url);
        if (mp4) await sink.track.add(blob); else sink.raw.push(blob);
      } else {
        await runOrdered(job, [...rep.segments, ...(rep.extra || [])], (b) => sink.push(b));
      }
    }
    start += p.duration;
  }
  const exts = { video: picks.some((x) => x.v) ? (mp4 ? 'mp4' : 'webm') : null, audio: mp4 ? 'm4a' : 'webm' };
  return finishTracks(job, [picks.some((x) => x.v) ? vs : null, picks.some((x) => x.a) ? as : null].filter(Boolean), info.duration, exts);
}

// ---------- File lớn (YouTube, file đơn) gồm hình + tiếng riêng ----------
async function runFiles(job) {
  const parts = (job.parts || []).filter((p) => p && p.url);
  await job.setRef(parts.map((p) => p.url));
  const sinks = [];
  for (const p of parts) {
    const blob = await downloadLarge(job, p.url, { size: p.size, rangeParam: !!p.rangeParam });
    const s = new Sink(!p.mp4);
    if (p.mp4) await s.track.add(blob); else { s.mode = 'raw'; s.raw.push(blob); }
    s.ext = p.ext;
    sinks.push(s);
  }
  return finishTracks(job, sinks, job.duration || 0, { video: parts[0] && parts[0].ext, audio: parts[1] && parts[1].ext });
}

// Ghép các track lại: tất cả fMP4 -> 1 file MP4; không được thì lưu từng file + lệnh ffmpeg
async function finishTracks(job, sinks, duration, exts = {}) {
  sinks = sinks.filter((s) => s.ok || s.raw.length);
  if (!sinks.length) throw new Error(VCI18n.t('khong_tai_duoc_du_14ya'));
  if (job.spool) await job.spool.finalize(); // chốt file tạm trên đĩa trước khi cắt lát để ghép
  for (const s of sinks) s.raw = s.raw.map(resolveRef);
  if (sinks.every((s) => s.ok)) {
    const blob = await VCFMP4.mux(sinks.map((s) => s.track), { duration });
    return [{ blob, ext: sinks.length === 1 && exts.audio && !exts.video ? 'm4a' : 'mp4' }];
  }
  if (sinks.length === 1) {
    const s = sinks[0];
    return [{ blob: new Blob(s.raw), ext: s.ext || exts.video || (s.mode === 'ts' ? 'ts' : 'mp4') }];
  }
  // không ghép được (vd: WebM) -> 2 file
  return sinks.map((s, i) => ({ blob: new Blob(s.raw), ext: s.ext || (i === 0 ? exts.video : exts.audio) || 'bin', part: i === 0 ? 'hinh' : 'tieng' }));
}

// ---------- Nơi lưu: thư mục tự chọn (File System Access) hoặc Downloads ----------
const dest = { handle: null, name: '', granted: false, subfolder: 'Video Catcher', askSaveAs: false };
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('video-catcher', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const idbGet = (k) => idbOp('readonly', (st) => st.get(k));
const idbSet = (k, v) => idbOp('readwrite', (st) => st.put(v, k));

function destLabel() {
  if (dest.handle) return dest.name;
  return `Downloads${dest.subfolder ? ` › ${dest.subfolder}` : ''}`;
}
function renderDest() {
  const box = $('#dest');
  if (!box) return;
  // Một nút: hiện nơi lưu, bấm để đổi
  // Nút chỉ ghi tên thư mục cuối cho gọn; đường dẫn đầy đủ ở tooltip
  const full = dest.handle ? dest.name : `Downloads${dest.subfolder ? ` › ${dest.subfolder}` : ''}`;
  const pick = el('button', { class: 'dest-pick', title: VCI18n.t('luu_vao_bam_de_43h9', [full]), onclick: pickFolder },
    el('span', {}, dest.handle ? dest.name : (dest.subfolder || 'Downloads')));
  const parts = [pick];
  if (dest.askSaveAs) parts.push(el('span', { class: 'ask-badge', title: VCI18n.t('da_tat_tu_dong_mckm') }, VCI18n.t('hoi_khi_luu_qcxc')));
  if (dest.handle && !dest.granted && !dest.askSaveAs) parts.push(el('button', { class: 'small primary', onclick: () => grantAndResume() }, VCI18n.t('cap_quyen_ghi_132v')));
  // Tự động lưu (mặc định bật): tự đặt tên, lưu vào nơi đã chọn. Bỏ tích: mỗi video xong hiện hộp thoại
  // "Lưu thành" của Chrome để người dùng tự chọn thư mục và tên file (cả khi đã chọn thư mục riêng).
  const auto = el('input', { type: 'checkbox', id: 'autoSave' });
  auto.checked = !dest.askSaveAs;
  auto.addEventListener('change', async () => { dest.askSaveAs = !auto.checked; await chrome.storage.local.set({ askSaveAs: dest.askSaveAs }); renderDest(); });
  const opts = [el('label', { for: 'autoSave', class: 'auto-save' }, auto, el('span', {}, el('b', {}, VCI18n.t('tu_dong_luu_exo5')),
    el('small', {}, VCI18n.t('bo_tich_moi_video_2mf4'))))];
  if (!dest.handle) {
    const sub = el('input', { type: 'text', value: dest.subfolder, placeholder: VCI18n.t('thu_muc_con_de_7p3e'), title: VCI18n.t('thu_muc_con_trong_1d7f'), 'aria-label': VCI18n.t('thu_muc_con_trong_1d7f') });
    sub.addEventListener('change', async () => {
      dest.subfolder = sub.value.trim() ? sanitize(sub.value) : '';
      await chrome.storage.local.set({ subfolder: dest.subfolder });
      renderDest();
    });
    opts.push(sub);
  }
  parts.push(el('details', { class: 'dest-more' }, el('summary', { title: VCI18n.t('tuy_chon_luu_rh02'), 'aria-label': VCI18n.t('tuy_chon_luu_rh02') }, '⋯'),
    el('div', { class: 'dest-opts' }, ...opts)));
  box.replaceChildren(...parts);
  chrome.storage.local.set({ destLabel: destLabel() }).catch(() => {});
}
async function loadDest() {
  const cfg = await chrome.storage.local.get({ subfolder: 'Video Catcher', askSaveAs: false });
  dest.subfolder = cfg.subfolder;
  dest.askSaveAs = cfg.askSaveAs;
  try {
    const h = await idbGet('dir');
    if (h) {
      dest.handle = h;
      dest.name = h.name;
      dest.granted = (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
    }
  } catch { /* bỏ qua */ }
  renderDest();
}
async function pickFolder() {
  try {
    const h = await window.showDirectoryPicker({ id: 'video-catcher', mode: 'readwrite', startIn: 'downloads' });
    await idbSet('dir', h);
    Object.assign(dest, { handle: h, name: h.name, granted: true });
    renderDest();
    resumeWaiting();
  } catch (e) {
    if (e.name !== 'AbortError') alertBar(VCI18n.t('khong_chon_duoc_thu_1k7l', [e.message]));
  }
}
// Quyền ghi thư mục có thể hết khi mở lại trình duyệt -> phải xin lại bằng 1 cú bấm
async function grantAndResume() {
  if (!dest.handle) return;
  try { dest.granted = (await dest.handle.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { dest.granted = false; }
  renderDest();
  if (dest.granted) resumeWaiting();
}
function resumeWaiting() { jobs.filter((j) => j.state === 'needperm').forEach((j) => j.saveOutputs()); }
// Thông báo ngắn ở chân cửa sổ: mỗi lúc một thông báo, tự ẩn (không chèn vào thanh trên)
let toastTimer = 0;
function alertBar(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, Math.min(12000, 4000 + msg.length * 40));
}

// Đuôi file khi lưu: chỉ đuôi media (đuôi có thể đến từ link do trang kiểm soát, xem SEC-001)
const SAFE_EXTS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'flv', 'avi', '3gp', 'ts', 'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba', 'bin'];
const safeExt = (ext) => (SAFE_EXTS.includes(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : 'mp4');

// Khoá: 2 việc cùng tên lưu cùng lúc không được chọn trùng tên rồi ghi đè nhau
function writeToFolder(blob, name, handle = dest.handle) {
  return navigator.locks.request('vc-folder-write', () => writeToFolderNow(blob, name, handle));
}
async function writeToFolderNow(blob, name, handle) {
  let n;
  const m = /^(.*?)(\.[^.]*)?$/.exec(name);
  for (let i = 0; ; i++) {
    n = i ? `${m[1]} (${i})${m[2] || ''}` : name;
    try { await handle.getFileHandle(n); } catch (e) {
      if (e.name === 'NotFoundError') break;
      if (e.name === 'TypeMismatchError') continue; // Một thư mục cùng tên cũng đã chiếm tên này.
      throw e;
    }
  }
  const fh = await handle.getFileHandle(n, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => {});
    throw e;
  }
  return n;
}

// ---------- công việc ----------
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';
function svgBtn(svg, label, fn, extra = '') {
  const b = el('button', { class: `icon-btn ${extra}`.trim(), 'aria-label': label, title: label, onclick: fn });
  b.innerHTML = svg; // biểu tượng cố định, không chứa dữ liệu ngoài
  return b;
}

class Job {
  constructor(spec, saved = null) {
    Object.assign(this, spec);
    this.spec = { ...spec };
    delete this.spec.inline; // bản sao playlist có thể lớn: không ghi vào lịch sử
    this.createdAt = (saved && saved.at) || Date.now();
    this.kind = this.kind || 'hls';
    this.state = 'queued'; // queued | running | paused | saving | needperm | done | error | cancelled
    this.gate = new Gate(this.referer);
    this.log = [];
    // Lần thử lại của một request: ghi tên máy chủ, không ghi link (thường có token)
    this.onRetry = (error, url) => {
      let host = '';
      try { host = new URL(url).host; } catch { /* link trong trang */ }
      this.logEvent(VCI18n.t('thu_lai_1ojh', [(error && error.message) || error, host ? ` · ${host}` : '']), 'warn');
    };
    this.reset();
    this.downloadIds = [];
    this.message = VCI18n.t('dang_cho_104q');
    if (saved) this.restore(saved);
    this.build();
  }

  // ---------- Lịch sử: lưu/khôi phục mục tải qua các lần mở Trình tải ----------
  record() {
    return {
      // Mục đang chờ chọn vì trùng / đang kiểm tra trùng: mở lại Trình tải thì coi như đã bỏ qua
      spec: this.spec, at: this.createdAt, ...(['duplicate', 'checking'].includes(this.state) ? { state: 'cancelled', message: VCI18n.t('bo_qua_vi_trung_dlps') } : { state: this.state, message: this.message }), title: this.title, quality: this.quality,
      engine: this.engine, height: this.height, duration: this.duration || 0, savedTo: this.savedTo || '', finalSize: this.finalSize || 0,
      downloadIds: this.downloadIds.slice(), folder: this.savedFolderHandle || null, name: this.nameInput ? this.nameInput.value : '', file: this.savedFile || '',
      files: (this.savedFiles || []).slice(0, 4), savedNames: (this.savedNames || []).slice(0, 4),
      error: this.error ? String(this.error.message || this.error) : '', errorPhase: this.errorPhase || '',
      retries: this.retries || 0, log: this.log.slice(-60), post: this.post || null, postResult: this.postResult || '',
    };
  }
  restore(r) {
    if (Array.isArray(r.log)) this.log = r.log.filter((e) => e && typeof e.m === 'string').slice(-60);
    Object.assign(this, { title: r.title || this.title, quality: r.quality || this.quality, engine: r.engine || this.engine,
      height: r.height || this.height, duration: r.duration || this.duration, savedTo: r.savedTo, finalSize: r.finalSize,
      downloadIds: Array.isArray(r.downloadIds) ? r.downloadIds : [], savedFolderHandle: r.folder || null, restoredName: r.name || '', savedFile: r.file || '',
      savedFiles: Array.isArray(r.files) ? r.files : [], savedNames: Array.isArray(r.savedNames) ? r.savedNames : [], retries: Number(r.retries) || 0, tabId: null,
      post: r.post || this.post || null, postResult: r.postResult || '' }); // số tab của phiên trình duyệt trước có thể đã thuộc về tab khác
    if (r.state === 'done' || r.state === 'cancelled' || (r.state === 'error' && r.errorPhase !== 'save')) {
      this.state = r.state;
      this.message = r.message || '';
      // Mục của bản cũ: "✔ Đã lưu vào thư mục "Video" · tên.mp4" -> tên file lên tiêu đề, trạng thái gọn "✔ Đã lưu"
      const old = r.state === 'done' && /^✔ (Đã lưu|Saved)\b[^·]*·\s(.+)$/.exec(this.message);
      if (old) {
        const names = old[1].split(' + ').map((n) => n.trim()).filter(Boolean);
        if (r.file || /[\\/]/.test(names[0] || '')) this.message = VCI18n.t('da_luu_5gxx');
        else {
          if (!this.savedNames.length) this.savedNames = names;
          if (r.folder && !this.savedFiles.length) this.savedFiles = names.map((name) => ({ name, size: 0 }));
          if (this.savedNames.length) this.restoredName = this.savedNames.join(' + ');
          this.message = VCI18n.t('da_luu_5gxx');
        }
      }
      if (r.state === 'error') { this.error = { message: r.error || r.message }; this.errorPhase = r.errorPhase || ''; }
      if (this.log.length) this.loggedState = this.state; // trạng thái đã có trong nhật ký cũ: không ghi lặp mỗi lần mở lại
    } else {
      // Đang chờ / đang tải / đang lưu / chờ quyền khi Trình tải đóng: dữ liệu tạm đã mất
      this.state = 'error';
      this.message = VCI18n.t('loi_1bgh', [INTERRUPTED]);
      this.error = { message: INTERRUPTED };
      this.errorPhase = '';
    }
  }

  // ---------- Nhật ký: các mốc của lượt tải, xem ở tab Lỗi ----------
  logEvent(m, lv = 'info') {
    const last = this.log[this.log.length - 1];
    if (last && last.m === m) { last.n = (last.n || 1) + 1; last.t = Date.now(); } // gộp dòng lặp (vd thử lại nhiều đoạn)
    else this.log.push({ t: Date.now(), lv, m });
    if (this.log.length > 150) this.log.splice(0, this.log.length - 150);
  }
  logState() {
    if (this.loggedState === this.state) return;
    const prev = this.loggedState;
    this.loggedState = this.state;
    if (this.state === 'running' && (prev === 'paused' || this.resuming)) { this.resuming = false; this.logEvent(VCI18n.t('tiep_tuc_tai_1x0p')); return; }
    if (this.state === 'checking') { this.loggedState = prev; return; } // bước kiểm tra trùng: không ghi nhật ký
    if (this.state === 'duplicate') { this.logEvent(this.message, 'warn'); return; }
    const label = { queued: VCI18n.t('cho_trong_hang_1ni0'), running: VCI18n.t('bat_dau_tai_1g6o'), paused: VCI18n.t('tam_dung_fxvx'), saving: VCI18n.t('dang_luu_file_zp0f'), needperm: VCI18n.t('cho_cap_quyen_ghi_pcrn'), post: VCI18n.t('ghep_phu_de_thuyet_1968'),
      done: VCI18n.t('xong_done'), error: VCI18n.t('loi_vay3'), cancelled: VCI18n.t('da_huy_1ltx') }[this.state] || this.state;
    if (this.state === 'error') {
      const why = this.diag ? `${this.diag.title}: ${this.diag.detail}` : String(this.message || '').replace(/^(Lỗi|Error): /, '');
      this.logEvent(VCI18n.t('loi_1ov4', [this.errorPhase === 'save' ? VCI18n.t('khi_luu_11c8') : '', why]), 'error');
    } else if (this.state === 'done') this.logEvent([String(this.message || VCI18n.t('xong_done')).replace(/^✔\s*/, ''), this.savedNames?.length ? this.savedNames.join(' + ') : ''].filter(Boolean).join(' · '));
    else if (this.state === 'running') this.logEvent(VCI18n.t('bat_dau_tai_7vfe', [{ hls: 'HLS', dash: 'DASH', file: 'file', files: 'file', youtube: this.engine === 'browser' ? VCI18n.t('youtube_trong_trinh_duyet_1jhn') : VCI18n.t('youtube_bo_tai_tren_1631') }[this.kind] || this.kind, this.quality ? ` · ${this.quality}` : '']));
    else this.logEvent(label, this.state === 'needperm' ? 'warn' : 'info');
  }
  copyLog() {
    let host = '';
    try { host = new URL(this.kind === 'youtube' ? this.url : this.url || '').host; } catch { /* nguồn trong trang */ }
    const lines = [`Video Catcher ${chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ''} · ${this.kind}${this.engine ? ` (${this.engine})` : ''}${this.quality ? ` · ${this.quality}` : ''}`,
      VCI18n.t('nguon_69ho', [host || '(trong trang)']),
      this.diag ? VCI18n.t('nguyen_nhan_7stl', [this.diag.title, this.diag.hint]) : '', '',
      ...this.log.map((e) => `${fmtClock(e.t)}  ${e.lv === 'error' ? '✕' : e.lv === 'warn' ? '!' : '·'} ${e.m}${e.n > 1 ? ` (×${e.n})` : ''}`)];
    navigator.clipboard.writeText(lines.filter((x, i) => x !== '' || i === 3).join('\n')).then(() => alertBar(VCI18n.t('da_sao_chep_nhat_1vef')), () => alertBar(VCI18n.t('khong_sao_chep_duoc_11iy')));
  }

  reset() {
    Object.assign(this, { bytes: 0, byteTotal: 0, segTotal: 0, segCount: 0, samples: [], speedAt: 0, speedEma: 0, mediaSec: 0, live: false, stopLive: false, keys: null, outputs: null });
  }

  build() {
    this.titleEl = el('div', { class: 'title', title: this.title }, this.title);
    // "Gốc" = file nguyên bản, không có mức chất lượng: không cần hiện
    this.pill = el('span', { class: 'pill stream' }, this.quality && !/^(Gốc|MP4|Mặc định|Original|Default)$/.test(this.quality) ? this.quality : '');
    this.metaEl = el('div', { class: 'meta' });
    this.barFill = el('i');
    this.statusEl = el('div', { class: 'status' });
    this.btns = el('div', { class: 'btns' });
    this.side = el('div', { class: 'side' });
    this.extra = el('div');
    this.nameInput = this.kind === 'youtube' && this.engine !== 'browser' ? null : el('input', {
      type: 'text', value: sanitize(this.title) + (this.quality && this.kind !== 'file' && !/^(Gốc|MP4|Mặc định|Original|Default)$/.test(this.quality) ? ` [${String(this.quality).split(' · ')[0]}]` : ''),
      'aria-label': VCI18n.t('ten_file_1ej5'), title: VCI18n.t('bam_de_doi_ten_1dcy'), maxlength: '160', class: 'title-input',
    });
    if (this.nameInput) {
      if (this.restoredName) this.nameInput.value = this.restoredName;
      this.nameInput.addEventListener('change', saveHistory);
    }
    // Tên file chính là tiêu đề của mục (sửa được tới khi lưu), không lặp lại tiêu đề
    if (this.nameInput) this.pill.hidden = true;
    // Ảnh thu nhỏ (YouTube) hoặc nhãn loại nguồn bên trái
    const ytId = this.kind === 'youtube' ? (/[?&]v=([\w-]{11})/.exec(this.url || '') || [])[1] : '';
    const kindLabel = { hls: 'HLS', dash: 'DASH', youtube: '▶' }[this.kind] || String(this.ext || 'FILE').toUpperCase().slice(0, 4);
    const fallback = () => el('span', { class: `kind k-${this.kind}` }, kindLabel);
    if (ytId) {
      this.badge = el('img', { class: 'kind-thumb', alt: '', src: `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg` });
      this.badge.addEventListener('error', () => { const f = fallback(); this.badge.replaceWith(f); this.badge = f; });
    } else this.badge = fallback();
    this.node = el('div', { class: 'card job' }, this.badge, el('span', { class: 'okmark', 'aria-hidden': 'true' }, '✓'),
      el('div', { class: 'job-body' },
        el('div', { class: 'card-head' }, this.nameInput || this.titleEl, this.pill),
        this.metaEl,
        el('div', { class: 'bar' }, this.barFill),
        this.statusEl, this.extra, this.btns),
      this.side);
    this.render();
  }

  // File tạm trên đĩa của lượt tải hiện tại (xem Spool)
  async discardSpools() {
    const list = [this.spool, ...(this.spools || [])].filter(Boolean);
    this.spool = null;
    this.spools = [];
    await Promise.all(list.map((spool) => spool.discard()));
  }

  outputBase() {
    return sanitize(this.nameInput?.value?.trim() || this.title);
  }

  addBytes(n) {
    this.bytes += n;
    const now = Date.now();
    const last = this.samples[this.samples.length - 1];
    if (last && now - last[0] < 200) last[1] = this.bytes; // gộp mẫu sát nhau
    else this.samples.push([now, this.bytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 5000) this.samples.shift();
  }
  segDone() { this.segCount++; }
  // Tốc độ hiển thị: trung bình 5 giây gần nhất rồi làm mượt (hằng số thời gian 3 giây) để con số và
  // thời gian còn lại không nhảy liên tục theo từng đoạn tải xong
  speed() {
    let raw = 0;
    if (this.samples.length >= 2) {
      const [t0, b0] = this.samples[0];
      const [t1, b1] = this.samples[this.samples.length - 1];
      raw = t1 > t0 ? Math.max(0, ((b1 - b0) * 1000) / (t1 - t0)) : 0;
    }
    return this.smoothSpeed('speedEma', 'speedAt', raw);
  }
  smoothSpeed(key, atKey, raw) {
    const now = Date.now();
    if (!this[atKey]) this[key] = raw;
    else this[key] += (1 - Math.exp(-(now - this[atKey]) / 3000)) * (raw - this[key]);
    this[atKey] = now;
    return this[key];
  }
  setRef(urls) {
    return chrome.runtime.sendMessage({ type: 'vc:referer', urls: urls.filter(Boolean), referer: this.referer }).catch(() => {});
  }
  setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  // Thời lượng + dung lượng (chính xác khi biết, ~ước tính khi chưa)
  metaText() {
    const parts = [];
    if (this.duration) parts.push(fmtTime(this.duration));
    if (this.finalSize) parts.push(fmtSize(this.finalSize));
    else if (this.byteTotal && !this.segTotal) parts.push(fmtSize(this.byteTotal));
    else if (this.segTotal && this.segCount > 3 && !this.live) parts.push(`~${fmtSize((this.bytes / this.segCount) * this.segTotal)}`);
    else if (this.estSize) parts.push(`~${fmtSize(this.estSize)}`);
    return parts.join(' · ');
  }

  render() {
    if (this.nameInput) this.nameInput.readOnly = this.state === 'saving' || this.state === 'done';
    let frac = 0;
    if (this.state === 'done' || this.state === 'post') frac = 1;
    else if (this.kind === 'youtube' && this.engine === 'browser') frac = this.duration ? (this.capCovered || 0) / this.duration : 0;
    else if (this.byteTotal && !this.segTotal) frac = this.bytes / this.byteTotal;
    else if (this.segTotal) frac = this.segCount / this.segTotal;
    frac = Math.min(1, frac);
    const width = this.live && this.state === 'running' ? '100%' : `${(frac * 100).toFixed(1)}%`;
    if (this.barFill.style.width !== width) this.barFill.style.width = width;
    const cls = `card job ${this.state}${this.live ? ' live' : ''}${this.flashUntil > Date.now() ? ' flash' : ''}`;
    if (this.node.className !== cls) this.node.className = cls;
    // Đã xong: một dòng "✔ Đã lưu · thời lượng · dung lượng"
    const done = this.state === 'done';
    this.metaEl.hidden = done || !this.metaText();
    this.setText(this.metaEl, done ? '' : this.metaText());
    let status;
    if (this.state === 'running' && this.kind === 'youtube' && this.engine === 'browser') {
      const sp = this.speed();
      const left = this.estSize && sp && this.estSize > this.bytes ? VCI18n.t('con_1u6o', [fmtTime((this.estSize - this.bytes) / sp)]) : '';
      status = this.capCovered ? VCI18n.t('da_thu_s_youtube_1dw6', [(frac * 100).toFixed(0), fmtTime(this.capCovered), fmtTime(this.duration), fmtSize(this.bytes), fmtSize(sp), left]) : this.message;
    } else if (this.state === 'running' && this.kind === 'youtube') {
      status = this.nativeFinishing ? VCI18n.t('dang_hoan_tat_luong_1moz')
        : `${this.byteTotal ? `${(frac * 100).toFixed(0)}% · ` : ''}${fmtSize(this.bytes)} · ${fmtSize(this.nativeSpeed || 0)}/s${Number.isFinite(this.nativeEta) ? VCI18n.t('con_1u6o', [fmtTime(this.nativeEta)]) : ''} · YouTube`;
    } else if (this.state === 'running' && this.live) {
      status = VCI18n.t('dang_tai_truc_tiep_8pst', [fmtTime(this.mediaSec), fmtSize(this.bytes), fmtSize(this.speed())]);
    } else if (this.state === 'running' && (this.segTotal || this.byteTotal)) {
      const sp = this.speed();
      const remainBytes = this.byteTotal && !this.segTotal ? this.byteTotal - this.bytes
        : this.segCount ? ((this.segTotal - this.segCount) * this.bytes) / this.segCount : NaN;
      const parts = [`${(frac * 100).toFixed(0)}%`, fmtSize(this.bytes)];
      if (this.byteTotal && !this.segTotal) parts[1] += ` / ${fmtSize(this.byteTotal)}`;
      if (this.segTotal) parts.push(VCI18n.t('doan_1ouw', [this.segCount, this.segTotal]));
      parts.push(`${fmtSize(sp)}/s`, VCI18n.t('con_ko1n', [fmtTime(sp ? remainBytes / sp : NaN)]));
      status = parts.join(' · ');
    } else if (this.state === 'paused') {
      const parts = [VCI18n.t('da_tam_dung_1hvv')];
      if (frac > 0) parts.push(`${(frac * 100).toFixed(0)}%`);
      if (this.bytes) parts.push(fmtSize(this.bytes) + (this.byteTotal && !this.segTotal ? ` / ${fmtSize(this.byteTotal)}` : ''));
      if (this.segTotal) parts.push(VCI18n.t('doan_1ouw', [this.segCount, this.segTotal]));
      status = parts.join(' · ');
    } else status = this.message;
    if (done) status = [String(this.message || '').replace(/^✔\s*/, ''), this.metaText()].filter(Boolean).join(' · ');
    this.setText(this.statusEl, status);
    // Lỗi: ô chẩn đoán đã nói nguyên nhân, không lặp lại dòng "Lỗi: …"
    this.statusEl.hidden = this.state === 'error' && !!this.diag;

    if (this.state === 'error' && !this.diag) { this.showDiag(); this.statusEl.hidden = true; }
    else if (this.state !== 'error' && this.diag) { this.diag = null; this.extra.replaceChildren(); this.statusEl.hidden = false; }

    // Chỉ dựng lại nút khi trạng thái đổi (không làm mất hover / nhấp nháy)
    const key = `${this.state}|${this.live}|${this.savedTo || ''}|${this.diag ? this.diag.code : ''}`;
    if (key === this.btnKey) return;
    this.btnKey = key;
    this.logState();
    updateErrorTab();
    // Vừa chuyển sang lỗi (không tính mục lỗi khôi phục từ lịch sử khi mở Trình tải): mở tab Lỗi tại thẻ của mục
    const prevState = this.shownState;
    this.shownState = this.state;
    if (this.state === 'error' && prevState !== undefined && prevState !== 'error' && !this.removed) showErrorsTab(this);
    saveHistory();
    updateKeepOpen();
    if (this.group && this.group !== groupOf(this.state)) placeJob(this, true);
    else updateGroups();
    this.btns.replaceChildren();
    this.side.replaceChildren();
    const iconBtn = (label, title, fn) => el('button', { class: 'icon-btn', 'aria-label': label, title, onclick: fn }, '✕');
    if (this.state === 'running' && this.live) {
      this.btns.append(el('button', { class: 'primary', onclick: () => this.stopAndSave() }, VCI18n.t('dung_luu_15ll')));
      this.side.append(iconBtn(VCI18n.t('huy_1mte'), VCI18n.t('huy_1mte'), () => this.cancel()));
    } else if (this.state === 'post') {
      this.side.append(iconBtn(VCI18n.t('bo_qua_1qer'), VCI18n.t('bo_qua_ghep_phu_1n7j'), () => this.cancel()));
    } else if (this.state === 'running' || this.state === 'queued') {
      if (this.canPause()) this.side.append(svgBtn(ICON_PAUSE, VCI18n.t('tam_dung_fxvx'), () => this.pause()));
      this.side.append(iconBtn(VCI18n.t('huy_1mte'), VCI18n.t('huy_1mte'), () => this.cancel()));
    } else if (this.state === 'paused') {
      this.side.append(svgBtn(ICON_PLAY, VCI18n.t('tiep_tuc_34l0'), () => this.resume(), 'resume'));
      this.side.append(iconBtn(VCI18n.t('huy_1mte'), VCI18n.t('huy_1mte'), () => this.cancel()));
    } else if (this.state === 'duplicate') {
      const dup = this.dup || {};
      if (dup.other && !dup.other.removed) this.btns.append(el('button', { class: 'primary', onclick: () => dup.other.reveal() }, dup.type === 'active' ? VCI18n.t('xem_muc_dang_tai_62w5') : VCI18n.t('xem_muc_da_tai_btw0')));
      if (dup.type !== 'active' && (dup.downloadId != null || dup.other)) this.btns.append(el('button', { onclick: () => (dup.downloadId != null ? chrome.downloads.show(dup.downloadId) : dup.other.openFolder()) }, VCI18n.t('mo_thu_muc_14nn')));
      this.btns.append(el('button', { onclick: () => this.confirmDuplicate() }, dup.type === 'active' ? VCI18n.t('van_tai_them_ban_1f37') : VCI18n.t('van_tai_lai_175z')));
      this.side.append(iconBtn(VCI18n.t('bo_18vf'), VCI18n.t('bo_muc_trung_nay_2xpi'), () => removeJob(this)));
    } else if (this.state === 'needperm') {
      this.btns.append(el('button', { class: 'primary', onclick: () => grantAndResume() }, VCI18n.t('cap_quyen_ghi_vao_121o', [dest.name])));
      this.btns.append(el('button', { onclick: () => this.saveOutputs(true) }, VCI18n.t('luu_vao_downloads_1cm8')));
    } else if (this.state === 'error' || this.state === 'cancelled') {
      const actions = this.state === 'error' && this.diag ? this.diag.actions : ['retry'];
      if (actions.includes('saveAgain')) this.btns.append(el('button', { class: 'primary', onclick: () => this.saveOutputs() }, VCI18n.t('luu_lai_33qa')));
      if (actions.includes('downloads')) this.btns.append(el('button', { onclick: () => this.saveOutputs(true) }, VCI18n.t('luu_vao_downloads_1cm8')));
      if (actions.includes('grant')) this.btns.append(el('button', { onclick: async () => { await grantAndResume(); if (dest.granted) this.saveOutputs(); } }, VCI18n.t('cap_quyen_ghi_132v')));
      if (actions.includes('browser')) this.btns.append(el('button', { class: 'primary', onclick: () => this.switchToBrowser() }, VCI18n.t('tai_trong_trinh_duyet_zaqm')));
      if (!actions.includes('saveAgain')) this.btns.append(el('button', { class: actions.includes('browser') ? '' : 'primary', onclick: () => this.retry() }, VCI18n.t('thu_lai_geyv')));
      if (actions.includes('openSource')) this.btns.append(el('button', { onclick: () => this.openSource() }, VCI18n.t('mo_trang_nguon_1v07')));
      if (actions.includes('fewer') && jobConcurrency > 1) this.btns.append(el('button', { onclick: () => { setConcurrency(1); this.retry(); } }, VCI18n.t('tai_1_video_moi_wkpd')));
      if (this.kind === 'file') this.btns.append(el('button', { onclick: () => this.chromeDownload() }, VCI18n.t('tai_bang_chrome_1elq')));
    }
    // Chỉ có file để mở khi đã lưu xong
    if (done) this.side.append(el('button', { class: 'tonal', title: VCI18n.t('mo_file_explorer_tai_7582'), onclick: () => this.openFolder() }, VCI18n.t('mo_thu_muc_14nn')));
    if (['done', 'error', 'cancelled', 'needperm'].includes(this.state)) {
      this.side.append(iconBtn(VCI18n.t('xoa_jse6'), VCI18n.t('bo_khoi_danh_sach_gnnl'), () => removeJob(this)));
    }
  }

  // Ô chẩn đoán: nguyên nhân + việc nên làm (lib/errors.js)
  showDiag() {
    const fallback = { message: String(this.message || '').replace(/^(Lỗi|Error)( khi lưu| while saving)?: /, '') };
    const classify = typeof VCErrors === 'object' ? VCErrors.classify
      : (e) => ({ code: 'unknown', title: VCI18n.t('loi_vay3'), hint: VCI18n.t('bam_thu_lai_thi9'), actions: ['retry'], detail: String(e && e.message) });
    this.diag = classify(this.error || fallback, {
      phase: this.errorPhase, kind: this.kind, engine: this.engine, hasOutputs: !!this.outputs, hasFolder: !!dest.handle,
      canOpenSource: Number.isInteger(this.tabId) || /^https?:/i.test((this.kind === 'youtube' ? this.url : this.referer) || ''),
    });
    this.extra.replaceChildren(el('div', { class: 'diag' },
      el('b', {}, this.diag.title),
      el('div', { class: 'diag-hint' }, this.diag.hint),
      el('details', {}, el('summary', {}, VCI18n.t('chi_tiet_ky_thuat_7g18')), el('code', {}, this.diag.detail || VCI18n.t('khong_co_1g6u')),
        el('button', { class: 'small', title: VCI18n.t('sao_chep_mo_ta_2maz'), onclick: () => this.copyReport() }, VCI18n.t('sao_chep_chi_tiet_11q1'))),
      el('button', { class: 'text small', title: VCI18n.t('xem_nguyen_nhan_va_h2tx'), onclick: () => showErrorsTab(this) }, VCI18n.t('xem_nhat_ky_8p39'))));
  }

  // Đưa mục lên tầm nhìn và nháy viền (khi một mục khác trùng với mục này)
  reveal() {
    setTab('all');
    this.node.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    // giữ class flash trong lúc nháy (render() đặt lại className mỗi lần cập nhật tiến độ)
    this.node.classList.remove('flash');
    void this.node.offsetWidth;
    this.flashUntil = Date.now() + 2400;
    this.node.classList.add('flash');
    setTimeout(() => this.render(), 2500);
  }
  // Người dùng vẫn muốn tải dù trùng
  confirmDuplicate() {
    if (this.state !== 'duplicate') return;
    this.logEvent(VCI18n.t('nguoi_dung_chon_van_1web'));
    this.dup = null;
    this.extra.replaceChildren();
    Object.assign(this, { state: 'queued', message: VCI18n.t('dang_cho_104q') });
    this.render();
    pump();
  }

  // Trang video gốc để bắt đầu lại từ đầu: YouTube -> link video; nguồn khác -> trang đang xem khi bấm tải
  sourcePage() {
    const url = this.kind === 'youtube' ? this.url : (this.page || this.referer);
    return /^https?:\/\//i.test(url || '') ? url : '';
  }
  // Mở lại trang video gốc: nạp lại tab cũ nếu vẫn đang ở trang đó (link phát mới), nếu không thì mở tab mới
  async restartFromSource() {
    const url = this.sourcePage();
    if (!url) return;
    this.logEvent(VCI18n.t('mo_lai_trang_video_1476'));
    saveHistory();
    updateErrorTab(); // vẽ lại thẻ lỗi để thấy dòng nhật ký mới
    try {
      if (Number.isInteger(this.tabId)) {
        const tab = await chrome.tabs.get(this.tabId);
        if (new URL(tab.url).host === new URL(url).host) {
          await chrome.tabs.update(tab.id, { url, active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          return;
        }
      }
    } catch { /* tab nguồn đã đóng */ }
    const tab = await chrome.tabs.create({ url, active: true }).catch(() => null);
    if (tab) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  async openSource() {
    try {
      if (Number.isInteger(this.tabId)) {
        const tab = await chrome.tabs.get(this.tabId);
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    } catch { /* tab nguồn đã đóng -> mở lại trang */ }
    const url = this.kind === 'youtube' ? this.url : this.referer;
    if (/^https?:/i.test(url || '')) await chrome.tabs.create({ url }).catch(() => {});
  }

  // Lỗi bộ tải trên máy / YouTube đòi xác minh -> tải lại bằng chế độ trong trình duyệt (≤1080p)
  switchToBrowser() {
    this.engine = 'browser';
    if (!(this.height <= 1080)) this.height = 1080;
    this.quality = `${this.height}p`;
    this.pill.textContent = this.quality;
    if (!this.nameInput) {
      this.nameInput = el('input', { type: 'text', value: `${sanitize(this.title)} [${this.quality}]`, 'aria-label': VCI18n.t('ten_file_1ej5'), title: VCI18n.t('bam_de_doi_ten_1dcy'), maxlength: '160', class: 'title-input' });
      if (typeof this.titleEl.replaceWith === 'function') this.titleEl.replaceWith(this.nameInput);
      this.pill.hidden = true;
    }
    this.retry();
  }

  copyReport() {
    let host = '';
    try { host = new URL(this.url).host; } catch { /* nguồn trong trang */ }
    const text = [`Video Catcher ${chrome.runtime.getManifest ? chrome.runtime.getManifest().version : ''}`,
      VCI18n.t('loai_1pi9', [this.kind, this.engine ? ` (${this.engine})` : '', this.quality ? ` · ${this.quality}` : '']),
      VCI18n.t('nguon_69ho', [host || '(trong trang)']), VCI18n.t('loi_1bgh', [this.diag ? `${this.diag.code} – ${this.diag.title}` : '']),
      VCI18n.t('chi_tiet_if57', [this.diag ? this.diag.detail : this.message])].join('\n');
    navigator.clipboard.writeText(text).then(() => alertBar(VCI18n.t('da_sao_chep_chi_1f5d')), () => alertBar(text));
  }

  async openFolder() {
    try {
      if (this.kind === 'youtube' && this.engine !== 'browser') { await VCNativeYouTube.openFolder(this.savedFile); return; }
      if (this.downloadIds.length) {
        try { await chrome.downloads.show(this.downloadIds[0]); return; } catch { /* download history may have been cleared */ }
      }
      const handle = this.savedFolderHandle || (this.state === 'done' ? null : dest.handle);
      if (handle) { await this.revealInFolder(handle); return; }
      await chrome.downloads.showDefaultFolder();
    } catch (error) {
      if (error.name !== 'AbortError') alertBar(VCI18n.t('khong_mo_duoc_thu_cmb7', [error.message]));
    }
  }

  // Thư mục tự chọn: Chrome không cho biết đường dẫn thật, nên nhờ bộ tải trên máy tìm file
  // rồi mở File Explorer chọn sẵn file đó. Đường dẫn tìm được được nhớ để lần sau mở ngay.
  async revealInFolder(handle) {
    let files = (this.savedFiles || []).filter((f) => f && f.name);
    if (!files.length) {
      // Mục cũ chưa ghi tên file: lấy từ dòng "✔ Đã lưu vào thư mục … · tên file"
      const m = /·\s(.+)$/.exec(this.message || '');
      if (m) files = m[1].split(' + ').map((name) => ({ name: name.trim(), size: 0 }));
    }
    const shown = files.length ? files.map((f) => f.name).join(' + ') : '';
    if (!files.length) { alertBar(VCI18n.t('video_trong_thu_muc_z3kw', [this.state === 'done' ? VCI18n.t('da_luu_zk26') : VCI18n.t('se_duoc_luu_f7tm'), handle.name])); return; }
    const known = await chrome.storage.local.get('vcFolderPaths').then((v) => v.vcFolderPaths || {}).catch(() => ({}));
    try {
      const result = await VCNativeYouTube.reveal(handle.name, files, known[handle.name] ? [known[handle.name]] : []);
      const dir = String(result.file || '').replace(/[\\/][^\\/]+$/, '');
      if (dir && known[handle.name] !== dir) {
        known[handle.name] = dir;
        const names = Object.keys(known);
        if (names.length > 30) delete known[names[0]];
        chrome.storage.local.set({ vcFolderPaths: known }).catch(() => {});
      }
    } catch (error) {
      if (/kết nối được bộ tải|YouTube helper|setup-youtube/i.test(error.message)) {
        alertBar(VCI18n.t('video_nam_trong_thu_9ml0', [handle.name]));
      } else alertBar(VCI18n.t('khong_mo_duoc_thu_1cca', [handle.name, error.message]));
    }
  }

  // Dự phòng cho file thường: giao cho trình tải của Chrome
  chromeDownload() {
    chrome.runtime.sendMessage({ type: 'vc:download', url: this.url, filename: `${this.outputBase()}.${safeExt(this.ext)}`, referer: this.referer })
      .then((r) => { this.message = r && r.error ? VCI18n.t('loi_1bgh', [r.error]) : VCI18n.t('da_chuyen_sang_trinh_7oub'); this.render(); })
      .catch(() => {});
  }

  stopAndSave() {
    this.stopLive = true;
    this.message = VCI18n.t('dang_hoan_tat_1cwt');
    if (this.wakeLive) this.wakeLive();
  }

  // Tạm dừng / tiếp tục. HLS/DASH/file: giữ phần đã tải và tải tiếp từ đó. Bộ tải YouTube trên máy:
  // dừng yt-dlp, file .part được giữ nên lần chạy sau tải tiếp. Livestream và YouTube trong trình duyệt
  // (đang thu theo trình phát) không tạm dừng được.
  canPause() {
    if (this.state === 'queued') return true;
    return this.state === 'running' && !this.live && !(this.kind === 'youtube' && this.engine === 'browser');
  }
  pause() {
    if (!this.canPause()) return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.message = VCI18n.t('da_tam_dung_1hvv');
    if (this.pausedFrom === 'running') {
      if (this.kind === 'youtube') { this.nativeRun = null; this.ctrl?.abort(); }
      else this.gate.pause();
    }
    this.render();
    pump(); // nhường chỗ cho video đang chờ
  }
  resume() {
    if (this.state !== 'paused') return;
    this.resuming = true; // nhật ký ghi "Tiếp tục tải" thay vì "Bắt đầu tải" (ISSUE-004)
    if (this.pausedFrom === 'running' && this.kind !== 'youtube') {
      this.state = 'running';
      this.samples = [];
      this.speedAt = 0;
      this.gate.resume();
      this.render();
      return;
    }
    this.state = 'queued';
    this.message = VCI18n.t('dang_cho_104q');
    this.render();
    pump();
  }

  cancel() {
    if (this.state === 'post') { this.postTask?.cancel(); this.postResult = 'cancelled'; this.state = 'done'; this.message = VCI18n.t('da_luu_video_bo_19fb', [this.postLabel()]); this.render(); pump(); return; }
    if (this.ctrl) this.ctrl.abort();
    this.state = 'cancelled';
    this.outputs = null;
    this.discardSpools();
    this.message = VCI18n.t('da_huy_atq6');
    this.render();
    pump();
  }

  retry() {
    this.retries = (this.retries || 0) + 1; // số lần người dùng bấm Tải lại: lỗi tiếp thì gợi ý mở lại trang video gốc
    this.discardSpools();
    this.error = null;
    this.errorPhase = '';
    this.reset();
    Object.assign(this, { state: 'queued', message: VCI18n.t('dang_cho_104q'), finalSize: 0 });
    this.extra.replaceChildren();
    this.render();
    pump();
  }

  // Lưu kết quả: thư mục tự chọn (nếu có quyền) hoặc Downloads
  async saveOutputs(forceDownloads = false) {
    if (this.removed) return;
    const outputs = this.outputs;
    if (!outputs) return;
    // Tắt Tự động lưu: luôn qua hộp thoại "Lưu thành" của Chrome (người dùng chọn thư mục + tên file)
    const useFolder = dest.handle && !forceDownloads && !dest.askSaveAs;
    if (useFolder && !dest.granted) {
      try { dest.granted = (await dest.handle.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch { dest.granted = false; }
      if (!dest.granted) {
        this.state = 'needperm';
        this.message = VCI18n.t('da_tai_xong_can_90fe', [fmtSize(outputs.reduce((n, o) => n + o.blob.size, 0)), dest.name]);
        renderDest();
        this.render();
        pump();
        return;
      }
    }
    if (this.removed || this.state === 'cancelled') return;
    const base = this.outputBase();
    this.state = 'saving';
    this.message = VCI18n.t('dang_luu_file_15or');
    this.render();
    const folderHandle = useFolder ? dest.handle : null;
    if (folderHandle) this.savedFolderHandle = folderHandle;
    this.savedFiles = [];
    try {
      const names = [];
      let total = 0;
      for (const o of outputs) {
        let name = `${base}${o.part ? ` (${o.part})` : ''}.${safeExt(o.ext)}`;
        if (useFolder) name = await writeToFolder(o.blob, name, folderHandle);
        else {
          const id = await saveBlob(o.blob, dest.subfolder ? `${dest.subfolder}/${name}` : name, dest.askSaveAs);
          this.downloadIds.push(id);
          // Chrome có thể thêm (1), (2) hoặc người dùng đổi tên trong Save As.
          // Hiện tên thật trên đĩa thay vì lặp lại tên đề nghị của cả hai video.
          try {
            const [download] = await chrome.downloads.search({ id });
            if (download?.filename) name = download.filename.split(/[\\/]/).pop() || name;
          } catch { /* File đã lưu; lỗi đọc metadata không làm tác vụ thất bại. */ }
        }
        names.push(name);
        if (useFolder) this.savedFiles.push({ name, size: o.blob.size });
        total += o.blob.size;
      }
      if (outputs.length > 1) {
        this.extra.replaceChildren(
          el('div', { class: 'status' }, VCI18n.t('khong_ghep_duoc_hinh_h00r')),
          el('code', {}, `ffmpeg -i "${names[0]}" -i "${names[1]}" -c copy "${base}.mkv"`));
      }
      this.finalSize = total;
      this.savedTo = useFolder ? `📁 ${dest.name}` : dest.askSaveAs ? VCI18n.t('noi_ban_chon_1qrb') : 'Downloads';
      // Nơi lưu đã hiện ở thanh trên; chỉ nói rõ khi lưu vào Downloads thay cho thư mục đã chọn
      this.message = forceDownloads && dest.handle ? VCI18n.t('da_luu_vao_downloads_1wnz') : VCI18n.t('da_luu_5gxx');
      // Tiêu đề mục hiện đúng tên file trên đĩa (Chrome/thư mục có thể thêm (1), Save As có thể đổi tên)
      this.savedNames = names;
      if (this.nameInput) { this.nameInput.value = names.join(' + '); this.nameInput.title = names.join(' + '); }
      this.state = 'done';
      this.outputs = null; // giải phóng RAM
      this.discardSpools(); // file đã lưu xong -> xóa file tạm
    } catch (e) {
      this.state = 'error';
      this.error = e;
      this.errorPhase = 'save';
      this.message = VCI18n.t('loi_khi_luu_10pz', [e.message]);
    }
    this.render();
    pump();                                   // trả chỗ cho video kế tiếp trước khi ghép (ghép có thể mất vài phút)
    if (this.state === 'done' && this.post && !this.postResult) await this.runPost();
  }

  // ---------- Kèm phụ đề / thuyết minh (CC and dịch): chờ dữ liệu từ trang, rồi nhờ bộ tải trên máy ghép bằng ffmpeg ----------
  postLabel() {
    const p = this.post || {};
    return [p.subMode !== 'none' ? VCI18n.t('phu_de_rrft') : '', p.dubMode !== 'none' ? VCI18n.t('thuyet_minh_1g0w') : ''].filter(Boolean).join(' + ');
  }
  postProgressText(pr) {
    if (!pr) return VCI18n.t('dang_cho_phu_de_5evl');
    const pct = pr.total ? ` ${Math.round((pr.done / pr.total) * 100)}%` : '';
    return { start: VCI18n.t('cc_and_dich_dang_rrpw'), translate: VCI18n.t('cc_and_dich_dang_1cop', [pct, pr.done, pr.total]), phonetic: VCI18n.t('dang_phien_am_1rc5', [pct]),
      voice: pr.note || VCI18n.t('dang_tai_giong_doc_1koq'), dub: VCI18n.t('dang_tao_thuyet_minh_1jo4', [pct, pr.done, pr.total]),
      transfer: VCI18n.t('dang_chuyen_phu_de_x9ga', [pr.total ? ` · ${fmtSize(pr.done)} / ${fmtSize(pr.total)}` : '']) }[pr.phase] || (pr.note || VCI18n.t('dang_cho_cc_and_1ua7'));
  }
  async videoLocation() {
    if (this.savedFile) return this.savedFile;
    if (this.downloadIds.length) {
      const [d] = await chrome.downloads.search({ id: this.downloadIds[this.downloadIds.length - 1] });
      if (d && d.filename) return d.filename;
    }
    const handle = this.savedFolderHandle;
    if (handle && this.savedFiles?.length) {
      const known = await chrome.storage.local.get('vcFolderPaths').then((v) => v.vcFolderPaths || {}).catch(() => ({}));
      return { folder: handle.name, files: this.savedFiles, hints: known[handle.name] ? [known[handle.name]] : [] };
    }
    return null;
  }
  async runPost() {
    if (!this.post || this.removed) return;
    const key = `vcPost_${this.id}`;
    this.state = 'post';
    this.message = this.postProgressText(null);
    this.render();
    const finishWith = (ok, text) => {
      this.postResult = ok ? 'ok' : 'error';
      this.state = 'done';
      this.message = text;
      this.logEvent(text.replace(/^✔\s*/, ''), ok ? 'info' : 'warn');
      this.render();
      saveHistory();
    };
    // 1. Chờ CC and dịch tạo xong dữ liệu (content script trong tab video gửi qua service worker)
    let st = (await chrome.storage.session.get(key))[key] || null;
    const t0 = Date.now();
    let lastChange = Date.now(), lastAt = st?.at || 0;
    while (!st || st.status === 'working') {
      if (this.removed || this.state !== 'post') return;
      if (st && st.at !== lastAt) { lastAt = st.at; lastChange = Date.now(); }
      this.message = this.postProgressText(st?.progress);
      this.render();
      if (Date.now() - lastChange > 4 * 60000 || Date.now() - t0 > 90 * 60000) { finishWith(false, VCI18n.t('da_luu_video_nhung_1dpr', [this.postLabel()])); return; }
      await new Promise((r) => { const onCh = (c, area) => { if (area === 'session' && c[key]) { chrome.storage.onChanged.removeListener(onCh); clearTimeout(t); r(); } }; const t = setTimeout(() => { chrome.storage.onChanged.removeListener(onCh); r(); }, 2000); chrome.storage.onChanged.addListener(onCh); });
      st = (await chrome.storage.session.get(key))[key] || null;
    }
    if (st.status !== 'ready') { finishWith(false, VCI18n.t('da_luu_video_nhung_1lof', [this.postLabel(), st.error || VCI18n.t('loi_nqa6')])); return; }
    // 2. Ghép bằng ffmpeg trên máy
    try {
      const video = await this.videoLocation();
      if (!video) throw new Error(VCI18n.t('khong_xac_dinh_duoc_gcvu'));
      const LANG3 = { vi: 'vie', en: 'eng', ja: 'jpn', ko: 'kor', zh: 'chi', fr: 'fre', de: 'ger', es: 'spa', th: 'tha', ru: 'rus', pt: 'por', id: 'ind' };
      const lang3 = LANG3[String(this.post.lang || '').split('-')[0].toLowerCase()] || 'und';
      const subMode = st.files.ass || st.files.srt ? this.post.subMode : 'none';
      const dubMode = st.files.voice && st.files.env ? this.post.dubMode : 'none';
      if (subMode === 'none' && dubMode === 'none') throw new Error(VCI18n.t('cc_and_dich_khong_zi4b'));
      this.message = VCI18n.t('dang_ghep_1vd2', [this.postLabel()]);
      this.render();
      const { postKeep } = await chrome.storage.local.get({ postKeep: false });
      const task = VCNativeYouTube.postprocess({ video, ass: st.files.ass || null, srt: st.files.srt || null, voice: st.files.voice || null, env: st.files.env || null, subMode, dubMode, lang3, lang: this.post.lang || '', keep: !!postKeep, deleteTemp: true },
        (p) => { if (this.state !== 'post') return; this.message = VCI18n.t('dang_ghep_gpp4', [this.postLabel(), Math.round(p.percent || 0), p.burn ? VCI18n.t('ma_hoa_lai_hinh_n8mr') : '', p.speed ? ` · ${p.speed.toFixed(1)}×` : '']); this.render(); });
      this.postTask = task;
      const r = await task.promise;
      this.postTask = null;
      if (this.state !== 'post') return;
      const name = String(r.file || '').split(/[\\/]/).pop();
      if (this.savedFile) this.savedFile = r.file;
      if (name) {
        this.savedNames = [name];
        if (this.savedFiles?.length) this.savedFiles = [{ name, size: r.size }];
        if (this.nameInput) { this.nameInput.value = name; this.nameInput.title = name; }
      }
      this.finalSize = r.size || this.finalSize;
      const notes = (st.meta?.notes || []).join('; ');
      const kept = ['kept_srt', 'kept_ass', 'kept_voice'].filter((k) => r[k]).length;
      finishWith(true, VCI18n.t('da_luu_kem_170b', [this.postLabel(), st.meta?.voice?.name ? VCI18n.t('giong_1w7n', [st.meta.voice.name]) : '', kept ? VCI18n.t('giu_file_roi_canh_z8t6', [kept]) : '', notes ? ` · ${notes}` : '']));
    } catch (error) {
      this.postTask = null;
      if (this.state !== 'post') return;
      finishWith(false, error.name === 'AbortError' ? VCI18n.t('da_luu_video_da_fxq7', [this.postLabel()]) : VCI18n.t('da_luu_video_nhung_12jm', [this.postLabel(), error.message]));
    } finally { chrome.storage.session.remove([key, `vcPostOwner_${this.id}`]).catch(() => {}); }
  }

  async run(raw = false) {
    if (this.kind === 'youtube') return this.engine === 'browser' ? this.runYouTubeBrowser() : this.runYouTube();
    this.state = 'running';
    this.ctrl = new AbortController();
    this.gate = new Gate(this.referer);
    const controller = this.ctrl;
    const run = this.mediaRun = {};
    const task = new Proxy(this, {
      get: (target, key) => {
        if (key === 'ctrl') return controller;
        if (['addBytes', 'segDone', 'render'].includes(key)) return (...args) => {
          if (this.mediaRun === run) return target[key](...args);
        };
        return target[key];
      },
      set: (target, key, value) => { if (this.mediaRun === run) target[key] = value; return true; },
    });
    this.message = this.kind === 'file' ? VCI18n.t('dang_ket_noi_bj92') : VCI18n.t('dang_doc_playlist_zr2i');
    this.render();
    await this.discardSpools(); // dữ liệu của lượt trước (thử lại / tải lại dạng TS)
    if (this.mediaRun !== run) return;
    if (this.kind === 'hls' || this.kind === 'dash') this.spool = await Spool.open(this.id);
    if (this.mediaRun !== run || controller.signal.aborted) { this.discardSpools(); return; }
    try {
      await this.setRef([this.url, this.audioUrl].filter((u) => u && /^https?:/i.test(u)));
      if (this.mediaRun !== run || controller.signal.aborted) return;
      let outputs;
      if (this.kind === 'dash') outputs = await runDash(task);
      else if (this.kind === 'files') outputs = await runFiles(task);
      else if (this.kind === 'file') outputs = [{ blob: await downloadLarge(task, this.url, { size: this.size || 0 }), ext: this.ext || 'mp4' }];
      else outputs = await runHls(task, raw);
      if (this.mediaRun !== run) return;
      if (controller.signal.aborted || this.state === 'cancelled') throw new DOMException(VCI18n.t('da_huy_12ms'), 'AbortError');
      this.outputs = outputs;
    } catch (e) {
      if (this.mediaRun !== run) return;
      if (e.mux && !raw && this.kind === 'hls' && !this.audioUrl && !this.ctrl.signal.aborted && this.state !== 'cancelled') {
        // Không chuyển được sang MP4 -> tải lại dạng .ts gốc (VLC phát được)
        this.logEvent(VCI18n.t('khong_chuyen_duoc_sang_1au8'), 'warn');
        controller.abort();
        this.reset();
        return this.run(true);
      }
      controller.abort(); // giải phóng mọi request còn lại trước khi nhường hàng đợi
      this.discardSpools();
      if (this.state !== 'cancelled') {
        this.state = 'error';
        this.error = e;
        this.errorPhase = 'download';
        this.message = e.name === 'AbortError' ? VCI18n.t('da_huy_atq6') : VCI18n.t('loi_1bgh', [e.message]);
      }
      this.render();
      pump();
      return;
    }
    await this.saveOutputs();
  }

  // YouTube không cần cài thêm: Trình tải mở video ở một tab tắt tiếng, lib/yt-capture.js thu các
  // fragment H.264/AAC mà trình phát YouTube tải về, content.js chuyển sang đây để ghép thành MP4.
  async runYouTubeBrowser() {
    this.state = 'running';
    const controller = this.ctrl = new AbortController();
    const run = this.mediaRun = {};
    this.reset();
    this.capCovered = 0;
    this.message = VCI18n.t('dang_mo_video_youtube_10af');
    this.render();
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const name = `vc-yt:${this.id}:${token}`;
    const live = () => this.mediaRun === run && !controller.signal.aborted && this.state === 'running';
    await this.discardSpools();
    if (this.mediaRun !== run || controller.signal.aborted) return;
    this.spool = await Spool.open(this.id);
    if (this.mediaRun !== run || controller.signal.aborted) { this.discardSpools(); return; }
    const sinks = { video: new Sink(false, this.spool), audio: new Sink(false, this.spool) };
    let settle;
    const outcome = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    outcome.catch(() => {});
    let chain = Promise.resolve();
    let port = null, tabId = null;
    const defaultName = () => sanitize(this.title) + (this.quality ? ` [${this.quality}]` : '');
    const connectTimer = setTimeout(() => settle.reject(new Error(VCI18n.t('tab_youtube_khong_phan_1m5s'))), 60000);
    // Tab thu gửi tín hiệu định kỳ; im lặng quá lâu (tab treo, bị đóng băng) -> báo lỗi thay vì chờ mãi
    let lastHeard = Date.now();
    const quietTimer = setInterval(() => {
      if (port && Date.now() - lastHeard > 180000) settle.reject(new Error(VCI18n.t('tab_youtube_khong_phan_xooz')));
    }, 15000);
    ytPorts.set(name, (p) => {
      if (port) { p.disconnect(); return; }
      port = p;
      clearTimeout(connectTimer);
      if (live()) { this.message = VCI18n.t('dang_cho_youtube_phat_15rj'); this.render(); }
      p.onMessage.addListener((m) => {
        lastHeard = Date.now();
        chain = chain.then(async () => {
          if (!m || typeof m.t !== 'string') return;
          if (m.t === 'done') { settle.resolve(); return; }
          if (m.t === 'error') { settle.reject(new Error(m.message || VCI18n.t('loi_khi_thu_video_zr4v'))); return; }
          if (!live()) return;
          if (m.t === 'meta') {
            const oldDefault = defaultName();
            if (m.title) { this.title = String(m.title); this.titleEl.textContent = this.title; this.titleEl.title = this.title; }
            if (Number.isFinite(m.duration)) this.duration = m.duration;
            if (Number.isInteger(m.height)) { this.quality = `${m.height}p`; this.pill.textContent = this.quality; }
            if (this.nameInput && this.nameInput.value === oldDefault) this.nameInput.value = defaultName();
          } else if (m.t === 'reset') {
            sinks[m.kind === 'audio' ? 'audio' : 'video'] = new Sink(false, this.spool);
          } else if ((m.t === 'init' || m.t === 'frag') && typeof m.b64 === 'string') {
            const kind = m.kind === 'audio' ? 'audio' : 'video';
            const bytes = fromBase64(m.b64);
            if (m.t === 'frag') this.addBytes(bytes.length);
            // Init mới (đổi chất lượng) không ghép chung với dữ liệu cũ -> bắt đầu track mới
            else if (sinks[kind].pushes) sinks[kind] = new Sink(false, this.spool);
            await sinks[kind].push(bytes);
          } else if (m.t === 'progress') {
            if (Number.isFinite(m.covered)) this.capCovered = m.covered;
            if (Number.isFinite(m.duration)) this.duration = m.duration;
          }
        }).catch((error) => settle.reject(error));
      });
      p.onDisconnect.addListener(() => {
        chain.then(() => settle.reject(new Error(VCI18n.t('tab_thu_video_youtube_1bhv'))));
      });
    });
    const onAbort = () => settle.reject(abortErr());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    let outputs;
    try {
      if (controller.signal.aborted) throw abortErr();
      const r = await chrome.runtime.sendMessage({ type: 'vc:ytCaptureStart', url: this.url, jobId: this.id, token, height: this.height });
      if (!r || r.error) throw new Error((r && r.error) || VCI18n.t('khong_mo_duoc_tab_14c6'));
      tabId = r.tabId;
      await outcome;
      await chain;
      if (!live()) return;
      this.message = VCI18n.t('dang_ghep_hinh_va_1aqd');
      this.capCovered = this.duration;
      this.render();
      outputs = await finishTracks(this, [sinks.video, sinks.audio], this.duration || 0);
    } catch (error) {
      if (this.mediaRun !== run) return;
      this.discardSpools();
      if (this.state !== 'cancelled') {
        this.state = 'error';
        this.error = error;
        this.message = error.name === 'AbortError' ? VCI18n.t('da_huy_atq6') : VCI18n.t('loi_1bgh', [error.message]);
      }
      this.render();
      pump();
      return;
    } finally {
      clearTimeout(connectTimer);
      clearInterval(quietTimer);
      controller.signal.removeEventListener('abort', onAbort);
      ytPorts.delete(name);
      try { if (port) port.disconnect(); } catch { /* đã đóng */ }
      if (tabId != null) chrome.runtime.sendMessage({ type: 'vc:ytCaptureStop', tabId }).catch(() => {});
    }
    if (this.mediaRun !== run || this.state === 'cancelled') return;
    this.outputs = outputs;
    await this.saveOutputs();
  }

  async runYouTube() {
    this.state = 'running';
    const controller = this.ctrl = new AbortController();
    const run = this.nativeRun = {};
    this.nativeFinishing = false;
    this.nativeSpeed = 0;
    this.nativeSpeedAt = 0;
    this.nativeEta = null;
    this.message = VCI18n.t('dang_ket_noi_bo_149i');
    this.render();
    let cancel;
    try {
      const task = VCNativeYouTube.download(this.url, this.height, (progress) => {
        if (this.nativeRun !== run || this.state !== 'running') return;
        this.bytes = progress.downloaded || 0;
        this.byteTotal = progress.total || 0;
        this.smoothSpeed('nativeSpeed', 'nativeSpeedAt', progress.speed || 0);
        const left = this.byteTotal > this.bytes ? this.byteTotal - this.bytes : 0;
        this.nativeEta = this.nativeSpeed > 0 && left ? left / this.nativeSpeed : progress.eta;
        this.nativeFinishing = progress.status === 'finished';
        this.render();
      }, (ready) => { if (this.nativeRun === run) this.nativeFolder = ready.downloadDir; });
      cancel = () => task.cancel();
      controller.signal.addEventListener('abort', cancel, { once: true });
      const result = await task.promise;
      if (this.nativeRun !== run) return;
      if (this.state !== 'cancelled') {
        this.finalSize = result.size;
        this.savedFile = result.file;
        this.savedTo = this.nativeFolder || '';
        // Bộ tải trên máy lưu vào thư mục riêng (không phải thư mục ở thanh trên): nói tên thư mục
        const folder = String(this.nativeFolder || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        this.message = folder ? VCI18n.t('da_luu_vao_zg9r', [folder]) : VCI18n.t('da_luu_5gxx');
        this.state = 'done';
        if (this.post && !this.postResult) { this.render(); pump(); await this.runPost(); }
      }
    } catch (error) {
      if (this.nativeRun !== run) return;
      if (this.state !== 'cancelled') {
        this.state = error.name === 'AbortError' ? 'cancelled' : 'error';
        this.error = error;
        this.errorPhase = 'download';
        this.message = error.name === 'AbortError' ? VCI18n.t('da_huy_ao21') : VCI18n.t('loi_1bgh', [error.message]);
      }
    } finally {
      if (cancel) controller.signal.removeEventListener('abort', cancel);
      if (this.nativeRun === run) { this.render(); pump(); }
    }
  }
}

// Danh sách chia nhóm: Đang tải / Cần xử lý / Đã xong (mục tự chuyển nhóm khi đổi trạng thái)
const groups = {};

// ---------- Tab Lỗi: mỗi video lỗi một thẻ gồm nguyên nhân, nhật ký và nút Tải lại ----------
const fmtClock = (t) => { const d = new Date(t); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); };
let activeTab = 'all';
const errorJobs = () => jobs.filter((j) => !j.removed && (j.state === 'error' || j.state === 'needperm'));
function setTab(tab) {
  activeTab = tab;
  $('#tabAll')?.setAttribute('aria-selected', String(tab === 'all'));
  $('#tabErrors')?.setAttribute('aria-selected', String(tab === 'errors'));
  const list = $('#jobs'), errors = $('#errorsView');
  if (list) list.hidden = tab !== 'all';
  if (errors) errors.hidden = tab !== 'errors';
  if (tab === 'errors') renderErrors();
}
function showErrorsTab(job) {
  setTab('errors');
  const panel = job && document.getElementById?.(`err-${job.id}`);
  if (panel) { panel.scrollIntoView?.({ block: 'start' }); const d = panel.querySelector('details'); if (d) d.open = true; }
}
let errorTimer = 0;
function updateErrorTab() {
  const n = errorJobs().length;
  const badge = $('#errCount');
  if (badge) { badge.textContent = n ? String(n) : ''; badge.hidden = !n; }
  if (activeTab === 'errors') { clearTimeout(errorTimer); errorTimer = setTimeout(renderErrors, 0); }
}
function errorPanel(j) {
  if (j.state === 'error' && !j.diag) j.showDiag();
  const d = j.diag || { title: VCI18n.t('cho_cap_quyen_ghi_pcrn'), hint: j.message, actions: [] };
  const acts = d.actions || [];
  const btns = el('div', { class: 'btns' });
  if (j.state === 'needperm') {
    btns.append(el('button', { class: 'primary', onclick: () => grantAndResume() }, VCI18n.t('cap_quyen_ghi_luu_1p5t')),
      el('button', { onclick: () => j.saveOutputs(true) }, VCI18n.t('luu_vao_downloads_1cm8')));
  } else if (acts.includes('saveAgain')) {
    btns.append(el('button', { class: 'primary', onclick: () => j.saveOutputs() }, VCI18n.t('luu_lai_33qa')),
      el('button', { onclick: () => retryFromErrors(j) }, VCI18n.t('tai_lai_tu_dau_1yb3')));
  } else btns.append(el('button', { class: 'primary', onclick: () => retryFromErrors(j) }, VCI18n.t('tai_lai_1iip')));
  const restart = restartBlock(j);
  if (acts.includes('openSource') && !restart) btns.append(el('button', { onclick: () => j.openSource() }, VCI18n.t('mo_trang_nguon_1v07')));
  if (acts.includes('browser')) btns.append(el('button', { onclick: () => j.switchToBrowser() }, VCI18n.t('tai_trong_trinh_duyet_zaqm')));
  if (acts.includes('fewer') && jobConcurrency > 1) btns.append(el('button', { onclick: () => { setConcurrency(1); j.retry(); } }, VCI18n.t('tai_1_video_moi_wkpd')));
  btns.append(el('button', { class: 'text', onclick: () => j.copyLog() }, VCI18n.t('sao_chep_nhat_ky_1qb5')));
  const log = el('ol', { class: 'log', tabindex: '0', 'aria-label': VCI18n.t('nhat_ky_tai_1ljk') }, j.log.length ? j.log.map((e) => el('li', { class: `lv-${e.lv}` },
    el('time', {}, fmtClock(e.t)), el('span', {}, `${e.m}${e.n > 1 ? ` (×${e.n})` : ''}`))) : el('li', {}, el('span', {}, VCI18n.t('chua_co_nhat_ky_1fmg'))));
  const kindName = { hls: 'HLS', dash: 'DASH', youtube: 'YouTube' }[j.kind] || 'File';
  return el('article', { class: 'card err-panel', id: `err-${j.id}` },
    el('div', { class: 'err-title' }, el('b', {}, j.nameInput?.value || j.title || 'Video'),
      el('span', {}, [kindName, j.quality && !/^(Gốc|MP4|Mặc định|Original|Default)$/.test(j.quality) ? String(j.quality).split(' · ')[0] : '', fmtClock(j.createdAt)].filter(Boolean).join(' · ')),
      el('button', { class: 'icon-btn', 'aria-label': VCI18n.t('xoa_jse6'), title: VCI18n.t('bo_khoi_danh_sach_gnnl'), onclick: () => removeJob(j) }, '✕')),
    el('div', { class: 'cause' }, el('b', {}, d.title || VCI18n.t('loi_vay3')), el('div', {}, d.hint || '')),
    restart,
    el('details', {}, el('summary', {}, VCI18n.t('nhat_ky_1vtq', [j.log.length])), log),
    btns);
}
// Bấm Tải lại ở tab Lỗi: về tab Tất cả để xem tiến độ (lỗi tiếp thì tự quay lại tab Lỗi)
function retryFromErrors(...list) {
  list.forEach((j) => j.retry());
  setTab('all');
}
// Đã bấm Tải lại mà vẫn lỗi: link tới trang video gốc để người dùng bắt đầu lại từ đầu (link phát mới)
function restartBlock(j) {
  const page = j.state === 'error' && j.retries > 0 ? j.sourcePage() : '';
  if (!page) return null;
  let host = '';
  try { host = new URL(page).host.replace(/^www\./, ''); } catch { /* bỏ qua */ }
  return el('div', { class: 'restart' },
    el('b', {}, j.retries > 1 ? VCI18n.t('da_tai_lai_lan_9hv2', [j.retries]) : VCI18n.t('tai_lai_van_loi_3q0a')),
    el('div', {}, VCI18n.t('link_tai_co_the_4fmp')),
    el('a', { class: 'source-link', href: page, target: '_blank', rel: 'noopener noreferrer', title: page,
      onclick: (e) => { e.preventDefault(); j.restartFromSource(); } }, VCI18n.t('mo_trang_video_goc_12gu', [host ? ` · ${host}` : ''])));
}
function renderErrors() {
  const box = $('#errorsView');
  if (!box) return;
  const list = errorJobs();
  if (!list.length) {
    box.replaceChildren(el('div', { class: 'empty-state' }, el('b', {}, VCI18n.t('khong_co_video_loi_gg03')), VCI18n.t('video_tai_loi_se_1y1d')));
    return;
  }
  const failed = list.filter((j) => j.state === 'error');
  box.replaceChildren(
    el('div', { class: 'err-head' }, el('span', {}, VCI18n.t('video_can_xu_ly_xpn8', [list.length])),
      failed.length > 1 ? el('button', { class: 'tonal', onclick: () => retryFromErrors(...failed.slice().reverse()) }, VCI18n.t('tai_lai_tat_ca_p0x1', [failed.length])) : null),
    ...list.map(errorPanel));
}
const groupOf = (state) => (state === 'done' ? 'done' : ['error', 'cancelled', 'needperm', 'duplicate'].includes(state) ? 'attn' : 'active');
function ensureGroups() {
  const box = $('#jobs');
  if (groups.active || !box) return;
  for (const [key, label] of [['active', VCI18n.t('dang_tai_1y2p')], ['attn', VCI18n.t('can_xu_ly_16qh')], ['done', VCI18n.t('da_xong_bsij')]]) {
    const count = el('span', { class: 'count' });
    const list = el('div', { class: 'group-list' });
    const sec = el('section', { class: `group g-${key}`, hidden: true }, el('h2', {}, label, ' ', count), list);
    groups[key] = { sec, list, count };
    box.append(sec);
  }
}
function placeJob(job, atTop) {
  ensureGroups();
  const key = groupOf(job.state);
  const g = groups[key];
  if (!g) return;
  job.group = key;
  if (atTop) g.list.prepend(job.node); else g.list.append(job.node);
  updateGroups();
}
function updateGroups() {
  for (const [key, g] of Object.entries(groups)) {
    const n = jobs.filter((j) => !j.removed && groupOf(j.state) === key).length;
    g.sec.hidden = !n;
    g.count.textContent = n ? `(${n})` : '';
  }
  const empty = document.getElementById ? document.getElementById('emptyState') : null;
  if (empty) empty.hidden = jobs.length > 0;
}

function removeJob(job) {
  if (['running', 'saving'].includes(job.state)) return;
  job.state = 'cancelled';
  job.removed = true;
  job.outputs = null;
  job.discardSpools();
  const index = jobs.indexOf(job);
  if (index >= 0) jobs.splice(index, 1);
  job.node.remove();
  updateGroups();
  updateErrorTab();
  saveHistory();
  pump();
}

function pump() {
  const running = jobs.filter((j) => j.state === 'running' || j.state === 'saving').length;
  let free = jobConcurrency - running;
  let ytBrowser = jobs.filter((j) => j.kind === 'youtube' && j.engine === 'browser' && j.state === 'running').length;
  for (const j of jobs.slice().reverse()) {
    if (free <= 0) break;
    if (j.state !== 'queued') continue;
    if (j.kind === 'youtube' && j.engine === 'browser') {
      if (ytBrowser >= YT_BROWSER_CONCURRENCY) continue;
      ytBrowser++;
    }
    free--;
    j.run();
  }
}

async function addJob(spec) {
  if (seenIds.has(spec.id)) return;
  seenIds.add(spec.id);
  const j = new Job(spec);
  Object.assign(j, { state: 'checking', message: VCI18n.t('dang_kiem_tra_video_oyr3') }); // chưa tải cho tới khi kiểm xong
  jobs.unshift(j);
  placeJob(j, true);
  j.render();
  let dup = null;
  try { dup = await findDuplicate(j); } catch { /* không kiểm được thì tải như bình thường */ }
  if (j.removed || j.state !== 'checking') return;
  if (dup) {
    j.dup = dup;
    Object.assign(j, { state: 'duplicate', message: dup.message });
    alertBar(dup.message);
  } else Object.assign(j, { state: 'queued', message: VCI18n.t('dang_cho_104q') });
  j.render();
  saveHistory();
  pump();
}

// ---------- Báo video trùng: đang tải ở mục khác, hoặc đã có trong ổ ----------
// Mã nhận diện video: YouTube = id video + chiều cao; nguồn khác = link bỏ phần query (token đổi theo phiên) + luồng/chất lượng
function videoKey(j) {
  if (j.kind === 'youtube') {
    const id = (/[?&]v=([\w-]{11})/.exec(j.url || '') || [])[1];
    return id ? `yt:${id}:${j.height || ''}` : '';
  }
  const strip = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return String(u || ''); } };
  if (!j.url) return '';
  return [j.kind, strip(j.url), j.audioUrl ? strip(j.audioUrl) : '', j.videoId ?? '', j.audioId ?? '', j.quality || ''].join('|');
}
const ACTIVE_STATES = ['checking', 'queued', 'running', 'paused', 'saving', 'needperm'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function findDuplicate(j) {
  const key = videoKey(j);
  const others = jobs.filter((o) => o !== j && !o.removed);
  // 1) Đang tải (hoặc chờ / tạm dừng) ở một mục khác
  const running = key && others.find((o) => ACTIVE_STATES.includes(o.state) && videoKey(o) === key);
  if (running) {
    const pct = running.state === 'running' && running.byteTotal ? ` (${Math.round((running.bytes / running.byteTotal) * 100)}%)` : '';
    return { type: 'active', other: running, message: VCI18n.t('video_nay_dang_duoc_3bzo', [pct]) };
  }
  // 2) Đã tải trước đây và file vẫn còn trong ổ (theo lịch sử Trình tải)
  for (const o of others.filter((x) => x.state === 'done' && key && videoKey(x) === key)) {
    const name = (o.savedNames && o.savedNames[0]) || o.outputBase();
    if (o.downloadIds.length) {
      const [d] = await chrome.downloads.search({ id: o.downloadIds[0] }).catch(() => []);
      if (d && d.exists === false) continue; // file đã bị xoá
      if (d && d.exists) return { type: 'disk', other: o, downloadId: d.id, message: VCI18n.t('video_nay_da_co_1045', [d.filename.split(/[\\/]/).pop()]) };
    }
    if (o.savedFolderHandle && o.savedFiles?.length) {
      try {
        if ((await o.savedFolderHandle.queryPermission({ mode: 'read' })) === 'granted') {
          await o.savedFolderHandle.getFileHandle(o.savedFiles[0].name);
          return { type: 'disk', other: o, message: VCI18n.t('video_nay_da_co_1ieo', [o.savedFolderHandle.name, o.savedFiles[0].name]) };
        }
      } catch (e) { if (e && e.name === 'NotFoundError') continue; }
    }
    return { type: 'history', other: o, message: VCI18n.t('video_nay_da_tai_1kml', [fmtClock(o.createdAt), new Date(o.createdAt).toLocaleDateString('vi-VN'), name]) };
  }
  // 3) Cùng tên file đã có ở nơi lưu (tải ở lần trước, đã xoá khỏi danh sách, hoặc link mới của cùng video)
  if (j.kind === 'youtube' && j.engine !== 'browser') return null; // bộ tải trên máy tự đặt tên, không kiểm được
  const base = j.outputBase();
  const ext = j.kind === 'file' ? safeExt(j.ext) : 'mp4';
  const name = `${base}.${ext}`;
  if (dest.handle) {
    if (!dest.granted) return null;
    try { await dest.handle.getFileHandle(name); return { type: 'disk', message: VCI18n.t('thu_muc_da_co_t20z', [dest.name, name]) }; }
    catch { return null; }
  }
  const found = await chrome.downloads.search({ filenameRegex: `(^|[\\\\/])${escapeRe(base)}( \\(\\d+\\))?\\.${ext}$`, exists: true, state: 'complete', limit: 1 }).catch(() => []);
  if (found[0]) return { type: 'disk', downloadId: found[0].id, message: VCI18n.t('downloads_da_co_file_8a3g', [found[0].filename.split(/[\\/]/).pop()]) };
  return null;
}

// Lịch sử nằm trong IndexedDB (giữ được handle thư mục đã lưu để "Mở thư mục" vẫn dùng được)
let historyStore = { get: () => idbGet('history'), set: (records) => idbSet('history', records) };
let historyTimer = 0;
let historyReady = false; // chưa khôi phục xong thì không ghi đè lịch sử cũ
// Chỉ nhắc giữ cửa sổ khi còn video đang chờ/tải/lưu
function updateKeepOpen() {
  const note = $('#keepOpen');
  if (note) note.hidden = !jobs.some((j) => !j.removed && ['queued', 'running', 'paused', 'saving', 'needperm'].includes(j.state));
  updatePauseAll();
}
// Nút trên thanh: Tạm dừng tất cả (khi còn mục tải được) / Tiếp tục tất cả (khi chỉ còn mục tạm dừng)
function updatePauseAll() {
  const b = $('#pauseAll');
  if (!b) return;
  const list = jobs.filter((j) => !j.removed && typeof j.canPause === 'function');
  const canPause = list.some((j) => j.canPause());
  b.hidden = !canPause && !list.some((j) => j.state === 'paused');
  const mode = canPause ? 'pause' : 'resume';
  if (b.vcMode === mode) return;
  b.vcMode = mode;
  b.innerHTML = mode === 'pause' ? ICON_PAUSE : ICON_PLAY;
  b.title = mode === 'pause' ? VCI18n.t('tam_dung_tat_ca_1rpe') : VCI18n.t('tiep_tuc_tat_ca_2tvy');
  b.setAttribute('aria-label', b.title);
}
function pauseAll() {
  const list = jobs.filter((j) => !j.removed && typeof j.canPause === 'function');
  if (list.some((j) => j.canPause())) {
    // Dừng mục đang chờ trước để pump() không khởi động chúng khi mục đang tải nhường chỗ
    list.filter((j) => j.state === 'queued').forEach((j) => j.pause());
    list.filter((j) => j.canPause()).forEach((j) => j.pause());
  } else list.slice().reverse().forEach((j) => j.resume()); // mục thêm trước tiếp tục trước
  updatePauseAll();
}
function saveHistory() {
  if (!historyReady) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    let records = jobs.filter((j) => !j.removed).slice(0, HISTORY_MAX).map((j) => j.record());
    Promise.resolve(historyStore.set(records)).catch(() => {
      // Handle thư mục không lưu được ở trình duyệt này -> lưu phần còn lại
      records = records.map((r) => ({ ...r, folder: null }));
      return historyStore.set(records);
    }).catch(() => {});
  }, 300);
}
// Chỉ một cửa sổ Trình tải được đọc/ghi lịch sử (cửa sổ thứ hai không đánh dấu nhầm mục đang chạy)
function claimHistory() {
  if (!navigator.locks || typeof navigator.locks.request !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request('vc-history-owner', { ifAvailable: true }, (lock) => {
      resolve(!!lock);
      return lock ? new Promise(() => {}) : null; // giữ khóa tới khi đóng cửa sổ
    }).catch(() => resolve(true));
  });
}
async function loadHistory() {
  if (!(await claimHistory())) return;
  try {
    const records = await historyStore.get();
    if (Array.isArray(records) && records.length) {
      const box = $('#jobs');
      for (const r of records.slice(0, HISTORY_MAX)) {
        if (!r || !r.spec || !r.spec.id || seenIds.has(r.spec.id)) continue;
        seenIds.add(r.spec.id);
        const j = new Job(r.spec, r);
        jobs.push(j);
        placeJob(j, false);
      }
    }
  } catch { /* chưa có lịch sử */ }
  historyReady = true;
  saveHistory(); // ghi lại trạng thái "gián đoạn" của các mục dở dang
}

// Khoá Web Locks: nếu lỡ có 2 cửa sổ trình tải thì mỗi việc chỉ do 1 cửa sổ nhận
function takeQueued() {
  return navigator.locks.request('vc-take-jobs', async () => {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('vcJob_')).sort();
    if (keys.length) await chrome.storage.session.remove(keys);
    for (const k of keys) addJob(all[k]);
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.keys(changes).some((k) => k.startsWith('vcJob_') && changes[k].newValue)) takeQueued();
  // Bật/tắt Tự động lưu từ Cài đặt của popup
  if (area === 'local' && changes.askSaveAs && !!changes.askSaveAs.newValue !== dest.askSaveAs) { dest.askSaveAs = !!changes.askSaveAs.newValue; renderDest(); }
  // Đổi số video tải cùng lúc từ Cài đặt của popup
  if (area === 'local' && changes.simultaneousVideos) {
    const n = Number(changes.simultaneousVideos.newValue);
    if ([1, 2, 3, 4, 5].includes(n) && n !== jobConcurrency) {
      jobConcurrency = n;
      const select = $('#simultaneousVideos');
      if (select) select.value = String(n);
      pump();
    }
  }
});

setInterval(() => { if (!document.hidden) jobs.forEach((j) => j.state === 'running' && j.render()); }, 700);
document.addEventListener('visibilitychange', () => { if (!document.hidden) jobs.forEach((j) => j.render()); });

$('#pauseAll')?.addEventListener('click', pauseAll);
$('#tabAll')?.addEventListener('click', () => setTab('all'));
$('#tabErrors')?.addEventListener('click', () => setTab('errors'));
$('#clearDone').addEventListener('click', () => {
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (['done', 'error', 'cancelled'].includes(jobs[i].state)) { jobs[i].discardSpools(); jobs[i].node.remove(); jobs.splice(i, 1); }
  }
  saveHistory();
  updateGroups();
});

window.addEventListener('beforeunload', (e) => {
  if (jobs.some((j) => ['running', 'paused', 'saving', 'queued', 'needperm'].includes(j.state))) { e.preventDefault(); e.returnValue = ''; }
});

function setConcurrency(n) {
  jobConcurrency = n;
  const select = $('#simultaneousVideos');
  if (select) select.value = String(n);
  chrome.storage.local.set({ simultaneousVideos: n }).catch(() => {});
}
async function loadTransferSettings() {
  const cfg = await chrome.storage.local.get({ simultaneousVideos: 5 });
  jobConcurrency = [1, 2, 3, 4, 5].includes(cfg.simultaneousVideos) ? cfg.simultaneousVideos : 5;
  const select = $('#simultaneousVideos');
  select.value = String(jobConcurrency);
  select.addEventListener('change', () => {
    jobConcurrency = [1, 2, 3, 4, 5].includes(Number(select.value)) ? Number(select.value) : 5;
    chrome.storage.local.set({ simultaneousVideos: jobConcurrency }).catch(() => {});
    pump();
  });
}
cleanupSpools();
VCI18n.init().then(() => Promise.all([loadDest(), loadTransferSettings(), loadHistory()])).then(takeQueued);
// Đổi ngôn ngữ trong Cài đặt: vẽ lại mọi thẻ (nút, trạng thái), thanh trên và tab Lỗi — không tải lại trang để không dừng lượt tải
VCI18n.onChange(() => {
  for (const j of jobs) { if (j.removed) continue; j.btnKey = null; j.metaCache = null; try { j.render(); } catch { /* thẻ cũ */ } }
  try { renderDest(); updateGroups(); updateErrorTab(); renderErrors(); } catch { /* bỏ qua */ }
});
