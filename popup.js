// Video Catcher – popup

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
const btn = (label, cls, onClick, disabled) => el('button', { class: cls, onclick: onClick, disabled: !!disabled }, label);

const YOUTUBE = /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtube-nocookie\.com|youtu\.be)\//i;
const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;
const MEDIA_EXTS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'flv', 'avi', '3gp', 'mp3', 'm4a', 'ogg', 'wav', 'flac'];
const EXT_BY_CT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov',
  'video/ogg': 'ogv', 'video/x-flv': 'flv', 'video/3gpp': '3gp', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac',
};

let tab = null;
let restricted = false;

// ---------- tiện ích ----------
function fmtTime(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '--:--';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function fmtSize(b) {
  if (!b) return VCI18n.t('khong_ro_dung_luong_yqh6');
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}
function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return VCI18n.t('s_truoc_awzj', [s]);
  if (s < 3600) return VCI18n.t('phut_truoc_19zm', [Math.round(s / 60)]);
  return VCI18n.t('gio_truoc_10kr', [Math.round(s / 3600)]);
}
function sanitize(name) {
  return (name || 'video')
    .replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120) || 'video';
}
function extFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}
function buildFilename(url, contentType) {
  let ext = extFromUrl(url);
  if (!MEDIA_EXTS.includes(ext)) ext = EXT_BY_CT[(contentType || '').split(';')[0].trim()] || 'mp4';
  return `${sanitize(tab && tab.title)}.${ext}`;
}
// ---------- Thông báo (snackbar) ----------
let toastTimer = 0;
function setStatus(text, isError = false, action = null) {
  const t = $('#status');
  clearTimeout(toastTimer);
  $('#statusText').textContent = text;
  const act = $('#statusAction');
  act.hidden = !action;
  act.onclick = action ? action.run : null;
  if (action) act.textContent = action.label;
  t.classList.toggle('error', isError);
  t.hidden = !text;
  if (text) toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 7000 : 4000);
}
async function copy(text, okText) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(okText);
  } catch (e) {
    setStatus(VCI18n.t('khong_sao_chep_duoc_1iii', [e.message]), true);
  }
}

const bg = (msg) => chrome.runtime.sendMessage(msg);
const openManager = () => { bg({ type: 'vc:openManager' }).catch(() => {}); window.close(); };
const SEE = { label: 'Xem', run: openManager };
document.getElementById('openManager')?.addEventListener('click', openManager);
const toFrame = (frameId, msg) => chrome.tabs.sendMessage(tab.id, msg, { frameId });

// ---------- hành động ----------
async function download(url, filename) {
  const r = await bg({ type: 'vc:download', url, filename }).catch((e) => ({ error: e.message }));
  if (r && r.error) setStatus(VCI18n.t('loi_tai_11ta', [r.error]), true);
  else setStatus(VCI18n.t('dang_tai_vao_downloads_a00o'));
}

async function act(frameId, msg, okText) {
  try {
    const r = await toFrame(frameId, msg);
    if (r && r.error) throw new Error(r.error);
    setStatus(okText);
  } catch (e) {
    setStatus(e.message, true);
  }
  setTimeout(refresh, 300);
}

// ---------- quét các khung (frame) trong tab ----------
async function scanFrames(allowInject = true) {
  let frames = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || []; } catch { /* bỏ qua */ }
  if (!frames.length) frames = [{ frameId: 0 }];
  const results = await Promise.all(frames.map((f) =>
    toFrame(f.frameId, { type: 'vc:list' }).then((r) => (r && !r.error ? { frameId: f.frameId, ...r } : null)).catch(() => null)));
  const ok = results.filter(Boolean);
  // Khung chưa có content script (tab mở trước khi cài/reload extension, iframe nạp muộn…) -> tiêm rồi quét lại.
  // Bỏ qua about:blank/srcdoc: video trong đó do khung cha quét hộ.
  const missing = frames.filter((f) => !ok.some((r) => r.frameId === f.frameId) && !/^about:/.test(f.url || '')).map((f) => f.frameId);
  if (allowInject && missing.length) {
    await Promise.all(missing.map((frameId) =>
      chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ['lib/youtube.js', 'lib/position.js', 'lib/frames.js', 'content.js'] })
        .catch(() => { /* khung không cho tiêm */ })));
    return scanFrames(false);
  }
  return ok;
}

// ---------- biểu tượng ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(d, { fill = false, width = 2 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const part of [].concat(d)) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', part);
    if (fill) p.setAttribute('fill', 'currentColor');
    else { p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', String(width)); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); }
    svg.append(p);
  }
  return svg;
}
const I = {
  down: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14',
  ok: 'M5 12.5l4.5 4.5L19 7.5',
  more: 'M6 9l6 6 6-6',
  dots: ['M12 5.5h.01', 'M12 12h.01', 'M12 18.5h.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v5', 'M12 8h.01'],
};
const cleanTitle = (t) => (t || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
const sizeText = (b) => (b ? fmtSize(b) : '');

// ---------- Các khối giao diện ----------
// Một hàng chất lượng: "1080p  H.264 · Đề xuất        948 MB  ⬇"
function qrow({ name, sub, size, title, disabled, rec, onClick }) {
  const go = el('span', { class: 'qgo' }, icon(disabled ? I.info : I.down));
  // Hàng đề xuất: nhãn "Đề xuất" thay cho codec (codec chuyển vào tooltip) để không chèn chữ
  const subEl = el('span', { class: 'qsub' }, rec ? el('span', { class: 'badge' }, VCI18n.t('de_xuat_ycyt')) : el('span', { class: 'qtext' }, sub || ''));
  const tip = [title, rec && sub ? sub : ''].filter(Boolean).join(' · ');
  const row = el('button', { class: `qrow${rec ? ' rec' : ''}`, title: tip, disabled: !!disabled }, el('b', {}, name), subEl, el('span', { class: 'qsize' }, size || ''), go);
  row.addEventListener('click', async () => {
    const ok = await onClick();
    if (ok === false) return;
    row.classList.add('done');
    go.replaceChildren(icon(I.ok, { width: 2.4 }));
    setTimeout(() => { row.classList.remove('done'); go.replaceChildren(icon(I.down)); }, 2500);
  });
  return row;
}
// Danh sách chất lượng: hiện các mức chính, gập các mức thấp vào "N mức thấp hơn"
function qcard({ head = VCI18n.t('chon_chat_luong_mp4_1xaw'), rows, extraRows = [], extraLabel = '', note, warn, previews }) {
  const card = el('section', { class: 'qcard' },
    el('div', { class: 'qcard-head' }, el('h2', {}, head)));
  if (note) card.append(el('div', { class: `qnote${warn ? ' warn' : ''}` }, note));
  card.append(...rows);
  if (extraRows.length) {
    const box = el('div', { hidden: true }, extraRows);
    const tg = el('button', { class: 'qmore' }, icon(I.more), extraLabel);
    tg.addEventListener('click', () => { box.hidden = !box.hidden; tg.classList.toggle('open', !box.hidden); });
    card.append(box, tg);
  }
  if (previews) card.append(previews);
  return card;
}
// Tiêu đề video: ảnh thu nhỏ (hoặc nhãn HLS/DASH) + tên + dòng phụ + menu ⋯
function vidHead({ thumb, label, duration, title, sub, menu = [] }) {
  const box = el('div', { class: `vid-thumb${thumb ? '' : ' label'}` }, label || '');
  if (thumb) {
    const img = el('img', { alt: '', src: thumb });
    img.addEventListener('error', () => img.remove());
    box.prepend(img);
  }
  if (duration) box.append(el('span', { class: 'dur' }, fmtTime(duration)));
  const more = menu.length ? el('details', { class: 'vid-more' }, el('summary', { title: VCI18n.t('them_imm2'), 'aria-label': VCI18n.t('them_imm2') }, icon(I.dots, { width: 3 })),
    el('div', { class: 'menu' }, menu.map(([text, fn]) => btn(text, '', (e) => { e.target.closest('details').open = false; fn(); })))) : null;
  return el('section', { class: 'vid' }, thumb || label ? box : null,
    el('div', { class: 'vid-text' }, el('strong', { title }, title), sub ? el('span', {}, sub) : null), more);
}
const ytThumb = (url) => { const id = (/[?&]v=([\w-]{11})/.exec(url || '') || [])[1]; return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''; };
const pageHost = () => { try { const u = new URL(tab.url); return /^https?:$/.test(u.protocol) ? u.hostname : ''; } catch { return ''; } };

// ---------- Ghi lại ----------
function videoRow(v, index) {
  const rec = v.recording && v.recording.id === v.id ? v.recording : null;
  const busy = !!v.recording;
  const meta = [v.width ? `${v.width}×${v.height}` : '', v.duration ? fmtTime(v.duration) : VCI18n.t('truc_tiep_3zjz')].filter(Boolean).join(' · ');
  const buttons = [];
  let title = `Video ${index + 1}${v.frameId ? VCI18n.t('khung_nhung_48mi') : ''}`;
  if (rec) {
    title = el('span', {}, rec.running ? VCI18n.t('dang_ghi_1ym4') : VCI18n.t('tam_dung_1qev'),
      el('span', { 'data-base': rec.elapsedMs, 'data-at': Date.now(), 'data-running': rec.running ? '1' : '0' }, fmtTime(rec.elapsedMs / 1000)),
      rec.part > 1 ? VCI18n.t('phan_qxnm', [rec.part]) : '');
    buttons.push(btn(VCI18n.t('dung_luu_15ll'), 'primary', () => act(v.frameId, { type: 'vc:stop' }, VCI18n.t('dang_luu_vao_downloads_qzga'))));
  } else {
    if (v.isDirect) buttons.push(btn(VCI18n.t('tai_5v37'), 'primary', () => download(v.src, buildFilename(v.src, ''))));
    buttons.push(el('button', { class: v.isDirect || index > 0 ? '' : 'tonal', title: VCI18n.t('ghi_tu_luc_nay_1fci'), disabled: busy,
      onclick: () => act(v.frameId, { type: 'vc:record', id: v.id, fromStart: false }, VCI18n.t('dang_ghi_1v0o')) }, VCI18n.t('ghi_record')));
    if (v.duration) buttons.push(el('button', { title: VCI18n.t('tua_ve_dau_va_8lte'), disabled: busy,
      onclick: () => act(v.frameId, { type: 'vc:record', id: v.id, fromStart: true }, VCI18n.t('dang_ghi_tu_dau_xzct')) }, VCI18n.t('tu_dau_1vct')));
  }
  return el('div', { class: `vrow${rec ? ' recording' : ''}` },
    el('div', { class: 'vinfo' }, el('div', { class: 'vtitle' }, title), el('div', { class: 'meta' }, meta)),
    el('div', { class: 'vbtns' }, buttons));
}
let recordTouched = false;
function renderVideos(frames) {
  const box = $('#videos');
  box.replaceChildren();
  const items = frames.flatMap((f) => (f.videos || []).map((v) => ({ ...v, frameId: f.frameId, recording: f.recording })));
  $('#recordBox').hidden = restricted;
  const recording = items.some((v) => v.recording && v.recording.id === v.id);
  $('#recSub').textContent = recording ? VCI18n.t('dang_ghi_1v0o') : items.length ? VCI18n.t('khi_khong_tai_duoc_wh13', [items.length]) : VCI18n.t('khi_khong_tai_duoc_1adm');
  if (!items.length) {
    box.append(el('p', { class: 'hint' }, VCI18n.t('chua_thay_video_phat_pxmx')));
    return false;
  }
  items.sort((a, b) => (b.playing - a.playing) || (b.width * b.height - a.width * a.height));
  items.forEach((v, i) => box.append(videoRow(v, i)));
  return recording;
}

// ---------- Nguồn tải ----------
async function downloadViaManager(f, duration) {
  const ext = buildFilename(f.url, f.contentType).split('.').pop();
  const r = await bg({ type: 'vc:startHls', kind: 'file', url: f.url, ext, size: f.size || 0, estSize: f.size || null, duration: duration || null, quality: f.quality || ext.toUpperCase(), title: await videoTitleOfTab(), referer: f.referer || tab.url, tabId: tab.id })
    .catch((e) => ({ error: e.message }));
  if (r && r.error) { setStatus(VCI18n.t('loi_1bgh', [r.error]), true); return false; }
  setStatus(VCI18n.t('da_them_vao_trinh_14vi'), false, SEE);
  return true;
}
function fileRow(f, durationOf) {
  const ext = buildFilename(f.url, f.contentType).split('.').pop();
  const dur = durationOf ? durationOf(f) : 0;
  let name = f.name;
  if (!name) { try { name = decodeURIComponent(new URL(f.url).pathname.split('/').pop()) || f.url; } catch { name = f.url; } }
  return qrow({ name: ext.toUpperCase().slice(0, 5), sub: [f.quality, dur ? fmtTime(dur) : '', f.isVideoSrc ? VCI18n.t('dang_phat_1swb') : name].filter(Boolean).join(' · '),
    size: f.size ? fmtSize(f.size) : '', title: f.url, onClick: () => downloadViaManager(f, dur) });
}
async function startJob(s, v) {
  const common = { type: 'vc:startHls', quality: v.label, title: await videoTitleOfTab(), referer: s.referer || tab.url, tabId: tab.id, estSize: v.estSize || null, duration: s.duration || null };
  const msg = s.kind === 'dash'
    ? { ...common, kind: 'dash', url: s.url, videoId: v.videoId, audioId: v.audioId, height: v.height, bandwidth: v.bandwidth }
    : { ...common, kind: 'hls', url: v.url, audioUrl: v.audioUrl };
  const r = await bg(msg).catch((e) => ({ error: e.message }));
  if (r && r.error) { setStatus(VCI18n.t('loi_1bgh', [r.error]), true); return false; }
  setStatus(VCI18n.t('da_them_vao_trinh_phqq', [String(v.label).split(' · ')[0]]), false, SEE);
  return true;
}
// Mức đề xuất: 1080p nếu có, không thì mức cao nhất ≤ 1080p
const pickRec = (heights) => heights.find((h) => h === 1080) || heights.find((h) => h && h <= 1080) || 0;
function streamBlock(s) {
  const isDash = s.kind === 'dash';
  const blocked = s.error ? VCI18n.t('khong_doc_duoc_luong_1q8v', [s.error]) : s.drm ? VCI18n.t('video_co_drm_bao_14g0') : (isDash && s.live) ? VCI18n.t('livestream_dung_ghi_lai_1eg5') : '';
  const variants = (!blocked && s.variants) || [];
  const rec = pickRec(variants.filter((v) => !v.needsPlayback).map((v) => v.height || 0));
  const rows = variants.map((v) => {
    const [head, ...rest] = String(v.label).split(' · ');
    return qrow({ name: head, sub: v.needsPlayback ? VCI18n.t('chon_muc_nay_tren_g330') : rest.join(' · '),
      size: s.live ? '' : sizeText(v.estSize), disabled: !!v.needsPlayback, rec: !!rec && v.height === rec && !v.needsPlayback,
      title: v.needsPlayback ? VCI18n.t('chon_muc_nay_tren_1itu') : '', onClick: () => startJob(s, v) });
  });
  const base = sanitize(tab && tab.title);
  return el('div', { class: 'stack' },
    vidHead({ label: isDash ? 'DASH' : 'HLS', title: cleanTitle(tab && tab.title) || s.name || s.url,
      sub: [s.live ? VCI18n.t('truc_tiep_nxzc') : s.duration ? fmtTime(s.duration) : '', pageHost().replace(/^www\./, '')].filter(Boolean).join(' · '),
      menu: [[VCI18n.t('sao_chep_link_1v2s'), () => copy(s.url, VCI18n.t('da_sao_chep_1dgp'))], [VCI18n.t('sao_chep_lenh_ffmpeg_1uw9'), () => copy(`ffmpeg -i "${s.url}" -c copy "${base}.mp4"`, VCI18n.t('da_sao_chep_1dgp'))]] }),
    qcard({ head: s.live ? VCI18n.t('truc_tiep_tai_toi_1wi2') : VCI18n.t('chon_chat_luong_mp4_1xaw'), rows, note: blocked, warn: !!blocked }));
}
// YouTube: vẽ thẳng từ danh sách đã có (đọc từ lúc mở popup); chỉ hiện khung chờ khi chưa kịp
function youtubeBlock(url, ready, pending) {
  const title = cleanTitle(tab.title) || 'Video YouTube';
  const thumb = ytThumb(url);
  const build = (info) => {
    if (!info || info.error) return el('div', { class: 'stack' }, vidHead({ thumb, title, sub: 'YouTube' }), qcard({ rows: [], note: (info && info.error) || VCI18n.t('khong_doc_duoc_video_zkl8'), warn: true }));
    const options = info.options && info.options.length ? info.options : info.heights.map((height) => ({ height }));
    const rec = pickRec(options.map((o) => o.height));
    const row = ({ height, size, codec, fps }) => qrow({
      name: `${height}p`, sub: [codec, fps > 30 ? `${fps}fps` : '', height >= 2160 ? '4K' : height >= 1440 ? '2K' : ''].filter(Boolean).join(' · '),
      size: sizeText(size), rec: height === rec,
      onClick: async () => {
        try {
          const result = await bg({ type: 'vc:youtube', url, height, title: cleanTitle(tab.title) });
          if (result && result.error) throw new Error(result.error);
          setStatus(VCI18n.t('da_them_p_vao_o48l', [height]), false, SEE);
          return true;
        } catch (error) { setStatus(error.message, true); return false; }
      },
    });
    const main = options.filter((o) => o.height >= 480);
    const low = options.filter((o) => o.height < 480);
    const shown = main.length ? main : options;
    const hidden = main.length ? low : [];
    return el('div', { class: 'stack' },
      vidHead({ thumb, title: info.title || title, duration: info.duration, sub: 'YouTube' }),
      qcard({ rows: shown.map(row), extraRows: hidden.map(row),
        extraLabel: hidden.length ? VCI18n.t('muc_thap_hon_p_3fl8', [hidden.length, hidden[0].height, hidden[hidden.length - 1].height]) : '',
        note: info.engine === 'browser' ? VCI18n.t('toi_da_1080p_cai_c9xx') : '' }));
  };
  if (ready) return build(ready);
  const placeholder = [0, 1, 2, 3].map(() => el('button', { class: 'qrow loading', disabled: true }, el('b'), el('span', { class: 'qsub' }), el('span', { class: 'qsize' })));
  const block = el('div', { class: 'stack' }, vidHead({ thumb, title, sub: 'YouTube' }), qcard({ rows: placeholder }));
  pending.then((info) => info, (error) => ({ error: error.message })).then((info) => { if (block.isConnected) block.replaceWith(build(info)); });
  return block;
}

const PREVIEW_RE = /preview|thumb|heatmap|sprite|teaser|trailer|poster|storyboard|hover|sample/i;
function renderMedia(src, maxDuration = 0, durByUrl = new Map(), yt = {}) {
  const durationOf = (f) => durByUrl.get(f.url) || 0;
  const box = $('#media');
  box.replaceChildren();
  if (restricted) {
    box.append(el('div', { class: 'empty-state' }, el('b', {}, VCI18n.t('khong_dung_duoc_o_1jsu'))));
    $('#clear').hidden = true;
    return 0;
  }
  const isPreview = (f) => !f.isVideoSrc && (PREVIEW_RE.test(`${f.name} ${f.url}`) || (maxDuration > 180 && f.size && f.size < 8 * 1048576));
  const files = (src.files || []).filter((f) => !isPreview(f));
  const previews = (src.files || []).filter(isPreview);
  const streams = src.streams || [];
  const ytUrl = tab && YOUTUBE.test(tab.url || '') ? VCYouTube.normalize(tab.url) : '';
  $('#clear').hidden = !(files.length + streams.length + previews.length) || !!ytUrl;
  if (ytUrl) { box.append(youtubeBlock(ytUrl, yt.ready, yt.pending)); return 1; }
  const n = files.length + streams.length;
  if (!n) box.append(el('div', { class: 'empty-state' }, el('b', {}, VCI18n.t('chua_bat_duoc_video_m7sr')), VCI18n.t('phat_vai_giay_roi_vsm2')));
  streams.forEach((s) => box.append(streamBlock(s)));
  if (files.length || previews.length) {
    let prevBox = null;
    if (previews.length) {
      const list = el('div', { hidden: true }, previews.map((f) => fileRow(f, durationOf)));
      const tg = el('button', { class: 'qmore muted' }, icon(I.more), VCI18n.t('clip_ngan_xem_truoc_vwoi', [previews.length]));
      tg.addEventListener('click', () => { list.hidden = !list.hidden; tg.classList.toggle('open', !list.hidden); });
      prevBox = el('div', {}, list, tg);
    }
    box.append(qcard({ head: 'File media', rows: files.map((f) => fileRow(f, durationOf)), previews: prevBox }));
  }
  return n;
}

async function refresh() {
  const spin = $('#refresh');
  spin.classList.add('spin');
  try {
    // YouTube: đọc danh sách chất lượng song song với việc quét trang (thường đã có sẵn trong background)
    const ytUrl = !restricted && YOUTUBE.test(tab.url || '') ? VCYouTube.normalize(tab.url) : '';
    const ytPending = ytUrl ? bg({ type: 'vc:youtubeInfo', url: ytUrl }) : null;
    let ytReady = null;
    if (ytPending) ytPending.then((info) => { ytReady = info; }, () => {});
    const frames = restricted ? [] : await scanFrames();
    const vids = frames.flatMap((f) => f.videos || []);
    const media = restricted || ytUrl ? {} : await bg({ type: 'vc:sources', tabId: tab.id, referer: tab.url,
      declaredSources: vids.flatMap((video) => video.sources || []) }).catch(() => ({ files: [], streams: [] }));
    // Chờ thêm chút để vẽ một lần, không phải khung chờ rồi mới đổi (popup không bị nhảy)
    if (ytPending && !ytReady) await Promise.race([ytPending.catch(() => null), new Promise((r) => setTimeout(r, 1200))]);
    const recording = renderVideos(frames);
    const maxDuration = Math.max(0, ...vids.map((v) => v.duration || 0));
    const durByUrl = new Map(vids.filter((v) => v.isDirect && v.duration).map((v) => [v.src, v.duration]));
    const found = renderMedia(media || {}, maxDuration, durByUrl, { ready: ytReady, pending: ytPending });
    // Mở sẵn phần Ghi khi đang ghi, hoặc khi không có gì để tải
    if (!recordTouched) $('#recordBox').open = recording || (!found && vids.length > 0);
  } finally { spin.classList.remove('spin'); }
}

// ---------- Cài đặt ----------
async function loadSettings() {
  const cfg = await chrome.storage.local.get({ overlay: true, overlayOff: [], destLabel: 'Downloads › Video Catcher', simultaneousVideos: 5, askSaveAs: false, prefixCourse: false, postEnabled: true, postKeep: false });
  return { all: cfg.overlay !== false, off: [...new Set(cfg.overlayOff || [])], dest: String(cfg.destLabel).replace(/^📁\s*/, ''), n: cfg.simultaneousVideos, ask: !!cfg.askSaveAs, prefixCourse: !!cfg.prefixCourse, postEnabled: cfg.postEnabled !== false, postKeep: !!cfg.postKeep };
}
async function setSiteHidden(host, hidden) {
  const { off } = await loadSettings();
  const set = new Set(off);
  if (hidden) set.add(host); else set.delete(host);
  await chrome.storage.local.set({ overlayOff: [...set].sort() });
}
async function initSettings() {
  const cfg = await loadSettings();
  const host = pageHost();
  const cb = $('#overlayToggle');
  const sw = $('#siteSwitch');
  $('#siteLabel').textContent = VCI18n.t('nut_tai_o_trang_1fb0');
  cb.checked = cfg.all && !(host && cfg.off.includes(host));
  cb.disabled = !host || !cfg.all;
  sw.classList.toggle('off-all', !cfg.all);
  sw.title = !cfg.all ? VCI18n.t('dang_tat_o_moi_14kf') : host ? VCI18n.t('hien_nut_tai_tren_pw7j', [host]) : '';
  cb.onchange = async () => { await setSiteHidden(host, !cb.checked); renderSettings(); };
  $('#destLabel').textContent = String(cfg.dest).split(/[›\\/]/).map(x => x.trim()).filter(Boolean).pop() || cfg.dest;
  $('#dest').title = VCI18n.t('luu_vao_bam_de_jx3c', [cfg.dest]);
  $('#dest').onclick = openManager;
  renderSettings(cfg);
}
async function renderSettings(cfg) {
  cfg = cfg || await loadSettings();
  const all = $('#overlayAll');
  all.checked = cfg.all;
  all.onchange = async () => { await chrome.storage.local.set({ overlay: all.checked }); initSettings(); };
  const auto = $('#autoSave');
  auto.checked = !cfg.ask;
  auto.onchange = async () => { await chrome.storage.local.set({ askSaveAs: !auto.checked }); initSettings(); };
  const postCb = $('#postEnabled');
  postCb.checked = cfg.postEnabled;
  postCb.onchange = async () => { await chrome.storage.local.set({ postEnabled: postCb.checked }); renderSettings(); };
  for (const b of document.querySelectorAll('#langPick button')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === VCI18n.lang));
    b.onclick = async () => { await chrome.storage.local.set({ lang: b.dataset.lang }); };
  }
  const keepCb = $('#postKeep');
  keepCb.checked = cfg.postKeep;
  keepCb.onchange = async () => { await chrome.storage.local.set({ postKeep: keepCb.checked }); renderSettings(); };
  const prefix = $('#prefixCourse');
  prefix.checked = cfg.prefixCourse;
  prefix.onchange = async () => { await chrome.storage.local.set({ prefixCourse: prefix.checked }); videoTitleCache = null; initSettings(); };
  $('#destValue').textContent = cfg.ask ? VCI18n.t('hoi_moi_lan_luu_afxt', [cfg.dest]) : cfg.dest;
  $('#destSettings').onclick = openManager;
  for (const b of document.querySelectorAll('#concurrency button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.n) === cfg.n));
    b.onclick = async () => { await chrome.storage.local.set({ simultaneousVideos: Number(b.dataset.n) }); renderSettings(); };
  }
  $('#offCount').textContent = cfg.off.length ? `(${cfg.off.length})` : '';
  const list = $('#offList');
  list.replaceChildren();
  if (!cfg.off.length) list.append(el('div', { class: 'set-empty' }, VCI18n.t('chua_co_1rt5')));
  for (const host of cfg.off) {
    list.append(el('div', { class: 'site' }, el('span', { class: 'fav', 'aria-hidden': 'true' }, host.replace(/^www\./, '').charAt(0).toUpperCase()),
      el('span', { class: 'name', title: host }, host.replace(/^www\./, '')),
      btn(VCI18n.t('hien_lai_1w8w'), 'text', async () => { await setSiteHidden(host, false); initSettings(); })));
  }
  const v = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '';
  $('#version').textContent = v ? `Video Catcher ${v}` : '';
}
let helperChecked = false;
function toggleSettings(show) {
  const open = show ?? $('#settingsView').hidden;
  $('#settingsView').hidden = !open;
  $('#mainView').hidden = open;
  $('#footer').hidden = open;
  $('#topBar').hidden = open;
  if (open && !helperChecked) {
    helperChecked = true;
    bg({ type: 'vc:helperStatus' }).then((r) => {
      $('#helperStatus').textContent = r && r.ok ? VCI18n.t('dang_chay_tai_duoc_1l07') : VCI18n.t('chua_cai_youtube_tai_fod4');
    }).catch(() => { $('#helperStatus').textContent = VCI18n.t('khong_kiem_tra_duoc_1ne4'); });
  }
}

// Cập nhật đồng hồ ghi hình mỗi giây
setInterval(() => {
  document.querySelectorAll('[data-base]').forEach((n) => {
    const running = n.dataset.running === '1';
    const ms = Number(n.dataset.base) + (running ? Date.now() - Number(n.dataset.at) : 0);
    n.textContent = fmtTime(ms / 1000);
  });
}, 1000);

// Tên video để đặt tên file: hỏi content script của khung chính (vd Udemy: "Tên khoá - 12. Tên bài"),
// vì tiêu đề tab có thể giống nhau cho mọi bài. Không hỏi được (trang hạn chế) thì dùng tiêu đề tab.
let videoTitleCache = null;
function videoTitleOfTab() {
  if (!videoTitleCache) {
    const ask = chrome.tabs.sendMessage(tab.id, { type: 'vc:videoTitle' }, { frameId: 0 }).then((r) => (r && r.title) || '').catch(() => '');
    videoTitleCache = Promise.race([ask, new Promise((r) => setTimeout(() => r(''), 1500))]).then((t) => t || tab.title || 'video');
  }
  return videoTitleCache;
}

(async function init() {
  await VCI18n.init();
  VCI18n.onChange(() => { renderSettings(); refresh(); });   // đổi ngôn ngữ: vẽ lại popup
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  restricted = RESTRICTED.test(tab.url || '');
  $('#refresh').addEventListener('click', () => { toggleSettings(false); refresh(); });
  $('#openSettings').addEventListener('click', () => toggleSettings(true));
  $('#closeSettings').addEventListener('click', () => toggleSettings(false));
  $('#recordBox > summary').addEventListener('click', () => { recordTouched = true; });
  $('#clear').addEventListener('click', async () => {
    await bg({ type: 'vc:clearMedia', tabId: tab.id }).catch(() => {});
    refresh();
  });
  initSettings();
  const ready = () => document.body.classList.add('ready');
  setTimeout(ready, 1500);
  refresh().finally(ready);
})();
