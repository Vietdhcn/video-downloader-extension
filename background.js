// Video Catcher – service worker
// Theo dõi request mạng của từng tab để phát hiện file video/audio và luồng HLS/DASH.
importScripts('lib/m3u8.js', 'lib/mpd.js');
importScripts('lib/youtube.js');
importScripts('lib/native-youtube.js');
importScripts('lib/locales/en.js', 'lib/locales/vi.js', 'lib/i18n.js');
VCI18n.init();

// YouTube: dùng bộ tải trên máy (yt-dlp) nếu đã cài; nếu không, tải ngay trong trình duyệt
// (lib/yt-capture.js) – chỉ cần mở Chrome, không phải cài thêm gì.
// Danh sách chất lượng + dung lượng đọc từ chính trang YouTube (~1 giây, đọc trước khi trang video tải xong),
// không phải chờ yt-dlp: helper chỉ cần trả lời "hello" để biết đang chạy được.
const youtubeInfoCache = new Map();
async function youtubePage(url) {
  let pr = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    if (res.ok) pr = VCYouTube.extractPlayerResponse(await res.text());
  } catch { /* không đọc được trang */ } finally { clearTimeout(timer); }
  const browser = VCYouTube.browserOptions(pr);
  return {
    title: browser.title, duration: browser.duration, playable: browser.playable,
    browserOptions: browser.options.length ? browser.options : [1080, 720, 480, 360].map((height) => ({ height, size: 0, codec: 'H.264', fps: 0 })),
    nativeOptions: VCYouTube.downloaderOptions(pr),
  };
}
// Bộ đệm có ghi nhận trạng thái (để biết kết quả đã sẵn sàng chưa mà không phải chờ)
function cachedTask(map, url, make, ttl, failTtl) {
  let entry = map.get(url);
  if (!entry) {
    entry = { state: 'pending' };
    entry.promise = make().then((value) => { entry.state = 'ok'; entry.value = value; return value; },
      (error) => { entry.state = 'error'; entry.error = error; setTimeout(() => { if (map.get(url) === entry) map.delete(url); }, failTtl); throw error; });
    entry.promise.catch(() => {});
    map.set(url, entry);
    setTimeout(() => { if (map.get(url) === entry) map.delete(url); }, ttl);
    if (map.size > 30) map.delete(map.keys().next().value);
  }
  return entry;
}
const pageCache = new Map();
const youtubePageInfo = (url) => cachedTask(pageCache, url, () => youtubePage(url), 120000, 5000);
// yt-dlp đầy đủ: chỉ dùng khi không đọc được danh sách từ trang
const nativeInfo = (url) => cachedTask(youtubeInfoCache, url, async () => {
  const info = await VCNativeYouTube.inspect(url);
  return { engine: 'native', ...info, options: info.options || info.heights.map((height) => ({ height })) };
}, 300000, 60000);
// Bộ tải trên máy có chạy không: một lệnh "hello" (dưới 1 giây), nhớ 5 phút nếu có, 30 giây nếu không
let helperCheck = null;
function helperReady() {
  if (!helperCheck || Date.now() - helperCheck.at > (helperCheck.ok ? 300000 : 30000)) {
    const entry = { at: Date.now(), ok: false, done: false };
    entry.promise = VCNativeYouTube.ping().then((ready) => { entry.ok = true; entry.downloadDir = ready.downloadDir; },
      (error) => { entry.error = error.message; }).then(() => { entry.done = true; return entry; });
    helperCheck = entry;
  }
  return helperCheck;
}
async function youtubeInfo(url) {
  const [page, helper] = await Promise.all([youtubePageInfo(url).promise, helperReady().promise]);
  if (helper.ok) {
    const base = { engine: 'native', title: page.title, duration: page.duration, downloadDir: helper.downloadDir };
    if (page.nativeOptions.length) return { ...base, heights: page.nativeOptions.map((o) => o.height), options: page.nativeOptions };
    try { return await nativeInfo(url).promise; } catch (error) { if (helperCheck === helper) helperCheck = null; throw error; }
  }
  return { engine: 'browser', title: page.title, duration: page.duration, heights: page.browserOptions.map((o) => o.height), options: page.browserOptions, nativeError: helper.error };
}
// Tab thu YouTube: lưu cả vào storage.session vì service worker có thể bị tắt giữa chừng
const captureKey = (tabId) => `vcCap_${tabId}`;
async function captureTab(tabId) {
  const key = captureKey(tabId);
  return (await chrome.storage.session.get(key))[key] || null;
}

const MAX_ITEMS = 100;
const MAX_CANDIDATES = 80;
const MIN_FILE_SIZE = 100 * 1024; // bỏ qua file < 100 KB (thường là preview/quảng cáo)
const MAX_SNIFF_SIZE = 5 * 1024 * 1024; // playlist không bao giờ lớn tới mức này
const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|ogv|flv|avi|3gp|mp3|m4a|ogg|wav|flac)(?:[?#/]|$)/i;
// .m3u8 / .mpd ở bất kỳ đâu trong đường dẫn (vd: /master.m3u8/token, /video.m3u8?x=1)
const STREAM_EXT = /\.(m3u8|mpd)(?:[?#/;&]|$)/i;
const STREAM_PARAM = /[?&](?:format|type|ext|output)=(?:m3u8|hls|mpd|dash)\b/i;
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|aac|vtt|webvtt|key)(?:[?#]|$)/i;
const STREAM_CT = /(mpegurl|dash\+xml|vnd\.apple\.mpegurl)/i;
const SEGMENT_CT = /(mp2t|iso\.segment)/i;
// Content-type mà server hay gán sai cho playlist HLS/DASH -> cần đọc thử vài byte đầu để biết
// (kể cả image/*, JSON: nhiều trang nguỵ trang playlist thành ảnh/API)
const SNIFF_CT = /^(?:$|text\/|application\/(?:octet-stream|force-download|x-unknown|json|javascript|x-javascript|xml|pdf)|binary\/octet-stream|image\/)/i;
const SKIP_EXT = /\.(js|mjs|css|svg|ico|woff2?|ttf|otf|map|wasm)(?:[?#]|$)/i;
// Link stream của YouTube (googlevideo) bị khoá theo phiên, chia hình/tiếng & mã hoá UMP -> tải trực tiếp không được
const UNUSABLE_HOST = /(^|\.)googlevideo\.com$/i;
// Tham số chỉ khác nhau giữa các request byte-range của cùng một file
const VOLATILE_PARAMS = ['range', 'rn', 'rbuf', 'bytestart', 'byteend', '_'];

const inlines = new Map(); // tabId -> Map(key -> { kind, text, base, ts })
const cache = new Map(); // tabId -> [{ url, key, kind, contentType, size, name, ts }]
const candidates = new Map(); // tabId -> [{ url, contentType, ts, checked }]
const observedSegments = new Map(); // .pdf responses verified as transport stream by the player hook
const storageKey = (tabId) => `tab_${tabId}`;

// Service worker MV3 có thể bị tắt bất cứ lúc nào -> khôi phục danh sách từ storage.session
const ready = chrome.storage.session
  .get(null)
  .then((all) => {
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('tab_')) cache.set(Number(k.slice(4)), v);
      if (k.startsWith('inl_')) inlines.set(Number(k.slice(4)), new Map(Object.entries(v)));
    }
  })
  .catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#e5383b' });
  // Sau khi cài/cập nhật/tải lại tiện ích: nạp lại content script vào các tab đang mở để nút tải
  // hoạt động ngay (bản cũ trong tab đã mồ côi và tự gỡ nút), không cần F5.
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).then((tabs) => {
    for (const t of tabs) {
      if (t.discarded) continue;
      chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['lib/youtube.js', 'lib/position.js', 'lib/frames.js', 'content.js'] }).catch(() => {});
    }
  }).catch(() => {});
});

// Gộp nhiều lần cập nhật (trang tải video theo từng khúc gây hàng chục sự kiện/giây) thành 1 lần ghi
const persistTimers = new Map();
const badgeCount = new Map();
function persist(tabId) {
  const n = (cache.get(tabId) || []).length;
  if (badgeCount.get(tabId) !== n) {
    badgeCount.set(tabId, n);
    chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  }
  if (persistTimers.has(tabId)) return;
  persistTimers.set(tabId, setTimeout(() => {
    persistTimers.delete(tabId);
    const list = cache.get(tabId) || [];
    const key = storageKey(tabId);
    if (list.length) chrome.storage.session.set({ [key]: list }).catch(() => {});
    else chrome.storage.session.remove(key).catch(() => {});
  }, 1000));
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    VOLATILE_PARAMS.forEach((p) => u.searchParams.delete(p));
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last) || new URL(url).hostname;
  } catch {
    return url;
  }
}

function addItem(tabId, item) {
  const list = cache.get(tabId) || [];
  const existing = list.find((x) => x.key === item.key);
  if (existing) {
    existing.ts = Math.max(existing.ts, item.ts);
    if (item.size && (!existing.size || item.size > existing.size)) existing.size = item.size;
    for (const key of ['height', 'quality', 'referer']) if (item[key]) existing[key] = item[key];
  } else {
    list.unshift(item);
    if (list.length > MAX_ITEMS) list.length = MAX_ITEMS;
  }
  cache.set(tabId, list);
  persist(tabId);
}

// Mẫu đường dẫn (bỏ số): các đoạn video cùng mẫu chỉ giữ 2 mục để không đẩy playlist ra khỏi danh sách
const patternOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\d+/g, '#'); } catch { return u; } };
function addCandidate(tabId, url, contentType, ts) {
  if (observedSegments.get(tabId)?.has(url)) return;
  const list = candidates.get(tabId) || [];
  if (list.some((c) => c.url === url)) return;
  const pat = patternOf(url);
  if (list.filter((c) => c.pattern === pat).length >= 2) return;
  list.unshift({ url, contentType, ts: ts || Date.now(), checked: false, pattern: pat });
  if (list.length > MAX_CANDIDATES) list.length = MAX_CANDIDATES;
  candidates.set(tabId, list);
}

// Request do Service Worker của trang gửi đi có tabId = -1 -> gán cho các tab cùng origin
async function resolveTabs(d) {
  if (d.tabId >= 0) return [d.tabId];
  const origin = d.initiator || '';
  if (!/^https?:/.test(origin)) return [];
  try {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((t) => { try { return new URL(t.url).origin === origin; } catch { return false; } })
      .map((t) => t.id);
  } catch {
    return [];
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.statusCode >= 400) return;
    const url = d.url;
    if (!/^https?:/i.test(url)) return;
    let host = '';
    try { host = new URL(url).hostname; } catch { return; }
    if (UNUSABLE_HOST.test(host)) return;

    const headers = {};
    for (const h of d.responseHeaders || []) headers[h.name.toLowerCase()] = h.value || '';
    const ct = (headers['content-type'] || '').toLowerCase().trim();

    if (SEGMENT_EXT.test(url) || SEGMENT_CT.test(ct)) return; // phân đoạn lẻ của luồng

    let size = null;
    const range = headers['content-range'] || ''; // vd: bytes 0-1023/123456
    const m = range.match(/\/(\d+)\s*$/);
    if (m) size = Number(m[1]);
    else if (headers['content-length']) size = Number(headers['content-length']);

    let kind = null;
    if (STREAM_CT.test(ct) || STREAM_EXT.test(url) || STREAM_PARAM.test(url)) kind = 'stream';
    else if (ct.startsWith('video/') || ct.startsWith('audio/') || MEDIA_EXT.test(url)) kind = 'file';

    if (!kind) {
      // Có thể là playlist bị gán content-type sai -> ghi nhớ, đọc thử khi mở popup
      const isFetch = d.type === 'xmlhttprequest' || d.type === 'other';
      if (isFetch && d.method === 'GET' && SNIFF_CT.test(ct) && !SKIP_EXT.test(url) && !(size > MAX_SNIFF_SIZE)) {
        resolveTabs(d).then((tabs) => tabs.forEach((t) => addCandidate(t, url, ct, d.timeStamp)));
      }
      return;
    }
    if (kind === 'file' && size !== null && size < MIN_FILE_SIZE) return;

    const clean = cleanUrl(url);
    const item = { url: clean, key: clean, kind, contentType: ct, size, name: nameFromUrl(clean), ts: d.timeStamp || Date.now() };
    Promise.all([ready, resolveTabs(d)]).then(([, tabs]) => tabs.forEach((t) => addItem(t, item)));
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders']
);

// Đọc vài trăm byte đầu để nhận diện playlist HLS (#EXTM3U) / DASH (<MPD)
async function sniff(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-2047' }, credentials: 'include', signal: ctrl.signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    let bytes = new Uint8Array(0);
    while (bytes.length < 2048) {
      const { value, done } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(bytes.length + value.length);
      merged.set(bytes);
      merged.set(value, bytes.length);
      bytes = merged;
    }
    reader.cancel().catch(() => {});
    const head = new TextDecoder().decode(bytes.slice(0, 2048)).replace(/^﻿/, '').trimStart();
    if (head.startsWith('#EXTM3U') || /#EXTM3U\s*[\r\n]+#EXT/.test(head)) return 'application/vnd.apple.mpegurl';
    if (/^(<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(head)) return 'application/dash+xml';
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function checkCandidates(tabId) {
  const list = (candidates.get(tabId) || []).filter((c) => !c.checked);
  await Promise.all(
    list.map(async (c) => {
      c.checked = true;
      const ct = await sniff(c.url);
      if (observedSegments.get(tabId)?.has(c.url)) return;
      if (!ct) return;
      const clean = cleanUrl(c.url);
      addItem(tabId, { url: c.url, key: clean, kind: 'stream', contentType: ct, size: null, name: nameFromUrl(clean), ts: c.ts });
    })
  );
}

// Trang mới -> xoá các mục của trang cũ. So theo thời điểm thay vì xoá hết: khi service worker vừa
// thức dậy, sự kiện commit có thể được giao SAU request media của chính trang mới.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  if (d.url) tabPages.set(d.tabId, d.url);
  observedSegments.delete(d.tabId);
  const since = d.timeStamp || Date.now();
  const keepNew = (x) => x.ts >= since;
  const inl = inlines.get(d.tabId);
  if (inl) { for (const [k, v] of inl) if (v.ts < since) inl.delete(k); persistInline(d.tabId); }
  const cand = (candidates.get(d.tabId) || []).filter(keepNew);
  if (cand.length) candidates.set(d.tabId, cand);
  else candidates.delete(d.tabId);
  ready.then(() => {
    const list = (cache.get(d.tabId) || []).filter(keepNew);
    if (list.length) cache.set(d.tabId, list);
    else cache.delete(d.tabId);
    persist(d.tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(captureKey(tabId)).catch(() => {});
  observedSegments.delete(tabId);
  badgeCount.delete(tabId);
  candidates.delete(tabId);
  inlines.delete(tabId);
  tabPages.delete(tabId);
  videoSrcs.delete(tabId);
  listedUrls.delete(tabId);
  persistInline(tabId);
  ready.then(() => {
    cache.delete(tabId);
    chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
  });
});

// Đuôi file tải về chỉ lấy trong danh sách media: đuôi lấy từ link/tên do trang web kiểm soát, không được
// để trang khiến tiện ích lưu file chạy được (.exe, .hta, .bat, .lnk…) dưới tên một video (SEC-001)
const SAFE_EXTS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'flv', 'avi', '3gp', 'ts', 'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'];
const safeExt = (ext, fallback = 'mp4') => (SAFE_EXTS.includes(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : fallback);
function safeFilename(name) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  if (m && SAFE_EXTS.includes(m[1].toLowerCase())) return name;
  return `${m ? name.slice(0, -m[0].length) : name}.mp4`;
}
const INLINE_TAB_LIMIT = 16e6; // tổng dung lượng playlist trang tự dựng giữ lại cho mỗi tab (SEC-003)
// Phần playlist trang tự dựng được ghi vào storage.session (hạn mức 10 MiB chung cho mọi tab và mục tải):
// mỗi tab tối đa 1,5 MB, tổng mọi tab 4 MB; phần còn lại chỉ giữ trong bộ nhớ (SEC-007)
const INLINE_PERSIST_TAB = 1.5e6;
const INLINE_PERSIST_TOTAL = 4e6;

// Máy trong mạng nội bộ / chính máy này (router, NAS, dịch vụ localhost). Tiện ích gửi request kèm cookie
// và không bị chặn như trang web, nên trang công khai không được khiến tiện ích gọi tới đó (SEC-005).
function isPrivateHost(host) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || /\.(localhost|local|lan|internal|intranet|home\.arpa)$/.test(host)) return true;
  if (host.includes(':')) return host === '::' || host === '::1' || /^(f[cd]|fe[89ab])/.test(host) || host.startsWith('::ffff:');
  if (!host.includes('.')) return true; // tên một nhãn: máy trong mạng LAN
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]), b = Number(v4[2]);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
// Được gửi request tới url không: chỉ http(s); máy nội bộ chỉ khi chính trang đang xem cũng nằm trong mạng nội bộ
const netAllowed = (url, page) => /^https?:\/\//i.test(String(url || '')) && (!isPrivateHost(hostOf(url)) || (/^https?:/i.test(String(page || '')) && isPrivateHost(hostOf(page))));
const tabPages = new Map(); // tabId -> URL trang (khung chính)
async function pageOf(tabId) {
  if (tabPages.has(tabId)) return tabPages.get(tabId);
  try { return (await chrome.tabs.get(tabId)).url || ''; } catch { return ''; }
}

function safeName(s) {
  const out = (s || 'video')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // ký tự đảo chiều chữ giả đuôi file khi hiển thị
    .replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100) || 'video';
  // Tên dành riêng của Windows (CON, NUL, COM1…): không tạo được file -> thêm dấu _
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(out) ? `_${out}` : out;
}

const asciiName = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^\x20-\x7e]/g, '_');

// ---------- Kèm phụ đề / thuyết minh (dữ liệu do CC and dịch tạo trong trang) ----------
// Cách ghép đi cùng mục tải (job.post); file ASS/SRT/WAV được content script gửi sau dưới dạng blob: URL,
// tải tạm vào Downloads/Video Catcher/_tmp rồi Trình tải đưa đường dẫn cho bộ tải trên máy (ffmpeg) ghép.
const POST_MODES = ['none', 'burn', 'track', 'both'], POST_DUB = ['none', 'mix', 'track', 'voice', 'both'];
function postSpecOf(x) {
  if (!x || typeof x !== 'object') return null;
  const subMode = POST_MODES.includes(x.subMode) ? x.subMode : 'none';
  const dubMode = POST_DUB.includes(x.dubMode) ? x.dubMode : 'none';
  if (subMode === 'none' && dubMode === 'none') return null;
  return { subMode, dubMode, useOnline: x.useOnline !== false, lang: String(x.lang || '').slice(0, 12) };
}
const postKey = (id) => `vcPost_${id}`;
const postOwnerKey = (id) => `vcPostOwner_${id}`;
const validJobId = (id) => typeof id === 'string' && /^[a-z0-9_]{3,40}$/i.test(id);
async function setPostState(id, patch) {
  const key = postKey(id);
  const cur = (await chrome.storage.session.get(key))[key] || {};
  const next = { ...cur, ...patch, at: Date.now() };
  await chrome.storage.session.set({ [key]: next });
  chrome.runtime.sendMessage({ type: 'vc:postState', jobId: id, state: next }).catch(() => {});
}
function waitDownload(id) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      if (state === 'complete') resolve(id);
      else chrome.downloads.search({ id }).then(([d]) => reject(new Error(VCI18n.t('khong_luu_duoc_file_lyqk', [(d && d.error) || state]))), () => reject(new Error(VCI18n.t('khong_luu_duoc_file_1gbs'))));
    };
    const onChanged = (d) => { if (d.id === id && d.state && d.state.current !== 'in_progress') finish(d.state.current); };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([d]) => { if (d && d.state !== 'in_progress') finish(d.state); });
    setTimeout(() => finish('timeout'), 10 * 60000);
  });
}
// Phiên gửi file tạm đang mở theo mục tải (content script gửi từng khúc base64, chuyển thẳng cho bộ tải trên máy)
const postSessions = new Map();
const POST_KINDS = ['ass', 'srt', 'voice', 'env'];
async function savePostAssets(jobId, urls) {
  const EXT = { ass: 'ass', srt: 'srt', voice: 'wav', env: 'wav' };
  const files = {};
  for (const kind of Object.keys(EXT)) {
    const url = urls[kind];
    if (!url) continue;
    if (typeof url !== 'string' || !url.startsWith('blob:')) throw new Error(VCI18n.t('du_lieu_phu_de_2xpo'));
    const filename = `Video Catcher/_tmp/${jobId}.${kind}.${EXT[kind]}`;
    expectName(url, filename, 'overwrite');
    const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'overwrite' });
    await waitDownload(id);
    const [d] = await chrome.downloads.search({ id });
    if (!d || !d.filename) throw new Error(VCI18n.t('khong_xac_dinh_duoc_emja'));
    files[kind] = d.filename;
    chrome.downloads.erase({ id }).catch(() => {});   // không để file tạm trong lịch sử tải (file vẫn còn, ffmpeg dùng xong sẽ xoá)
  }
  return files;
}

// Chrome có lúc BỎ QUA `filename` của downloads.download() với blob: URL (file ra tên ngẫu nhiên, không đuôi — không mở được).
// Ghi nhớ tên mong muốn theo URL rồi ép lại trong onDeterminingFilename (Trình tải báo tên qua vc:expectName).
const wantedNames = new Map();
function expectName(url, filename, conflictAction = 'uniquify') {
  if (typeof url !== 'string' || typeof filename !== 'string' || !filename) return;
  if (wantedNames.size > 200) wantedNames.delete(wantedNames.keys().next().value);
  wantedNames.set(url, { filename, conflictAction });
}
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const want = wantedNames.get(item.url) || wantedNames.get(item.finalUrl);
  if (!want) { suggest(); return; }
  wantedNames.delete(item.url); wantedNames.delete(item.finalUrl);
  suggest({ filename: want.filename, conflictAction: want.conflictAction });
});

async function startDownload(url, filename, saveAs) {
  const opts = { url, saveAs: !!saveAs, conflictAction: 'uniquify' };
  if (filename) {
    // Tên có dấu bị từ chối (tuỳ hệ thống) -> thử tên không dấu -> để Chrome tự đặt tên
    for (const name of [...new Set([filename, asciiName(filename)])]) {
      try {
        expectName(url, name);
        return await chrome.downloads.download({ ...opts, filename: name });
      } catch (e) {
        if (!/filename/i.test(e.message)) throw e;
      }
    }
  }
  return chrome.downloads.download(opts);
}

// ---------- Referer cho request do extension gửi (CDN hay chặn khi thiếu) ----------
// Mỗi máy chủ một ô cố định (mã luật = REF_BASE + 2·ô, +1 cho luật theo tab Trình tải), tối đa REF_SLOTS ô,
// bỏ ô dùng lâu nhất khi đầy. Trước đây mã luật là băm tên máy chủ (hai máy chủ trùng mã xoá luật của nhau)
// và luật không bao giờ được xoá: trang web làm cạn được giới hạn 5000 luật phiên (SEC-006).
const REF_BASE = 1000, REF_SLOTS = 500;
let refSlots = null; // host -> { slot, referer, strong }
async function refererSlots() {
  if (refSlots) return refSlots;
  const map = new Map();
  try {
    const old = await chrome.declarativeNetRequest.getSessionRules();
    const stale = [];
    for (const r of old) {
      const host = r.condition && r.condition.requestDomains && r.condition.requestDomains[0];
      const slot = (r.id - REF_BASE) >> 1;
      if (r.id >= REF_BASE && r.id < REF_BASE + 2 * REF_SLOTS && host) { if (!map.has(host)) map.set(host, { slot, referer: r.action.requestHeaders[0].value, strong: true }); }
      else stale.push(r.id); // luật theo mã băm của bản cũ
    }
    if (stale.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
  } catch { /* bỏ qua */ }
  return (refSlots = map);
}
// strong = true: Trình tải / trang tiện ích đặt cho một lượt tải -> ghi đè. false: khi đọc nguồn cho menu ->
// không ghi đè Referer đã có (trang web không đổi được Referer của lượt tải ở tab khác).
async function setReferer(urls, referer, strong = true) {
  if (!referer || !/^https?:/i.test(referer)) return;
  const slots = await refererSlots();
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))].filter((host) => strong || !slots.has(host)).slice(0, REF_SLOTS);
  if (!hosts.length) return;
  const used = new Set([...slots.values()].map((v) => v.slot));
  const removeIds = [];
  const placed = [];
  for (const host of hosts) {
    let slot = slots.get(host)?.slot;
    if (slot === undefined) {
      if (used.size < REF_SLOTS) { slot = 0; while (used.has(slot)) slot++; }
      else {
        // đầy: bỏ ô dùng lâu nhất; luật đọc từ menu chỉ thay được luật đọc từ menu khác, không thay luật của lượt tải
        const victim = [...slots].find(([h, v]) => !v.strong && !placed.includes(h)) || (strong && [...slots].find(([h]) => !placed.includes(h)));
        if (!victim) continue;
        slots.delete(victim[0]);
        slot = victim[1].slot;
      }
      used.add(slot);
    }
    slots.delete(host); // đưa lên cuối (dùng gần nhất)
    slots.set(host, { slot, referer, strong });
    placed.push(host);
    removeIds.push(REF_BASE + 2 * slot, REF_BASE + 2 * slot + 1);
  }
  if (!placed.length) return;
  hosts.length = 0;
  hosts.push(...placed);
  const rules = hosts.map((host) => ({
    id: REF_BASE + 2 * slots.get(host).slot,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
    // chỉ request của chính extension (trình tải, chrome.downloads) – không đụng tới request của trang
    // chỉ request do chính extension này gửi (không đụng request của trang hay của extension khác)
    condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE], initiatorDomains: [chrome.runtime.id] },
  }));
  const managerTabs = await managerTabIds();
  const rulesMgr = managerTabs.length
    ? hosts.map((host) => ({
        id: REF_BASE + 2 * slots.get(host).slot + 1,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referer }] },
        condition: { requestDomains: [host], tabIds: managerTabs },
      }))
    : [];
  const all = [...rules, ...rulesMgr];
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removeIds, addRules: all });
  } catch { /* bỏ qua */ }
}

// ---------- Playlist do trang tự dựng trong trình duyệt (báo từ hook.js) ----------
const inlineTimers = new Map();
const persistedInline = new Map(); // tabId -> số ký tự đã ghi vào storage.session
function persistInline(tabId) {
  if (inlineTimers.has(tabId)) return;
  inlineTimers.set(tabId, setTimeout(() => {
    inlineTimers.delete(tabId);
    const m = inlines.get(tabId);
    const k = `inl_${tabId}`;
    // bản mới nhất trước, trong hạn mức của tab và tổng hạn mức còn lại
    const others = [...persistedInline].reduce((n, [t, size]) => n + (t === tabId ? 0 : size), 0);
    const limit = Math.min(INLINE_PERSIST_TAB, INLINE_PERSIST_TOTAL - others);
    const keep = [];
    let size = 0;
    for (const [key, value] of [...(m || [])].reverse()) {
      if (size + value.text.length > limit) continue;
      keep.unshift([key, value]);
      size += value.text.length;
    }
    if (keep.length) {
      persistedInline.set(tabId, size);
      chrome.storage.session.set({ [k]: Object.fromEntries(keep) }).catch(() => persistedInline.delete(tabId));
    } else {
      persistedInline.delete(tabId);
      chrome.storage.session.remove(k).catch(() => {});
    }
  }, 2000));
}
const looksManifest = (t) => /^\uFEFF?\s*(#EXTM3U|(<\?xml[^>]*>\s*)?<MPD[\s>])/i.test(t) || /#EXTM3U\s*[\r\n]+#EXT/.test(String(t).slice(0, 4096));
// Bản sao các playlist trang tự dựng, gửi kèm mục tải: mục vẫn chạy được (kể cả khi còn chờ trong hàng
// hoặc bấm Thử lại) sau khi người dùng đóng tab video. Ưu tiên playlist của chính mục, rồi các playlist
// khác của tab (mức chất lượng / luồng tiếng mà playlist tổng trỏ tới), giới hạn dung lượng.
function inlineSnapshot(tabId, urls) {
  const m = inlines.get(tabId);
  if (!m || !m.size) return undefined;
  const out = {};
  let size = 0;
  const add = (key, value, limit) => {
    if (!value || out[key] || size + value.text.length > limit) return;
    out[key] = { text: value.text, base: value.base };
    size += value.text.length;
  };
  for (const u of urls.filter(Boolean)) {
    const value = m.get(u) || m.get(cleanUrl(u));
    add(u, value, 4e6);
  }
  for (const [key, value] of [...m].reverse()) add(key, value, 2e6);
  return Object.keys(out).length ? out : undefined;
}
function getInline(tabId, url) {
  const m = inlines.get(tabId);
  return (m && (m.get(url) || m.get(cleanUrl(url)))) || null;
}
// Đọc nội dung manifest: qua mạng, nếu không được (link blob:, nội dung bị mã hoá…) thì dùng bản trang đã dựng
async function manifestText(url, tabId) {
  const inl = getInline(tabId, url);
  if (inl && !VCM3U8.isWrapped(inl.text)) return { text: inl.text, base: inl.base || url };
  if (/^https?:/i.test(url) && !netAllowed(url, await pageOf(tabId))) {
    if (!inl) throw new Error(VCI18n.t('khong_doc_nguon_trong_dhuk'));
  } else if (/^https?:/i.test(url)) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (looksManifest(text) || !inl) return { text, base: res.url || url };
    } catch (e) {
      if (!inl) throw e;
    } finally {
      clearTimeout(t);
    }
  }
  if (inl) return { text: inl.text, base: /^https?:/i.test(url) ? url : inl.base };
  throw new Error(VCI18n.t('playlist_chi_ton_tai_vd87'));
}

// Dung lượng 1 file qua mạng (Range 0-0 -> Content-Range), không tải nội dung
async function probeLength(url, page) {
  if (!netAllowed(url, page)) return 0;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: ctrl.signal });
    const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    if (res.body) res.body.cancel().catch(() => {});
    return m ? Number(m[1]) : Number(res.headers.get('content-length')) || 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

// ---------- Thông tin luồng HLS: các mức chất lượng ----------
const streamInfoCache = new Map(); // tabId|url -> Promise<info>
async function fetchPlaylist(url, tabId) {
  const { text, base } = await manifestText(url, tabId);
  return VCM3U8.parse(text, base);
}
function streamInfo(url, tabId) {
  const ck = `${tabId}|${url}`;
  if (!streamInfoCache.has(ck)) {
    const p = (async () => {
      const pl = await fetchPlaylist(url, tabId);
      let variants;
      let media = pl;
      if (pl.type === 'master') {
        variants = pl.variants.map((v) => {
          const aud = v.audioGroup ? (pl.audios.filter((a) => a.group === v.audioGroup).sort((a, b) => b.isDefault - a.isDefault)[0]) : null;
          return { url: v.url, label: VCM3U8.qualityLabel(v), bandwidth: v.bandwidth, height: v.height, audioUrl: aud ? aud.url : null };
        });
        const needsPlayer = getInline(tabId, url)?.playerDecoded;
        if (needsPlayer) variants.forEach((variant) => {
          const video = getInline(tabId, variant.url);
          const audio = variant.audioUrl && getInline(tabId, variant.audioUrl);
          variant.needsPlayback = !video || VCM3U8.isWrapped(video.text) || !!(variant.audioUrl && (!audio || VCM3U8.isWrapped(audio.text)));
        });
        const usable = variants.find((variant) => !variant.needsPlayback);
        media = usable ? await fetchPlaylist(usable.url, tabId).catch(() => null) : null;
      } else {
        const height = VCM3U8.qualityFromUrl(url);
        variants = [{ url, label: height ? VCM3U8.qualityLabel({ height }) : 'MP4', bandwidth: 0, height, audioUrl: null }];
      }
      const duration = media && media.type === 'media' ? media.duration : 0;
      // BANDWIDTH giả (vd: 1 bps -> "117 B") không dùng để ước tính dung lượng
      variants.forEach((v) => { v.estSize = v.bandwidth >= 50000 && duration ? Math.round((v.bandwidth / 8) * duration) : null; });
      // Không có BANDWIDTH: cộng byterange nếu có, nếu không thì đo đoạn đầu × số đoạn
      if (media && media.type === 'media' && media.endList && variants.length === 1 && !variants[0].estSize) {
        const segs = media.segments;
        if (segs.every((sg) => sg.range)) variants[0].estSize = segs.reduce((n, sg) => n + sg.range.length, 0);
        else if (segs.length) {
          const first = await probeLength(segs[Math.min(1, segs.length - 1)].url, await pageOf(tabId));
          const d = segs[Math.min(1, segs.length - 1)].duration;
          if (first && d && duration) variants[0].estSize = Math.round((first / d) * duration);
          else if (first) variants[0].estSize = first * segs.length;
        }
      }
      // Ước tính phi lý (dưới 1 MB cho video trên 1 phút) thì bỏ, hiện "chưa rõ" còn hơn sai
      variants.forEach((v) => { if (v.estSize && duration > 60 && v.estSize < 1048576) v.estSize = null; });
      return {
        type: pl.type,
        auxiliary: pl.type === 'master' ? [...pl.audios, ...(pl.subtitles || [])].map((track) => track.url) : [],
        variants,
        duration,
        live: !!(media && media.type === 'media' && !media.endList),
        encrypted: !!(media && media.encrypted),
        drm: !!(media && media.drm),
        keyMethod: media ? media.keyMethod : '',
      };
    })();
    streamInfoCache.set(ck, p);
    // playlist trong trang có thể thay đổi (live) -> không giữ lâu
    setTimeout(() => streamInfoCache.delete(ck), getInline(tabId, url) ? 5000 : 120000);
    p.catch(() => setTimeout(() => streamInfoCache.delete(ck), 3000));
    if (streamInfoCache.size > 200) streamInfoCache.delete(streamInfoCache.keys().next().value);
  }
  return streamInfoCache.get(ck);
}

// Thông tin luồng DASH: các mức chất lượng
const dashCache = new Map();
function dashInfo(url, tabId) {
  const ck = `${tabId}|${url}`;
  if (!dashCache.has(ck)) {
    const p = (async () => {
      const { text, base } = await manifestText(url, tabId);
      const info = VCMPD.parse(text, base);
      return { type: 'dash', variants: VCMPD.variants(info), duration: info.duration, live: info.live, drm: info.drm };
    })();
    dashCache.set(ck, p);
    setTimeout(() => dashCache.delete(ck), 120000);
    p.catch(() => setTimeout(() => dashCache.delete(ck), 3000));
    if (dashCache.size > 100) dashCache.delete(dashCache.keys().next().value);
  }
  return dashCache.get(ck);
}

const videoSrcs = new Map(); // tabId -> link video.src trang đã báo gần đây (được tải từ menu trên trang)
const listedUrls = new Map(); // tabId -> Set các link (file, playlist, mức chất lượng, luồng tiếng) đã trả về cho menu/popup
function rememberListed(tabId, urls) {
  const set = listedUrls.get(tabId) || new Set();
  for (const u of urls) if (u) { set.delete(u); set.add(u); }
  while (set.size > 1000) set.delete(set.values().next().value);
  listedUrls.set(tabId, set);
}
async function getSources(tabId, videoSrc, referer, declaredSources = []) {
  const page = await pageOf(tabId);
  if (videoSrc && !netAllowed(videoSrc, page)) videoSrc = '';
  if (videoSrc) {
    const seen = videoSrcs.get(tabId) || [];
    videoSrcs.set(tabId, [videoSrc, ...seen.filter((u) => u !== videoSrc)].slice(0, 20));
  }
  for (const source of (Array.isArray(declaredSources) ? declaredSources : []).slice(0, MAX_ITEMS)) {
    if (!source || typeof source.url !== 'string' || source.url.length > 8000 || !netAllowed(source.url, page)) continue;
    const isStream = STREAM_EXT.test(source.url) || STREAM_CT.test(source.contentType || '');
    if (!isStream && !MEDIA_EXT.test(source.url) && !/^video\//i.test(source.contentType || '')) continue;
    const height = Number(source.height) || VCM3U8.qualityFromUrl(source.url);
    addItem(tabId, { url: source.url, key: cleanUrl(source.url), kind: isStream ? 'stream' : 'file',
      name: nameFromUrl(source.url), contentType: String(source.contentType || ''), size: null, ts: Date.now(),
      height: height >= 144 && height <= 8640 ? height : 0, referer: source.referer || referer });
  }
  const pre = cache.get(tabId) || [];
  const sourceReferer = pre.find((item) => item.kind === 'stream' && item.referer)?.referer || referer;
  await setReferer([...pre.map((x) => x.url), ...(candidates.get(tabId) || []).map((c) => c.url)], sourceReferer, false);
  await checkCandidates(tabId);
  const items = cache.get(tabId) || [];
  const files = items.filter((x) => x.kind === 'file').map((x) => {
    const height = x.height || VCM3U8.qualityFromUrl(x.url);
    return { url: x.url, size: x.size, contentType: x.contentType, name: x.name, height,
      quality: height ? VCM3U8.qualityLabel({ height }) : '', referer: x.referer || sourceReferer };
  }).sort((a, b) => b.height - a.height);
  if (videoSrc && /^https?:/i.test(videoSrc) && !STREAM_EXT.test(videoSrc) && !items.some((x) => x.kind === 'stream' && x.key === cleanUrl(videoSrc))) {
    const key = cleanUrl(videoSrc);
    const i = files.findIndex((f) => f.url === key || f.url === videoSrc);
    const own = i >= 0 ? files.splice(i, 1)[0] : { url: videoSrc, size: null, contentType: '', name: nameFromUrl(videoSrc) };
    own.isVideoSrc = true;
    files.unshift(own);
  }
  const streams = [];
  const pendingStreams = items.filter((it) => it.kind === 'stream');
  let streamCursor = 0;
  const streamWorker = async () => {
   while (streamCursor < pendingStreams.length) {
    const index = streamCursor++;
    const x = pendingStreams[index];
    const isDash = /\.mpd(?:[?#/;&]|$)|dash/i.test(x.url + ' ' + x.contentType);
    if (isDash) {
      try {
        streams[index] = { url: x.url, name: x.name, kind: 'dash', referer: x.referer || sourceReferer, inline: !!x.inline, ...(await dashInfo(x.url, tabId)) };
      } catch (e) {
        streams[index] = { url: x.url, name: x.name, kind: 'dash', error: e.message, variants: [] };
      }
      continue;
    }
    try {
      streams[index] = { url: x.url, name: x.name, kind: 'hls', referer: x.referer || sourceReferer, inline: !!x.inline, ...(await streamInfo(x.url, tabId)) };
      if (streams[index].type === 'media' && x.height) streams[index].variants = streams[index].variants.map((v) =>
        v.height ? v : { ...v, height: x.height, label: VCM3U8.qualityLabel({ height: x.height }) });
    } catch (e) {
      streams[index] = { url: x.url, name: x.name, kind: 'hls', error: e.message, variants: [] };
    }
   }
  };
  await Promise.all(Array.from({ length: Math.min(4, pendingStreams.length) }, streamWorker));
  // Bỏ playlist con đã nằm trong một playlist tổng (master)
  const childUrls = new Set();
  streams.filter((s) => s.type === 'master').forEach((s) => s.variants.forEach((v) => { childUrls.add(v.url); if (v.audioUrl) childUrls.add(v.audioUrl); }));
  streams.filter((s) => s.type === 'master').forEach((s) => (s.auxiliary || []).forEach((url) => childUrls.add(url)));
  const finalStreams = streams.filter((s) => {
    if (s.url.startsWith('hls-levels:') && streams.some((other) => other.type === 'master' && other.url === getInline(tabId, s.url)?.base)) return false;
    return s.type === 'master' || !childUrls.has(s.url);
  });
  rememberListed(tabId, [...files.map((f) => f.url), ...finalStreams.flatMap((st) => [st.url, ...(st.variants || []).flatMap((v) => [v.url, v.audioUrl])])]);
  return { files, streams: finalStreams };
}

// ---------- Cửa sổ quản lý tải ----------
const MANAGER_URL = chrome.runtime.getURL('manager.html');
async function managerTabIds() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [MANAGER_URL] });
    return ctx.map((c) => c.tabId).filter((id) => id >= 0);
  } catch {
    return [];
  }
}
let openingManager = null;
// show = true: người dùng chủ động mở Trình tải -> đưa ra trước.
// show = false: vừa thêm mục tải -> chỉ cần Trình tải chạy; mở thu nhỏ, không che màn hình, không giành focus.
async function openManager(show = true) {
  if (openingManager) return openingManager.then(() => (show ? openManager(true) : undefined)); // nhiều lệnh tải liên tiếp -> chỉ mở 1 cửa sổ
  openingManager = (async () => {
    const reveal = (windowId) => (show ? chrome.windows.update(windowId, { state: 'normal', focused: true }) : chrome.windows.get(windowId));
    const { vcManagerWindow } = await chrome.storage.session.get('vcManagerWindow');
    if (vcManagerWindow) {
      try { await reveal(vcManagerWindow); return; } catch { /* cửa sổ đã đóng */ }
    }
    try {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [MANAGER_URL] });
      if (ctx.length) {
        await reveal(ctx[0].windowId);
        await chrome.storage.session.set({ vcManagerWindow: ctx[0].windowId });
        return;
      }
    } catch { /* bỏ qua */ }
    const w = await chrome.windows.create(show ? { url: MANAGER_URL, type: 'popup', width: 540, height: 600 }
      : { url: MANAGER_URL, type: 'popup', state: 'minimized', focused: false });
    // Cửa sổ thu nhỏ không bị Chrome giải phóng bộ nhớ giữa lúc đang tải
    const tabId = w.tabs && w.tabs[0] && w.tabs[0].id;
    if (tabId != null) chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
    await chrome.storage.session.set({ vcManagerWindow: w.id });
  })().finally(() => { openingManager = null; });
  return openingManager;
}
async function queueHls(job) {
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await chrome.storage.session.set({ [`vcJob_${id}`]: { id, ...job } });
  } catch (e) {
    // hết hạn mức storage.session: vẫn xếp hàng, bỏ bản sao playlist (Trình tải hỏi lại khi cần) (SEC-007)
    if (!job.inline || !/quota/i.test(e.message)) throw e;
    const { inline, ...rest } = job;
    await chrome.storage.session.set({ [`vcJob_${id}`]: { id, ...rest } });
  }
  await openManager(true); // một cửa sổ Trình tải nhỏ hiện lên, như hộp thoại tải của IDM
  return id;
}

// Link và Referer tiện ích đã bắt được trong tab: mục đã liệt kê, video.src trang báo, các mức chất lượng
// và luồng tiếng của playlist đã đọc (chỉ đọc từ bộ đệm, không gửi request mới)
async function knownTabUrls(tabId) {
  const urls = new Set([...(videoSrcs.get(tabId) || []), ...(listedUrls.get(tabId) || [])]);
  const referers = new Set();
  for (const item of cache.get(tabId) || []) {
    urls.add(item.url);
    if (item.key) urls.add(item.key);
    if (item.referer) referers.add(item.referer);
  }
  const infos = [...streamInfoCache, ...dashCache].filter(([key]) => key.startsWith(`${tabId}|`)).map(([, p]) => p.catch(() => null));
  for (const info of await Promise.all(infos)) {
    for (const v of (info && info.variants) || []) { if (v.url) urls.add(v.url); if (v.audioUrl) urls.add(v.audioUrl); }
  }
  return { urls, referers };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('vc:')) return false;
  // Trang của tiện ích (popup, Trình tải, Chẩn đoán) được hỏi dữ liệu của tab bất kỳ; content script chỉ của
  // chính tab nó chạy. Content script là ranh giới kém tin cậy hơn (renderer của trang web) (SEC-002).
  const fromExtension = String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  const ownTab = sender.tab && sender.tab.id;
  const tabOf = (id) => (fromExtension && id != null ? id : ownTab);
  const extensionOnly = () => { if (!fromExtension) throw new Error(VCI18n.t('khong_duoc_phep_15dn')); };
  if (!fromExtension && Number.isInteger(ownTab) && sender.tab.url) tabPages.set(ownTab, sender.tab.url);
  // Referer content script được dùng: chỉ URL của chính khung gửi / trang, không lấy từ tin nhắn (SEC-009)
  const ownReferer = String(sender.url || (sender.tab && sender.tab.url) || '');
  (async () => {
    await ready;
    switch (msg.type) {
      case 'vc:getMedia': {
        const tabId = tabOf(msg.tabId);
        await checkCandidates(tabId);
        return { items: cache.get(tabId) || [] };
      }
      case 'vc:openDiagnostics': {
        const tabId = sender.tab && sender.tab.id;
        if (!Number.isInteger(tabId)) throw new Error(VCI18n.t('khong_xac_dinh_duoc_1a0t'));
        await chrome.tabs.create({ url: chrome.runtime.getURL(`diagnostics.html?tabId=${tabId}`) });
        return { ok: true };
      }
      case 'vc:diagnostics': {
        const tabId = Number(tabOf(msg.tabId));
        if (!Number.isInteger(tabId) || tabId < 0) throw new Error(VCI18n.t('tab_khong_hop_le_1kig'));
        return {
          version: chrome.runtime.getManifest().version,
          media: cache.get(tabId) || [],
          candidates: candidates.get(tabId) || [],
          pdfSegments: observedSegments.get(tabId)?.size || 0,
          manifests: [...(inlines.get(tabId) || new Map())].map(([key, value]) => ({ key, kind: value.kind, base: value.base, playerDecoded: value.playerDecoded, length: value.text.length })),
        };
      }
      case 'vc:probeSource': {
        extensionOnly();
        const entry = getInline(msg.tabId, msg.url);
        if (!entry || entry.kind !== 'hls') throw new Error(VCI18n.t('chua_co_playlist_da_z5qf'));
        const playlist = VCM3U8.parse(entry.text, entry.base || msg.url);
        if (playlist.drm || !playlist.segments?.length) throw new Error(VCI18n.t('nguon_nay_chua_co_yrx9'));
        const url = playlist.segments[0].url;
        if (!netAllowed(url, await pageOf(msg.tabId))) throw new Error(VCI18n.t('khong_doc_nguon_trong_dhuk'));
        const ref = (cache.get(msg.tabId) || []).find((item) => item.url === msg.url)?.referer;
        await setReferer([url], ref);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const response = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-65535' }, signal: ctrl.signal });
          if (!response.ok || !response.body) return { status: response.status, url };
          const reader = response.body.getReader();
          let total = 0;
          while (total < 65536) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
          }
          reader.cancel().catch(() => {});
          return { status: response.status, bytesRead: total, contentType: response.headers.get('content-type'), url };
        } finally { clearTimeout(timer); }
      }
      case 'vc:clearMedia': {
        const tabId = tabOf(msg.tabId);
        cache.delete(tabId);
        candidates.delete(tabId);
        persist(tabId);
        return { ok: true };
      }
      case 'vc:download': {
        const cfg = await chrome.storage.local.get({ subfolder: 'Video Catcher', askSaveAs: false });
        extensionOnly();
        const name = safeFilename(msg.filename ? String(msg.filename) : `${safeName(sender.tab && sender.tab.title)}.${safeExt(msg.ext)}`);
        const saveAs = msg.saveAs || cfg.askSaveAs;
        // (chrome.downloads không gửi được Referer – file cần Referer hãy tải qua Trình tải)
        return { ok: true, id: await startDownload(msg.url, cfg.subfolder ? `${safeName(cfg.subfolder)}/${name}` : name, saveAs) };
      }
      case 'vc:sources': {
        if (fromExtension) return getSources(tabOf(msg.tabId), msg.videoSrc, msg.referer || (sender.tab && sender.tab.url), msg.declaredSources);
        const declared = (Array.isArray(msg.declaredSources) ? msg.declaredSources : []).map((x) => (x && typeof x === 'object' ? { ...x, referer: ownReferer } : x));
        return getSources(ownTab, msg.videoSrc, ownReferer, declared);
      }
      case 'vc:youtubeInfo': {
        const url = VCYouTube.normalize(msg.url || (sender.tab && sender.tab.url));
        if (!url) throw new Error(VCI18n.t('hay_mo_mot_video_13jc'));
        return youtubeInfo(url);
      }
      case 'vc:helperStatus': {
        const h = await helperReady().promise;
        return { ok: !!h.ok, error: h.error || '' };
      }
      case 'vc:youtubePrefetch': {
        // Người dùng rê chuột lên video YouTube: bắt đầu đọc chất lượng trước khi mở menu
        const url = VCYouTube.normalize(msg.url || (sender.tab && sender.tab.url));
        if (url) { youtubePageInfo(url); helperReady(); }
        return { ok: true };
      }
      case 'vc:youtube': {
        const url = VCYouTube.normalize(msg.url || (sender.tab && sender.tab.url));
        if (!url) throw new Error(VCI18n.t('hay_mo_mot_video_13jc'));
        const info = await youtubeInfo(url);
        let height = msg.height == null ? info.heights.find((h) => h <= 1080) || info.heights[0] : Number(msg.height);
        // Mức đã chọn không còn (danh sách cũ): dùng mức gần nhất không cao hơn
        if (!info.heights.includes(height) && Number.isInteger(height) && height >= 144) height = info.heights.find((h) => h <= height) || 0;
        if (!info.heights.includes(height)) throw new Error(VCI18n.t('chat_luong_video_khong_haou'));
        const option = (info.options || []).find((o) => o.height === height);
        const pageTitle = typeof msg.title === 'string' ? msg.title.slice(0, 300) : '';
        const post = postSpecOf(msg.post);
        const id = await queueHls({ kind: 'youtube', engine: info.engine, url, height, quality: `${height}p`,
          title: info.title || pageTitle || 'YouTube', duration: info.duration || 0, estSize: option?.size || null, nativeFolder: info.downloadDir, ...(post ? { post } : {}) });
        if (post) await chrome.storage.session.set({ [postOwnerKey(id)]: ownTab ?? -1 });
        return { ok: true, id };
      }
      case 'vc:ytCaptureStart': {
        // Chỉ Trình tải gọi lệnh này (không nhận từ trang web)
        if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(MANAGER_URL)) throw new Error(VCI18n.t('khong_duoc_phep_15dn'));
        const url = VCYouTube.normalize(msg.url);
        const height = Number(msg.height);
        if (!url || !/^[\w-]{6,64}$/.test(msg.jobId || '') || !/^[\w-]{8,64}$/.test(msg.token || '') || !Number.isInteger(height) || height < 144 || height > 4320) throw new Error(VCI18n.t('yeu_cau_thu_youtube_175v'));
        const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
        const [prev] = win ? await chrome.tabs.query({ active: true, windowId: win.id }) : [];
        // Mở ở phía trước: Chrome hoãn phát media trong tab nền chưa từng hiển thị
        const tab = await chrome.tabs.create({ url: `${url}#vc-capture=${msg.jobId}.${msg.token}.${height}`, active: true,
          ...(win ? { windowId: win.id } : {}), ...(prev ? { index: prev.index + 1 } : {}) });
        await chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
        await chrome.storage.session.set({ [captureKey(tab.id)]: { prevTabId: prev ? prev.id : null, returned: false, at: Date.now() } });
        return { ok: true, tabId: tab.id };
      }
      case 'vc:ytCaptureStarted': {
        // Đã có dữ liệu: trả người dùng về tab cũ, tab thu tiếp tục chạy nền (đã tắt tiếng)
        const tabId = sender.tab && sender.tab.id;
        const info = Number.isInteger(tabId) ? await captureTab(tabId) : null;
        if (!info || info.returned) return { ok: false };
        info.returned = true;
        await chrome.storage.session.set({ [captureKey(tabId)]: info });
        if (msg.audible !== false && info.prevTabId != null) {
          const [active] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
          if (active && active.id === tabId) await chrome.tabs.update(info.prevTabId, { active: true }).catch(() => {});
        }
        return { ok: true };
      }
      case 'vc:ytCaptureEnded': {
        const tabId = sender.tab && sender.tab.id;
        if (Number.isInteger(tabId) && await captureTab(tabId)) {
          await chrome.storage.session.remove(captureKey(tabId));
          setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
        }
        return { ok: true };
      }
      case 'vc:ytCaptureStop': {
        if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(MANAGER_URL)) throw new Error(VCI18n.t('khong_duoc_phep_15dn'));
        const tabId = Number(msg.tabId);
        if (Number.isInteger(tabId) && await captureTab(tabId)) {
          await chrome.storage.session.remove(captureKey(tabId));
          await chrome.tabs.remove(tabId).catch(() => {});
        }
        return { ok: true };
      }
      case 'vc:startHls': {
        const title = String(msg.title || (sender.tab && sender.tab.title) || 'video').slice(0, 300);
        const tabId = tabOf(msg.tabId);
        const kind = msg.kind || 'hls';
        if (typeof msg.url !== 'string' || msg.url.length > 8000) throw new Error(VCI18n.t('link_khong_hop_le_p0fp'));
        let referer = msg.referer || (sender.tab && sender.tab.url) || '';
        if (!fromExtension) {
          // Content script (renderer của trang web): chỉ loại hls/dash/file, chỉ link đã bắt được trong chính tab,
          // Referer là trang gửi hoặc Referer tiện ích đã ghi nhận cho tab (SEC-009)
          if (!['hls', 'dash', 'file'].includes(kind)) throw new Error(VCI18n.t('khong_duoc_phep_15dn'));
          const known = await knownTabUrls(tabId);
          if (!known.urls.has(msg.url) || (msg.audioUrl && !known.urls.has(msg.audioUrl))) throw new Error(VCI18n.t('link_chua_duoc_bat_1lx3'));
          referer = known.referers.has(msg.referer) ? msg.referer : ownReferer;
        }
        const page = await pageOf(tabId);
        for (const u of [msg.url, msg.audioUrl]) if (u && /^https?:/i.test(u) && !netAllowed(u, page)) throw new Error(VCI18n.t('khong_tai_tu_dia_12jo'));
        const job = { kind, url: msg.url, audioUrl: msg.audioUrl || null, quality: msg.quality || '', title, referer, tabId };
        // Trang video (khung chính): Trình tải mở lại trang này khi tải lại vẫn lỗi. referer có thể là iframe trình phát.
        if (/^https?:\/\//i.test(page)) job.page = page;
        for (const k of ['videoId', 'audioId', 'height', 'bandwidth', 'parts', 'duration', 'estSize', 'size', 'ext']) if (msg[k] !== undefined && msg[k] !== null) job[k] = msg[k];
        if (job.ext !== undefined) job.ext = safeExt(job.ext);
        if (job.kind === 'hls' || job.kind === 'dash') {
          const snapshot = inlineSnapshot(tabId, [msg.url, msg.audioUrl]);
          if (snapshot) job.inline = snapshot;
        }
        const post = postSpecOf(msg.post);
        if (post) job.post = post;
        const id = await queueHls(job);
        if (post) await chrome.storage.session.set({ [postOwnerKey(id)]: ownTab ?? -1 });
        return { ok: true, id };
      }
      case 'vc:expectName': {
        // Trình tải sắp gọi downloads.download(): ghi nhớ tên để ép lại nếu Chrome bỏ qua filename
        extensionOnly();
        expectName(msg.url, String(msg.filename || '').slice(0, 400));
        return { ok: true };
      }
      case 'vc:postBegin':
      case 'vc:postChunk':
      case 'vc:postEnd':
      case 'vc:postProgress':
      case 'vc:postError':
      case 'vc:postAssets': {
        // Chỉ content script của chính tab đã tạo mục tải (hoặc trang của tiện ích) được gửi dữ liệu cho mục đó
        if (!validJobId(msg.jobId)) throw new Error(VCI18n.t('ma_muc_tai_khong_uspi'));
        const owner = (await chrome.storage.session.get(postOwnerKey(msg.jobId)))[postOwnerKey(msg.jobId)];
        if (owner === undefined) throw new Error(VCI18n.t('muc_tai_khong_cho_1yeu'));
        if (!fromExtension && owner !== ownTab) throw new Error(VCI18n.t('khong_duoc_phep_15dn'));
        if (msg.type === 'vc:postProgress') {
          await setPostState(msg.jobId, { status: 'working', progress: { phase: String(msg.phase || '').slice(0, 20), done: Number(msg.done) || 0, total: Number(msg.total) || 0, note: String(msg.note || '').slice(0, 200) } });
          return { ok: true };
        }
        if (msg.type === 'vc:postError') {
          const s0 = postSessions.get(msg.jobId); if (s0) { s0.abort(); postSessions.delete(msg.jobId); }
          await setPostState(msg.jobId, { status: 'error', error: String(msg.error || VCI18n.t('loi_nqa6')).slice(0, 300) });
          return { ok: true };
        }
        if (msg.type === 'vc:postBegin') {
          const old = postSessions.get(msg.jobId); if (old) old.abort();
          const session = VCNativeYouTube.stage(msg.jobId);
          try { await session.ready(); } catch (error) { await setPostState(msg.jobId, { status: 'error', error: error.message }); throw error; }
          postSessions.set(msg.jobId, session);
          await setPostState(msg.jobId, { status: 'working', progress: { phase: 'transfer', done: 0, total: 0, note: '' } });
          return { ok: true };
        }
        if (msg.type === 'vc:postChunk') {
          const session = postSessions.get(msg.jobId);
          if (!session) throw new Error(VCI18n.t('phien_gui_file_da_hf4b'));
          if (!POST_KINDS.includes(msg.kind) || typeof msg.data !== 'string' || msg.data.length > 6 * 1024 * 1024) throw new Error(VCI18n.t('khuc_du_lieu_khong_1t9i'));
          try { await session.chunk(msg.kind, msg.data); }
          catch (error) { postSessions.delete(msg.jobId); await setPostState(msg.jobId, { status: 'error', error: error.message }); throw error; }
          return { ok: true };
        }
        if (msg.type === 'vc:postEnd') {
          const session = postSessions.get(msg.jobId);
          postSessions.delete(msg.jobId);
          if (!session) throw new Error(VCI18n.t('phien_gui_file_da_hf4b'));
          try {
            const files = await session.end();
            if (!Object.keys(files).length) throw new Error(VCI18n.t('cc_and_dich_khong_zi4b'));
            const meta = msg.meta && typeof msg.meta === 'object' ? { notes: Array.isArray(msg.meta.notes) ? msg.meta.notes.slice(0, 5).map((x) => String(x).slice(0, 200)) : [], voice: msg.meta.voice && typeof msg.meta.voice === 'object' ? { name: String(msg.meta.voice.name || '').slice(0, 80) } : null, partial: !!msg.meta.partial, spoken: Number(msg.meta.spoken) || 0 } : {};
            await setPostState(msg.jobId, { status: 'ready', files, meta });
          } catch (error) { await setPostState(msg.jobId, { status: 'error', error: error.message }); throw error; }
          return { ok: true };
        }
        try {
          const files = await savePostAssets(msg.jobId, msg.urls && typeof msg.urls === 'object' ? msg.urls : {});
          if (!Object.keys(files).length) throw new Error(VCI18n.t('cc_and_dich_khong_zi4b'));
          const meta = msg.meta && typeof msg.meta === 'object' ? { notes: Array.isArray(msg.meta.notes) ? msg.meta.notes.slice(0, 5).map((n) => String(n).slice(0, 200)) : [], voice: msg.meta.voice && typeof msg.meta.voice === 'object' ? { name: String(msg.meta.voice.name || '').slice(0, 80) } : null, partial: !!msg.meta.partial, spoken: Number(msg.meta.spoken) || 0 } : {};
          await setPostState(msg.jobId, { status: 'ready', files, meta });
        } catch (error) {
          await setPostState(msg.jobId, { status: 'error', error: error.message });
          throw error;
        }
        return { ok: true };
      }
      case 'vc:segment': {
        const tabId = sender.tab && sender.tab.id;
        if (!Number.isInteger(tabId) || typeof msg.url !== 'string' || msg.url.length > 2000 || !/^https?:\/\//i.test(msg.url) || !/\.pdf(?:[?#]|$)/i.test(msg.url)) return { ok: false };
        let segments = observedSegments.get(tabId);
        if (!segments) observedSegments.set(tabId, segments = new Set());
        segments.add(msg.url);
        if (segments.size > 500) segments.delete(segments.values().next().value);
        candidates.set(tabId, (candidates.get(tabId) || []).filter((item) => item.url !== msg.url));
        return { ok: true };
      }
      case 'vc:inline': {
        const tabId = sender.tab && sender.tab.id;
        if (tabId == null || typeof msg.key !== 'string' || typeof msg.text !== 'string' || !looksManifest(msg.text)) return { ok: false };
        const key = /^https?:/i.test(msg.key) ? cleanUrl(msg.key) : msg.key;
        if (!inlines.has(tabId)) inlines.set(tabId, new Map());
        const m = inlines.get(tabId);
        m.delete(key); // đưa lên cuối: bản mới nhất bị xoá sau cùng
        m.set(key, { kind: msg.kind, text: msg.text, base: msg.base, playerDecoded: !!msg.playerDecoded, ts: Date.now() });
        // Trang web có thể giả sự kiện playlist: giới hạn tổng dung lượng giữ cho mỗi tab, bỏ bản cũ nhất
        let stored = 0;
        for (const v of m.values()) stored += v.text.length;
        for (const k of m.keys()) { if (stored <= INLINE_TAB_LIMIT || m.size <= 1) break; stored -= m.get(k).text.length; m.delete(k); }
        // A newly decoded child can make a cached HD/Full HD master usable immediately.
        for (const cacheKey of streamInfoCache.keys()) if (cacheKey.startsWith(`${tabId}|`)) streamInfoCache.delete(cacheKey);
        dashCache.delete(`${tabId}|${key}`);
        if (m.size > 60) m.delete(m.keys().next().value);
        persistInline(tabId);
        const isHls = msg.kind === 'hls';
        addItem(tabId, {
          url: key, key, kind: 'stream', inline: !/^https?:/i.test(key),
          referer: sender.url || sender.tab?.url || '',
          contentType: isHls ? 'application/vnd.apple.mpegurl' : 'application/dash+xml',
          size: null, name: /^https?:/i.test(key) ? nameFromUrl(key) : (isHls ? VCI18n.t('playlist_hls_dung_trong_1u0a') : VCI18n.t('manifest_dash_dung_trong_1kda')),
          ts: Date.now(),
        });
        return { ok: true };
      }
      case 'vc:manifestText': {
        // trình tải hỏi nội dung playlist chỉ tồn tại trong trang
        const inl = getInline(tabOf(msg.tabId), msg.url);
        return inl ? { text: inl.text, base: inl.base } : { text: null };
      }
      case 'vc:topTitle': {
        // content script trong iframe hỏi tên video của khung chính (tên trang / bài đang học) của chính tab nó
        if (!Number.isInteger(ownTab)) return { title: '' };
        const r = await Promise.race([chrome.tabs.sendMessage(ownTab, { type: 'vc:videoTitle' }, { frameId: 0 }), new Promise((res) => setTimeout(() => res(null), 3500))]).catch(() => null);
        return { title: (r && r.title) || (sender.tab && sender.tab.title) || '', trace: r && r.trace };
      }
      case 'vc:openManager':
        await openManager();
        return { ok: true };
      case 'vc:referer':
        extensionOnly();
        await setReferer(msg.urls || [], msg.referer);
        return { ok: true };
      case 'vc:saveRecording': {
        // Bản ghi từ content script (kể cả trong iframe): đặt tên theo tiêu đề tab
        const title = (typeof msg.title === 'string' && msg.title.trim() ? msg.title.slice(0, 300) : '') || (sender.tab && sender.tab.title) || msg.fallbackTitle;
        // Chỉ lưu blob do chính MediaRecorder trong trang tạo; hậu tố là ngày giờ + đuôi webm/mp4 (SEC-004)
        if (typeof msg.url !== 'string' || !msg.url.startsWith('blob:') || !/^[\w-]{1,80}\.(webm|mp4|mkv)$/i.test(String(msg.suffix || ''))) {
          throw new Error(VCI18n.t('ban_ghi_khong_hop_172i'));
        }
        const cfg = await chrome.storage.local.get({ subfolder: 'Video Catcher', askSaveAs: false });
        const filename = `${cfg.subfolder ? `${safeName(cfg.subfolder)}/` : ''}${safeName(title)}_${msg.suffix}`;
        const id = await startDownload(msg.url, filename, cfg.askSaveAs);
        return { ok: true, id, filename };
      }
      default:
        return undefined;
    }
  })().then(sendResponse, (e) => sendResponse({ error: (e && e.message) || String(e) }));
  return true;
});
