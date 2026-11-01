// Video Catcher – content script
// Liệt kê thẻ <video> trên trang và ghi lại video đang phát bằng captureStream + MediaRecorder.
(() => {
  VCI18n.init();   // ngôn ngữ giao diện (mặc định English); menu dựng lại mỗi lần mở nên tự theo ngôn ngữ mới
  VCI18n.onChange(() => { try { if (dl.open) closeMenu(); } catch { /* chưa có menu */ } });
  // Khi extension được reload/cập nhật, script cũ trong tab bị "mồ côi" nhưng biến toàn cục vẫn còn
  // (cùng isolated world). Chỉ bỏ qua khi bản cũ còn sống, nếu không thì cài lại.
  const prev = window.__videoCatcher;
  if (prev && typeof prev.alive === 'function' && prev.alive()) return;
  window.__videoCatcher = {
    alive: () => {
      try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
    },
  };
  const alive = window.__videoCatcher.alive;
  // Nút/menu do bản cũ (đã mồ côi sau khi tiện ích tải lại) để lại: bấm không còn tác dụng -> gỡ đi
  try { document.querySelectorAll('[data-video-catcher], [data-video-catcher-yt], [data-video-catcher-ytp]').forEach((n) => n.remove()); } catch { /* chưa có DOM */ }

  // Ưu tiên MP4/H.264 (Chrome 126+, không ghim level để Chrome tự chọn theo độ phân giải), sau đó WebM
  const MIME_CANDIDATES = [
    ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
    ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
    ['video/mp4', 'mp4'],
  ];
  const ENDED_GRACE_MS = 2000; // sau "ended" chờ xem có nguồn mới (vd: hết quảng cáo YouTube) không
  const RESUME_WAIT_MS = 90000; // chờ tối đa khi nguồn bị đổi giữa chừng
  const MAX_PARTS = 20;

  const ids = new WeakMap();
  let nextId = 1;
  let session = null;

  const idOf = (v) => {
    if (!ids.has(v)) ids.set(v, nextId++);
    return ids.get(v);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const once = (target, ev, timeout) =>
    new Promise((res) => {
      const t = setTimeout(res, timeout);
      target.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    });
  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    while (!fn() && Date.now() - t0 < timeout) await sleep(100);
    return fn();
  }
  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };
  const safeName = (s) =>
    (s || 'video').replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video';
  // ---------- Tên video để đặt tên file ----------
  // Trang khoá học (Udemy…) để tiêu đề tab là tên khoá học cho mọi bài: lấy thêm tên bài đang xem, nếu không
  // mọi file tải về trùng một tên. Thứ tự: tên bài trong danh sách bài (DOM) -> API của Udemy theo mã bài trên URL
  // -> "Tên khoá - bài <mã>" (luôn khác nhau giữa các bài).
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const tabTitle = () => clean(document.title).replace(/^\(\d+\)\s*/, '');
  const IS_UDEMY = /(^|\.)udemy\.com$/i.test(location.hostname);
  const udemyLectureId = () => (/\/lecture\/(\d+)/.exec(location.pathname) || [])[1] || '';
  const udemySlug = () => (/\/course\/([^/?#]+)/.exec(location.pathname) || [])[1] || '';
  // Cài đặt popup "Tên khoá học ở đầu tên file": mặc định tắt -> tên file chỉ là tên bài ("12. Tên bài")
  let prefixCourse = false;
  try {
    chrome.storage.local.get({ prefixCourse: false }).then((r) => { prefixCourse = !!r.prefixCourse; }).catch(() => {});
    chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.prefixCourse) prefixCourse = !!c.prefixCourse.newValue; });
  } catch { /* bỏ qua */ }
  const IS_COURSERA = /(^|\.)coursera\.org$/i.test(location.hostname);
  const siteCourse = () => (IS_UDEMY ? udemyCourse() : IS_COURSERA ? courseraCourse() : '');
  const withCourse = (lecture) => { const c = prefixCourse && siteCourse(); return c ? `${c} - ${lecture}` : lecture; };
  // ---------- Coursera: tên file = đúng tên bài hiển thị trên trang (bỏ "| Coursera") ----------
  // Số module.thứ tự video (vd 1.06) chỉ ghi vào Chẩn đoán, không thêm vào tên file.
  const courseraSlug = () => (/\/learn\/([^/?#]+)/.exec(location.pathname) || [])[1] || '';
  const courseraItemId = () => (/\/learn\/[^/]+\/(?:lecture|item)\/([^/?#]+)/.exec(location.pathname) || [])[1] || '';
  function courseraCourse() {
    const slug = courseraSlug();
    const a = slug && [...document.querySelectorAll('a[href]')].find((x) => new RegExp(`/learn/${slug.replace(/[^\w-]/g, '')}(/home(/[^/]*)?)?/?$`).test(x.getAttribute('href').split('?')[0]) && clean(x.textContent));
    return clean(a && a.textContent);
  }
  function courseraLecture(trace) {
    const box = document.querySelector('[data-e2e="video-item-title-and-attribution"], [data-testid="video-item-title-and-attribution"]');
    const title = clean(box && (box.querySelector('h1, h2') || box).textContent) || tabTitle().replace(/\s*\|\s*Coursera\s*$/i, '');
    const id = courseraItemId();
    const nav = document.querySelector('[data-e2e="left-nav"], [data-testid="left-nav"]') || document;
    const videos = [...nav.querySelectorAll('a[href*="/lecture/"]')];
    const cur = id && videos.find((a) => a.getAttribute('href').split('?')[0].includes(`/${id}/`) || a.getAttribute('href').split('?')[0].endsWith(`/${id}`));
    let num = '';
    if (cur) {
      const heads = [...nav.querySelectorAll('[data-e2e="module-number-heading"], [data-testid="module-number-heading"]')];
      const before = heads.filter((h) => h.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING);
      const head = before[before.length - 1];
      const next = head && heads[heads.indexOf(head) + 1];
      const inModule = videos.filter((a) => (!head || (head.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) && (!next || (a.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)));
      const mod = head && (/(\d+)/.exec(head.textContent) || [])[1];
      const idx = inModule.indexOf(cur) + 1;
      if (idx) num = `${mod ? `${mod}.` : ''}${String(idx).padStart(2, '0')}`;
    }
    if (trace) { trace.coursera = { id, module: num.split('.')[0] || '', number: num }; trace.source = VCI18n.t('ten_bai_coursera_yaqc'); }
    return title;
  }
  function udemyCourse() {
    const node = document.querySelector('[data-purpose="course-header-title"]');
    return clean(node && node.textContent) || tabTitle().replace(/\s*\|\s*Udemy.*$/i, '');
  }
  // Bài đang học trong danh sách bài: Udemy đổi class/attribute theo thời gian -> thử nhiều kiểu đánh dấu
  const UDEMY_CURRENT = [
    '[class*="curriculum-item-link--is-current"] [data-purpose="item-title"]',
    '[aria-current="true"] [data-purpose="item-title"]',
    '[aria-current="page"] [data-purpose="item-title"]',
    '[class*="is-current"] [data-purpose="item-title"]',
    '[class*="is-current"] [data-purpose*="title"]',
    '[data-purpose="curriculum-item-viewer-lecture-title"]',
    '[data-purpose="lecture-title"]',
  ];
  function udemyLectureFromDom(trace) {
    for (const sel of UDEMY_CURRENT) {
      const text = clean(document.querySelector(sel)?.textContent);
      if (text && text.length < 300) { if (trace) trace.domSelector = sel; return text; }
    }
    return '';
  }
  const udemyAuth = () => {
    const tok = (/(?:^|;\s*)access_token=([^;]+)/.exec(document.cookie) || [])[1];
    return tok ? { Authorization: `Bearer ${tok}`, 'X-Udemy-Authorization': `Bearer ${tok}` } : {};
  };
  async function udemyJson(url, ms = 3000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json', ...udemyAuth() }, signal: ctrl.signal });
      return r.ok ? await r.json() : { httpStatus: r.status };
    } catch (e) { return { httpStatus: 0, error: e.name }; } finally { clearTimeout(t); }
  }
  let udemyCourseIdPromise = null;
  function udemyCourseId(trace) {
    if (!udemyCourseIdPromise) udemyCourseIdPromise = (async () => {
      const pick = (text) => (/"course_?[iI]d"\s*:\s*"?(\d{3,})/.exec(String(text || '')) || [])[1] || '';
      for (const n of document.querySelectorAll('[data-module-args]')) { const id = pick(n.getAttribute('data-module-args')); if (id) return { id, from: 'data-module-args' }; }
      const attr = document.body && (document.body.getAttribute('data-clp-course-id') || document.body.getAttribute('data-course-id'));
      if (/^\d+$/.test(attr || '')) return { id: attr, from: 'body' };
      const inPage = pick(document.documentElement.innerHTML.slice(0, 3e6));
      if (inPage) return { id: inPage, from: 'html' };
      if (udemySlug()) {
        const j = await udemyJson(`/api-2.0/courses/${encodeURIComponent(udemySlug())}/?fields[course]=id`);
        if (j && j.id) return { id: String(j.id), from: 'api-slug' };
        return { id: '', from: `api-slug HTTP ${j && j.httpStatus}` };
      }
      return { id: '', from: VCI18n.t('khong_thay_1o07') };
    })();
    return udemyCourseIdPromise.then((r) => { if (!r.id) udemyCourseIdPromise = null; if (trace) trace.courseId = r; return r.id; });
  }
  const lectureName = (j) => (j && j.title ? clean(`${j.object_index ? `${j.object_index}. ` : ''}${j.title}`) : '');
  const udemyApiTitles = new Map(); // mã bài -> Promise<tên>
  function udemyLectureFromApi(lectureId, outTrace = {}) {
    if (!udemyApiTitles.has(lectureId)) udemyApiTitles.set(lectureId, (async () => {
      const trace = {}; // các bước đã thử, giữ cùng kết quả để báo cáo Chẩn đoán luôn đầy đủ
      const title = await (async () => {
      const courseId = await udemyCourseId(trace);
      if (!courseId) return '';
      // 1) bài của khoá đã đăng ký
      const j = await udemyJson(`/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[lecture]=title,object_index`);
      trace.subscribedApi = j && j.title ? 'ok' : `HTTP ${j && j.httpStatus}`;
      if (lectureName(j)) return lectureName(j);
      // 2) danh sách bài công khai của khoá (không cần đăng nhập)
      let url = `/api-2.0/courses/${courseId}/public-curriculum-items/?page_size=200&fields[lecture]=title,object_index`;
      for (let page = 0; url && page < 10; page++) {
        const list = await udemyJson(url, 5000);
        if (!list || !Array.isArray(list.results)) { trace.publicApi = `HTTP ${list && list.httpStatus}`; break; }
        const hit = list.results.find((x) => String(x.id) === String(lectureId));
        if (hit) { trace.publicApi = 'ok'; return lectureName(hit); }
        url = list.next ? String(list.next).replace(/^https?:\/\/[^/]+/, '') : '';
        if (!url) trace.publicApi = VCI18n.t('khong_thay_bai_1row');
      }
      return '';
      })();
      return { title, trace };
    })());
    return udemyApiTitles.get(lectureId).then((r) => {
      if (!r.title) udemyApiTitles.delete(lectureId); // lỗi tạm thời (mạng, API): lần sau hỏi lại
      Object.assign(outTrace, r.trace);
      return r.title;
    });
  }
  // Bản đọc ngay (cho tiêu đề menu); videoTitle() đầy đủ (có hỏi API) dùng khi đặt tên file
  function videoTitleNow(trace) {
    if (IS_COURSERA) { const t = courseraLecture(trace); return t ? withCourse(t) : tabTitle(); }
    if (!IS_UDEMY) { if (trace) trace.source = VCI18n.t('tieu_de_tab_kynv'); return tabTitle(); }
    const course = udemyCourse();
    const lecture = udemyLectureFromDom(trace);
    const id = udemyLectureId();
    if (trace) trace.source = lecture ? VCI18n.t('danh_sach_bai_1lle') : id ? VCI18n.t('ma_bai_tren_url_yc8j') : VCI18n.t('ten_khoa_khong_thay_9kmq');
    // Không tìm ra tên bài: giữ tên khoá phía trước (chỉ "bài 123" thì không biết là khoá nào)
    return lecture ? withCourse(lecture) : id ? VCI18n.t('bai_1idy', [course, id]) : course;
  }
  async function videoTitleInfo() {
    const trace = { host: location.hostname, udemy: IS_UDEMY, lectureId: IS_UDEMY ? udemyLectureId() : undefined };
    try {
      // Video trong iframe: khung chính mới có tên trang / danh sách bài -> hỏi khung chính
      if (window.top !== window) {
        const r = await Promise.race([chrome.runtime.sendMessage({ type: 'vc:topTitle' }), new Promise((res) => setTimeout(() => res(null), 4000))]).catch(() => null);
        if (r && r.title) return { title: r.title, trace: { ...(r.trace || {}), viaTopFrame: true } };
        return { title: '', trace: { ...trace, source: VCI18n.t('khung_chinh_khong_tra_ww09') } };
      }
      if (IS_UDEMY && !udemyLectureFromDom() && udemyLectureId()) {
        const lecture = await udemyLectureFromApi(udemyLectureId(), trace);
        if (lecture) { trace.source = 'API Udemy'; return { title: withCourse(lecture), trace }; }
      }
      return { title: videoTitleNow(trace), trace };
    } catch (e) { return { title: tabTitle(), trace: { ...trace, source: VCI18n.t('tieu_de_tab_kynv'), error: String(e && e.message) } }; }
  }
  // Tên rỗng: background tự dùng tiêu đề tab (khung chính)
  async function videoTitle() { return (await videoTitleInfo()).title; }
  // Chẩn đoán: các dấu hiệu trên trang để sửa bộ chọn khi Udemy đổi giao diện (không gửi nội dung trang)
  function titleProbe() {
    const purposes = [...new Set([...document.querySelectorAll('[data-purpose]')].map((n) => n.getAttribute('data-purpose')))].filter((p) => /title|curriculum|item|lecture/i.test(p)).slice(0, 40);
    const current = [...document.querySelectorAll('[class*="current" i], [aria-current]')].slice(0, 6).map((n) => ({
      tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 120), ariaCurrent: n.getAttribute('aria-current'),
      titles: [...n.querySelectorAll('[data-purpose]')].slice(0, 4).map((x) => x.getAttribute('data-purpose')), text: clean(n.textContent).slice(0, 80),
    }));
    return { purposes, current, videos: document.querySelectorAll('video').length, iframes: [...document.querySelectorAll('iframe')].slice(0, 5).map((f) => { try { return new URL(f.src, location.href).host; } catch { return ''; } }) };
  }
  window.__videoCatcher.videoTitle = videoTitle;
  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  // ---------- Tìm video ----------
  // Lấy cả shadow root "closed" (API chỉ có trong content script)
  const shadowOf = (n) => {
    try {
      return (chrome.dom && chrome.dom.openOrClosedShadowRoot) ? chrome.dom.openOrClosedShadowRoot(n) : n.shadowRoot;
    } catch {
      return n.shadowRoot;
    }
  };

  // iframe about:blank / srcdoc không có content script riêng -> duyệt từ khung cha (cùng origin)
  function localFrameDoc(iframe) {
    try {
      const w = iframe.contentWindow;
      if (!w || !/^about:/.test(w.location.href)) return null;
      return iframe.contentDocument;
    } catch {
      return null; // khác origin -> đã có content script riêng (all_frames)
    }
  }

  function collectVideos(root = document, out = []) {
    const walker = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType !== 1) continue;
      if (n.localName === 'video') out.push(n);
      else if (n.localName === 'iframe' || n.localName === 'frame') {
        const d = localFrameDoc(n);
        if (d && d.documentElement) collectVideos(d.documentElement, out);
      }
      const sr = shadowOf(n);
      if (sr) collectVideos(sr, out);
    }
    return out;
  }

  function describe(v) {
    const source = v.querySelector('source');
    const src = v.currentSrc || v.src || (source && source.src) || '';
    return {
      id: idOf(v),
      src,
      isBlob: src.startsWith('blob:'),
      isDirect: /^https?:/i.test(src),
      playing: !v.paused && !v.ended && v.readyState > 2,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      currentTime: v.currentTime,
      width: v.videoWidth,
      height: v.videoHeight,
      sources: Array.from(v.querySelectorAll?.('source') || [], (node) => {
        const label = node.getAttribute('label') || node.getAttribute('res') || node.getAttribute('size') || node.getAttribute('data-res') || '';
        const match = /(?:^|\D)(\d{3,4})(?:p|$)/i.exec(label);
        return { url: node.src, contentType: node.type || '', height: match ? Number(match[1]) : 0, referer: location.href };
      }),
    };
  }

  // ---------- Thanh trạng thái nổi trên trang ----------
  const overlay = {
    host: null, text: null, btn: null, hideTimer: null,
    ensure() {
      if (this.host && this.host.isConnected) return;
      const host = document.createElement('div');
      Object.assign(host.style, { position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647' });
      const root = host.attachShadow({ mode: 'closed' });
      const box = document.createElement('div');
      Object.assign(box.style, {
        display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 6px 6px 14px',
        background: 'rgba(24,24,27,.82)', color: '#fff', borderRadius: '999px',
        font: '600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif', fontVariantNumeric: 'tabular-nums',
        boxShadow: '0 10px 30px rgba(0,0,0,.35)', backdropFilter: 'blur(12px) saturate(1.4)', border: '1px solid rgba(255,255,255,.1)',
      });
      const text = document.createElement('span');
      const btn = document.createElement('button');
      btn.textContent = VCI18n.t('dung_luu_urrd');
      Object.assign(btn.style, {
        all: 'unset', cursor: 'pointer', background: '#d32f2f', color: '#fff',
        padding: '6px 12px', borderRadius: '999px', font: 'inherit',
      });
      btn.addEventListener('click', (e) => { e.stopPropagation(); stopRecording(); });
      box.append(text, btn);
      root.append(box);
      (document.body || document.documentElement).append(host);
      Object.assign(this, { host, text, btn });
    },
    show(label) {
      this.ensure();
      clearTimeout(this.hideTimer);
      if (this.btn.style.display) this.btn.style.display = '';
      if (this.text.textContent !== label) this.text.textContent = label;
    },
    toast(msg, ms = 4000) {
      this.ensure();
      this.btn.style.display = 'none';
      this.text.textContent = msg;
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.remove(), ms);
    },
    remove() {
      if (this.host) this.host.remove();
      this.host = null;
    },
  };

  // ---------- Lưu file ----------
  // Ưu tiên chrome.downloads (qua background): chạy được cả trong iframe khác domain / iframe sandbox,
  // nơi Chrome chặn tải bằng thẻ <a download>.
  async function saveBlob(blob, ext, part) {
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 300000);
    const suffix = `${stamp()}${part ? `_phan${part}` : ''}.${ext}`;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'vc:saveRecording', url, suffix, title: await videoTitle(), fallbackTitle: document.title });
      if (r && r.ok) return r.filename || suffix;
      throw new Error((r && r.error) || VCI18n.t('khong_ro_e3hk'));
    } catch {
      const name = `${safeName((await videoTitle()) || document.title)}_${suffix}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      (document.body || document.documentElement).append(a);
      a.click();
      a.remove();
      return name;
    }
  }

  // ---------- Ghi hình ----------
  // Một "phiên" ghi có thể gồm nhiều phần: khi trang đổi nguồn của thẻ video (quảng cáo YouTube → video chính,
  // đổi tập…), luồng cũ kết thúc -> lưu phần hiện tại và tự ghi tiếp phần mới.
  const elapsedMs = (s) => s.accMs + (s.running ? Date.now() - s.resumedAt : 0);

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    return MIME_CANDIDATES.find(([m]) => MediaRecorder.isTypeSupported(m)) || ['', 'webm'];
  }

  async function captureTracks(video) {
    const capture = video.captureStream || video.mozCaptureStream;
    if (typeof capture !== 'function') throw new Error(VCI18n.t('trinh_duyet_khong_ho_127s'));
    let src;
    try {
      src = capture.call(video);
    } catch (e) {
      // EME = video có DRM: trình duyệt chặn ghi, không có cách nào khác trong tiện ích
      if (/EME|encrypted|protected/i.test(e.message)) throw new Error(VCI18n.t('video_co_drm_bao_14g0'));
      throw new Error(VCI18n.t('khong_ghi_duoc_video_1bzu', [e.message]));
    }
    await waitFor(() => src.getVideoTracks().length > 0, 4000);
    if (!src.getVideoTracks().length) {
      throw new Error(VCI18n.t('khong_lay_duoc_khung_no0j'));
    }
    // tiếng có thể xuất hiện chậm hơn hình một chút
    if (!src.getAudioTracks().length) await waitFor(() => src.getAudioTracks().length > 0, 800);
    // Gom vào MediaStream riêng: track mới thêm vào luồng gốc không làm MediaRecorder báo lỗi giữa chừng
    return new MediaStream([src.getVideoTracks()[0], ...src.getAudioTracks().slice(0, 1)]);
  }

  async function startPart(s) {
    const stream = await captureTracks(s.video);
    const options = {
      videoBitsPerSecond: Math.round(Math.min(12e6, Math.max(2.5e6, (s.video.videoWidth || 1280) * (s.video.videoHeight || 720) * 5))),
      audioBitsPerSecond: 192000,
    };
    if (s.mimeType) options.mimeType = s.mimeType;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch {
      recorder = new MediaRecorder(stream); // cấu hình mặc định của trình duyệt
      s.mimeType = recorder.mimeType || '';
      s.ext = /mp4/.test(s.mimeType) ? 'mp4' : 'webm';
    }
    const p = { stream, recorder, chunks: [], reason: null };
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) p.chunks.push(e.data); };
    recorder.onstop = () => onPartStopped(s, p);
    recorder.onerror = (e) => {
      s.lastError = (e.error && e.error.message) || VCI18n.t('khong_ro_e3hk');
      endPart(s, 'error');
    };
    stream.getVideoTracks()[0].addEventListener('ended', () => endPart(s, 'source'));
    s.part = p;
    s.partNo += 1;
    recorder.start(1000); // gom dữ liệu mỗi giây
    if (s.video.paused) recorder.pause();
  }

  // reason: 'user' | 'ended' | 'source' | 'error'
  function endPart(s, reason) {
    const p = s.part;
    if (!p || p.reason) return;
    p.reason = reason;
    if (p.recorder.state !== 'inactive') p.recorder.stop();
    else onPartStopped(s, p);
  }

  async function onPartStopped(s, p) {
    if (p.done) return;
    p.done = true;
    p.stream.getTracks().forEach((t) => t.stop());
    if (s.part === p) s.part = null;
    const continuing = !s.stopped && (p.reason === 'source' || p.reason === 'ended') && s.partNo < MAX_PARTS;

    if (p.chunks.length) {
      const blob = new Blob(p.chunks, { type: (s.mimeType || `video/${s.ext}`).split(';')[0] });
      // chỉ đánh số phần khi phiên có nhiều phần
      const multi = s.partNo > 1 || continuing;
      const name = await saveBlob(blob, s.ext, multi ? s.partNo : 0);
      s.saved.push(name);
      if (!continuing) overlay.toast(VCI18n.t('da_luu_mb_1vde', [(blob.size / 1048576).toFixed(1), name]), 6000);
    } else if (!continuing) {
      overlay.toast(p.reason === 'error'
        ? VCI18n.t('loi_ghi_9gxt', [s.lastError])
        : VCI18n.t('khong_co_du_lieu_10lg'), 6000);
    }

    if (!continuing) return closeSession(s);
    // Nguồn video đổi (vd: hết quảng cáo) -> đợi phát lại rồi ghi tiếp phần mới
    overlay.show(VCI18n.t('nguon_video_thay_doi_1m23', [s.partNo + 1]));
    const ok = await waitFor(() => s.stopped || (!s.video.paused && s.video.readyState > 2 && s.video.isConnected), RESUME_WAIT_MS);
    if (s.stopped || !ok) return closeSession(s, s.saved.length ? VCI18n.t('da_luu_phan_cevk', [s.saved.length]) : null);
    try {
      await startPart(s);
    } catch (e) {
      closeSession(s, e.message);
    }
  }

  function closeSession(s, msg) {
    if (session !== s) return;
    session = null;
    s.cleanup();
    if (msg) overlay.toast(msg, 6000);
    else if (!overlay.host || overlay.btn.style.display !== 'none') overlay.remove();
  }

  async function startRecording(id, fromStart) {
    if (session) throw new Error(VCI18n.t('dang_ghi_mot_video_tzjy'));
    const video = collectVideos().find((v) => idOf(v) === id);
    if (!video) throw new Error(VCI18n.t('video_khong_con_tren_vz6g'));
    const mime = pickMime();
    if (!mime) throw new Error(VCI18n.t('trinh_duyet_khong_ho_63kn'));

    if (fromStart) {
      video.currentTime = 0;
      await once(video, 'seeked', 3000);
    }
    if (video.paused) {
      try {
        await video.play();
      } catch {
        throw new Error(VCI18n.t('trinh_duyet_chan_tu_w2fb'));
      }
    }

    const s = {
      id, video, mimeType: mime[0], ext: mime[1], part: null, partNo: 0, saved: [],
      stopped: false, accMs: 0, resumedAt: Date.now(), running: true, lastError: '',
    };

    const onPause = () => {
      if (s.part && s.part.recorder.state === 'recording') s.part.recorder.pause();
      if (s.running) { s.accMs += Date.now() - s.resumedAt; s.running = false; }
    };
    const onPlay = () => {
      if (s.part && s.part.recorder.state === 'paused') s.part.recorder.resume();
      if (!s.running) { s.resumedAt = Date.now(); s.running = true; }
    };
    let endedTimer = null;
    const onEnded = () => {
      clearTimeout(endedTimer);
      // Hết quảng cáo YouTube cũng bắn "ended" rồi mới nạp video chính -> chờ một chút
      endedTimer = setTimeout(() => {
        if (!s.video.ended && !s.video.paused) return;
        s.stopped = true;
        if (s.part) endPart(s, 'ended');
        else closeSession(s, s.saved.length ? VCI18n.t('da_luu_phan_cevk', [s.saved.length]) : null);
      }, ENDED_GRACE_MS);
    };
    // Trang nạp nguồn mới vào cùng thẻ video
    const onSourceChange = () => { if (s.part) endPart(s, 'source'); };
    video.addEventListener('pause', onPause);
    video.addEventListener('playing', onPlay);
    video.addEventListener('ended', onEnded);
    video.addEventListener('emptied', onSourceChange);

    const ticker = setInterval(() => {
      if (!s.part) return;
      const label = s.running ? '🔴 REC' : VCI18n.t('tam_dung_1lrx');
      overlay.show(`${label} ${fmt(elapsedMs(s))}${s.partNo > 1 ? VCI18n.t('phan_qxnm', [s.partNo]) : ''}`);
    }, 500);

    s.cleanup = () => {
      clearInterval(ticker);
      clearTimeout(endedTimer);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('playing', onPlay);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('emptied', onSourceChange);
    };

    session = s;
    try {
      await startPart(s);
    } catch (e) {
      session = null;
      s.cleanup();
      throw e;
    }
    overlay.show('🔴 REC 00:00');
  }

  function stopRecording() {
    const s = session;
    if (!s) return false;
    s.stopped = true;
    if (s.part) endPart(s, 'user');
    else closeSession(s, s.saved.length ? VCI18n.t('da_luu_phan_cevk', [s.saved.length]) : null);
    return true;
  }

  // ---------- Nút "Tải video này" ở ngoài khung trình phát ----------
  const MIN_W = 200;
  const MIN_H = 110;
  const IS_YOUTUBE = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(location.hostname);
  const EXT_BY_CT = {
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov', 'video/ogg': 'ogv',
    'video/x-flv': 'flv', 'video/3gpp': '3gp', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
    'audio/wav': 'wav', 'audio/webm': 'weba', 'audio/flac': 'flac',
  };
  const fmtSize = (b) => {
    if (!b) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
  };
  // Đuôi chỉ lấy trong danh sách media (link do trang kiểm soát, xem SEC-001)
  const MEDIA_EXTS = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'flv', 'avi', '3gp', 'ts', 'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'];
  const extOf = (f) => {
    const m = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(f.url);
    const fromUrl = m && m[1].toLowerCase();
    return MEDIA_EXTS.includes(fromUrl) ? fromUrl : EXT_BY_CT[(f.contentType || '').split(';')[0]] || 'mp4';
  };

  const DL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px 0 11px; border: 1px solid rgba(255,255,255,.14); border-radius: 999px;
      background: rgba(24, 24, 27, .78); color: #fff; font-weight: 600; cursor: pointer; white-space: nowrap;
      box-shadow: 0 8px 24px rgba(0,0,0,.35); backdrop-filter: blur(12px) saturate(1.4); -webkit-backdrop-filter: blur(12px) saturate(1.4);
      transition: background .15s, transform .15s; }
    .btn:hover { background: #d32f2f; border-color: #d32f2f; transform: translateY(-1px); }
    .btn svg { width: 16px; height: 16px; }
    .wrap.anchored .btn { visibility: hidden; }
    .menu { --bg: #fff; --fg: #111; --mut: #5e5e5e; --line: #e2e2e2; --hov: #ececec; --pri: #d32f2f; --soft: rgba(211,47,47,.10); --onsoft: #a31515; --onpri: #fff;
      position: absolute; top: calc(100% + 6px); right: 0; width: min(320px, calc(100vw - 16px)); max-height: 70vh; overflow: auto;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 14px; padding: 4px 0 6px;
      box-shadow: 0 16px 40px rgba(0,0,0,.28); scrollbar-width: thin; }
    .menu.dark { --bg: #1d1d1d; --fg: #f2f2f2; --mut: #b0b0b0; --line: #333; --hov: #2c2c2c; --pri: #ff6b66; --soft: rgba(255,107,102,.16); --onsoft: #ffb3af; --onpri: #1a0000; }
    .head { display: flex; align-items: flex-start; gap: 8px; padding: 10px 10px 8px 14px; }
    .head .t { flex: 1; min-width: 0; font-weight: 700; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
    .x { flex: none; border: 0; background: none; color: var(--mut); cursor: pointer; font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 7px; }
    .x:hover { background: var(--hov); color: var(--fg); }
    .sec { padding: 10px 14px 4px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--mut); }
    .row { display: grid; grid-template-columns: 1fr auto 16px; align-items: center; gap: 10px; width: 100%; padding: 8px 14px; border: 0;
      background: none; color: inherit; text-align: left; cursor: pointer; }
    .row:hover:not(:disabled) { background: var(--hov); }
    .row:hover:not(:disabled) .go { color: var(--pri); }
    .row:disabled { cursor: default; opacity: .5; }
    .row .nm { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .row b { font-weight: 700; white-space: nowrap; }
    .row .m { color: var(--mut); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .sz { color: var(--mut); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .row .go { display: grid; place-items: center; color: var(--mut); }
    .row .go svg { width: 15px; height: 15px; }
    .row.done .go { color: var(--fg); }
    .row.rec { margin: 0 6px; width: calc(100% - 12px); padding: 8px; border-radius: 10px; background: var(--soft); color: var(--onsoft); }
    .row.rec:hover:not(:disabled) { background: var(--soft); filter: brightness(.97); }
    .row.rec b { font-weight: 700; }
    .row.rec .m, .row.rec .sz, .row.rec .go { color: inherit; }
    .badge { padding: 1px 7px; border-radius: 999px; background: var(--pri); color: var(--onpri); font-size: 11px; font-weight: 500; }
    .row.plain { grid-template-columns: 1fr auto; }
    .note { margin: 2px 14px 6px; padding: 6px 9px; border-radius: 8px; font-size: 12px; color: var(--mut); background: var(--hov); }
    .ok { margin: 6px 14px 2px; font-weight: 500; color: var(--fg); }
    .err { margin: 6px 14px 2px; font-weight: 500; color: var(--pri); }
    .recs { display: flex; gap: 6px; padding: 2px 14px 6px; }
    .recbtn { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px;
      border: 1px solid var(--line); border-radius: 10px; background: none; color: inherit; cursor: pointer; text-align: left; }
    .recbtn b { font-weight: 700; }
    .recbtn span { font-size: 11px; color: var(--mut); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .recbtn:hover:not(:disabled) { border-color: #d32f2f; background: rgba(211,47,47,.08); }
    .recbtn:disabled { cursor: default; opacity: .5; }
    .foot { display: flex; flex-wrap: wrap; gap: 6px; border-top: 1px solid var(--line); margin-top: 6px; padding: 8px 14px 4px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 10px; border: 1px solid var(--line);
      border-radius: 8px; background: none; color: var(--mut); font-size: 12px; font-weight: 600; cursor: pointer; }
    .chip:hover { color: var(--fg); border-color: var(--mut); }
    .head .thumb { flex: none; width: 88px; height: 50px; border-radius: 8px; object-fit: cover; background: var(--hov); }
    .head .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .head .info .t { flex: none; }
    .head .sub { font-size: 12px; color: var(--mut); }
    .menu.player { --bg: rgba(28,28,28,.92); --fg: #fff; --mut: rgba(255,255,255,.7); --line: rgba(255,255,255,.12); --hov: rgba(255,255,255,.1); --pri: #ff6b66; --soft: rgba(255,255,255,.12); --onsoft: #fff; --onpri: #1a0000;
      border-color: transparent; backdrop-filter: blur(12px) saturate(1.4); -webkit-backdrop-filter: blur(12px) saturate(1.4); box-shadow: 0 12px 40px rgba(0,0,0,.5); }
    .skel { height: 14px; margin: 10px 14px; border-radius: 6px; background: linear-gradient(90deg, var(--hov), var(--line), var(--hov)); background-size: 200% 100%; animation: sh 1.2s infinite; }
    @keyframes sh { to { background-position: -200% 0; } }
    .popt { margin: 2px 8px 6px; padding: 4px 4px 2px; border-radius: 10px; border: 1px solid var(--line); }
    .popt .st { font-size: 12px; color: var(--mut); padding: 4px 8px 6px; line-height: 1.45; }
    .popt .st b { color: var(--fg); font-weight: 600; }
    .popt label { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; padding: 3px 8px; font-size: 13px; color: var(--fg); cursor: default; }
    .popt select { max-width: 190px; font: inherit; font-size: 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 3px 6px; cursor: pointer; }
    .popt select:disabled { opacity: .5; cursor: default; }
    .popt .warn { margin: 2px 8px 6px; font-size: 12px; color: var(--pri); }`;
  // Nút "Tải" trong hàng nút dưới video YouTube (cạnh Thích / Chia sẻ), giống nút của YouTube
  const YT_BTN_CSS = `
    :host { all: initial; display: inline-flex; align-items: center; margin-left: 8px; }
    button { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 16px 0 12px; border: 0; border-radius: 18px;
      background: rgba(0,0,0,.05); color: #0f0f0f; font: 500 14px/36px Roboto, Arial, sans-serif; cursor: pointer; white-space: nowrap; }
    button:hover { background: rgba(0,0,0,.1); }
    :host(.dark) button { background: rgba(255,255,255,.1); color: #f1f1f1; }
    :host(.dark) button:hover { background: rgba(255,255,255,.2); }
    svg { width: 20px; height: 20px; }`;
  // Tạo icon bằng DOM (YouTube bật Trusted Types nên không dùng innerHTML)
  function downloadIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
    for (const d of ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14']) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }

  function folderIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z');
    svg.append(p);
    return svg;
  }
  const dl = { host: null, root: null, btn: null, menu: null, video: null, hideTimer: null, open: false, raf: 0, enabled: true, left: null, top: null, btnW: 0, anchor: null };
  const yt = { btn: null, pbtn: null }; // nút "Tải" dưới video và trên thanh điều khiển trình phát YouTube

  chrome.storage.local.get({ overlay: true, overlayOff: [] }).then((cfg) => {
    dl.enabled = cfg.overlay !== false && !(cfg.overlayOff || []).includes(location.hostname);
    syncYouTubeButton();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !(ch.overlay || ch.overlayOff)) return;
    chrome.storage.local.get({ overlay: true, overlayOff: [] }).then((cfg) => {
      dl.enabled = cfg.overlay !== false && !(cfg.overlayOff || []).includes(location.hostname);
      if (!dl.enabled) hideDl(true);
      syncYouTubeButton();
    });
  });

  function dlParent() {
    const fs = document.fullscreenElement;
    return fs && fs.localName !== 'video' ? fs : document.documentElement;
  }

  function ensureDl() {
    const parent = dlParent();
    if (dl.host && dl.host.isConnected && dl.host.parentNode === parent) return;
    if (!dl.host) {
      const host = document.createElement('div');
      host.setAttribute('data-video-catcher', '');
      Object.assign(host.style, { position: 'fixed', zIndex: '2147483647', top: '0', left: '0', display: 'none', willChange: 'transform' });
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = DL_CSS;
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      wrap.className = 'wrap';
      const btn = document.createElement('button');
      btn.className = 'btn';
      const label = document.createElement('span');
      label.textContent = VCI18n.t('tai_5v37');
      btn.title = VCI18n.t('tai_video_nay_video_vl4s');
      btn.append(downloadIcon(), label);
      VCI18n.onChange(() => { label.textContent = VCI18n.t('tai_5v37'); btn.title = VCI18n.t('tai_video_nay_video_vl4s'); });
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.hidden = true;
      wrap.append(btn, menu);
      root.append(style, wrap);
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); dl.open ? closeMenu() : openMenu(); });
      // Không để click/phím trong menu lọt xuống trình phát của trang
      ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'keydown'].forEach((ev) =>
        host.addEventListener(ev, (e) => e.stopPropagation()));
      host.addEventListener('mouseenter', () => clearTimeout(dl.hideTimer));
      // Nội dung menu đến dần (nguồn, chất lượng YouTube…) -> đặt lại vị trí để menu luôn trong màn hình
      if (typeof MutationObserver === 'function') {
        new MutationObserver(() => { if (dl.open) schedulePlace(); }).observe(menu, { childList: true, subtree: true, characterData: true });
      }
      Object.assign(dl, { host, root, btn, menu, wrap });
    }
    parent.append(dl.host);
  }

  // A lazy player can have a visible video element before it assigns src/MSE.
  const isLiveCam = (v) => { try { return !!v.srcObject && typeof MediaStream !== 'undefined' && v.srcObject instanceof MediaStream; } catch { return false; } };
  function hitVideo(v, x, y) {
    if (!v.isConnected || isLiveCam(v)) return 0;
    const r = v.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return 0;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return 0;
    return r.width * r.height;
  }
  const shadowVideos = new Set(); // video nằm trong shadow DOM đã gặp (để lần sau kiểm tra nhanh)
  const hostCache = new WeakMap(); // phần tử -> { vids, at }: video trong shadow DOM của nó

  // Video trong shadow DOM: chỉ xét các phần tử tổ tiên của phần tử dưới con trỏ (mousemove đã cho sẵn), có nhớ kết quả
  function shadowVideoAt(target, x, y) {
    const now = Date.now();
    let el = target;
    for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
      let c = hostCache.get(el);
      if (!c || now - c.at > 2000) {
        const sr = shadowOf(el);
        c = { vids: sr ? collectVideos(sr) : [], at: now };
        hostCache.set(el, c);
      }
      for (const v of c.vids) if (hitVideo(v, x, y)) return v;
    }
    return null;
  }

  function videoAt(x, y) {
    let best = null;
    let bestArea = Infinity;
    const consider = (v) => {
      const area = hitVideo(v, x, y);
      if (area && area < bestArea) { best = v; bestArea = area; }
    };
    for (const v of document.getElementsByTagName('video')) consider(v);
    if (!best) for (const frame of document.querySelectorAll('iframe, frame')) {
      if (VCFrames.isPlayerFrame(frame)) consider(frame);
    }
    for (const v of shadowVideos) { if (v.isConnected) consider(v); else shadowVideos.delete(v); }
    if (!best && ptr.target) {
      const v = shadowVideoAt(ptr.target, x, y);
      if (v && hitVideo(v, x, y) && v.ownerDocument === document) { best = v; shadowVideos.add(v); }
    }
    return best;
  }

  // Menu mở từ nút "Tải" dưới video YouTube: đặt menu ngay dưới nút đó
  function placeAnchored() {
    const a = dl.anchor;
    const r = a.getBoundingClientRect();
    if (!a.isConnected || !r.width) { closeMenu(); return; }
    const left = Math.round(r.left), top = Math.round(r.top);
    dl.host.style.visibility = 'visible';
    dl.host.style.transform = `translate(${left}px, ${top}px)`;
    const menuW = dl.menu.offsetWidth || 320;
    const cap = innerHeight * 0.75;
    const menuH = Math.min(cap, dl.menu.scrollHeight || 300);
    const m = VCPosition.menu({ left, top, right: r.right, bottom: r.bottom }, menuW, menuH, innerWidth, innerHeight);
    dl.menu.style.right = 'auto';
    dl.menu.style.left = `${Math.round(m.left - left)}px`;
    dl.menu.style.top = `${Math.round(m.top - top)}px`;
    dl.menu.style.maxHeight = `${Math.round(Math.min(cap, m.maxHeight))}px`;
  }
  function placeDl() {
    if (dl.anchor && dl.host && dl.open) { placeAnchored(); return; }
    if (!dl.video || !dl.host) return;
    const player = IS_YOUTUBE ? dl.video.closest('#movie_player, .html5-video-player') || dl.video : dl.video;
    const r = player.getBoundingClientRect();
    if (!dl.video.isConnected || r.width < MIN_W || r.height < MIN_H || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      if (!dl.open) hideDl(true);
      return;
    }
    if (!dl.btnW) dl.btnW = dl.btn.offsetWidth || 130;
    const height = dl.btn.offsetHeight || 32;
    const point = VCPosition.outside(r, dl.btnW, height, innerWidth, innerHeight);
    dl.host.style.visibility = point ? 'visible' : 'hidden';
    if (!point) return;
    const left = Math.round(point.left), top = Math.round(point.top);
    if (left !== dl.left || top !== dl.top) {
      dl.left = left;
      dl.top = top;
      dl.host.style.transform = `translate(${left}px, ${top}px)`;
    }
    if (dl.open) {
      // scrollHeight = chiều cao thật của nội dung, không bị max-height của lần đặt trước làm nhỏ đi
      const menuW = dl.menu.offsetWidth || 300;
      const cap = innerHeight * 0.7;
      const menuH = Math.min(cap, dl.menu.scrollHeight || dl.menu.offsetHeight || 300);
      const m = VCPosition.menu({ left, top, right: left + dl.btnW, bottom: top + height }, menuW, menuH, innerWidth, innerHeight);
      dl.menu.style.right = 'auto';
      dl.menu.style.left = `${Math.round(m.left - left)}px`;
      dl.menu.style.top = `${Math.round(m.top - top)}px`;
      dl.menu.style.maxHeight = `${Math.round(Math.min(cap, m.maxHeight))}px`;
    }
  }

  // YouTube: đọc trước danh sách chất lượng ngay khi trang video tải xong và mỗi lần chuyển video,
  // để lúc mở menu Tải là danh sách đã có sẵn.
  let prefetched = '';
  function prefetchYouTube() {
    if (!IS_YOUTUBE) return;
    const url = VCYouTube.normalize(location.href);
    if (url && url !== prefetched) {
      prefetched = url;
      try { chrome.runtime.sendMessage({ type: 'vc:youtubePrefetch', url }).catch(() => {}); } catch { /* extension vừa reload */ }
    }
  }
  if (IS_YOUTUBE && window.top === window) {
    prefetchYouTube();
    document.addEventListener('yt-navigate-finish', prefetchYouTube);
    window.addEventListener('popstate', prefetchYouTube);
  }
  // Trang xem YouTube đã có nút "Tải" dưới video -> không hiện thêm nút nổi cho trình phát chính
  const ytMainPlayer = (video) => !!(((yt.btn && yt.btn.isConnected) || (yt.pbtn && yt.pbtn.isConnected)) && video && video.closest && video.closest('#movie_player'));
  function showDl(video) {
    clearTimeout(dl.hideTimer);
    prefetchYouTube();
    if (dl.anchor) return;
    if (ytMainPlayer(video)) { if (dl.video === video && !dl.open) hideDl(true); return; }
    if (dl.video === video && dl.host && dl.host.style.display !== 'none') return; // vẫn cùng video
    ensureDl();
    if (dl.video !== video && dl.open) closeMenu();
    dl.video = video;
    if (!dl.observer && typeof ResizeObserver === 'function') dl.observer = new ResizeObserver(() => schedulePlace());
    if (dl.observer) {
      dl.observer.disconnect();
      dl.observer.observe(video);
      const player = IS_YOUTUBE && video.closest('#movie_player, .html5-video-player');
      if (player && player !== video) dl.observer.observe(player);
    }
    dl.left = dl.top = null;
    dl.host.style.display = '';
    placeDl();
  }

  function hideDl(now) {
    clearTimeout(dl.hideTimer);
    const doHide = () => {
      if (dl.open) return;
      if (dl.host) dl.host.style.display = 'none';
      if (dl.observer) dl.observer.disconnect();
      dl.video = null;
    };
    if (now) { closeMenu(); doHide(); } else dl.hideTimer = setTimeout(doHide, 900);
  }

  // Rê chuột: chỉ xử lý tối đa 1 lần mỗi khung hình, dùng toạ độ mới nhất
  const ptr = { x: 0, y: 0, onHost: false, target: null };
  function tick() {
    dl.raf = 0;
    if (ptr.onHost) { clearTimeout(dl.hideTimer); return; }
    const { x, y } = ptr;
    if (dl.anchor) return;
    if (dl.video && hitVideo(dl.video, x, y)) {
      // vẫn trên video cũ: chỉ kiểm tra có video nhỏ hơn lồng bên trong không khi thật cần (hiếm) -> bỏ qua
      clearTimeout(dl.hideTimer);
      if (dl.host && dl.host.style.display === 'none') showDl(dl.video);
      return;
    }
    const v = videoAt(x, y);
    if (v) showDl(v);
    else if (dl.video && !dl.open) hideDl(false);
  }
  function onMove(e) {
    if (!dl.enabled) return;
    if (!alive()) { dl.enabled = false; if (dl.host) dl.host.remove(); return; }
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    ptr.target = e.target;
    ptr.onHost = !!dl.host && e.target === dl.host; // sự kiện trong shadow root đóng được quy về host
    if (!dl.raf) dl.raf = requestAnimationFrame(tick);
  }
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('pointerover', onMove, { capture: true, passive: true });
  // Parent documents get pointer entry events even when subsequent motion belongs
  // to a cross-origin iframe. Dock in the parent, outside the whole iframe.
  document.addEventListener('mouseover', (event) => {
    if (VCFrames.isPlayerFrame(event.target)) onMove(event);
  }, { capture: true, passive: true });
  // Chuột rời khỏi khung (vd: video trong iframe) -> không còn mousemove để biết, nên ẩn luôn
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget && dl.video && !dl.open && !VCFrames.isPlayerFrame(dl.video)) hideDl(false); }, { capture: true, passive: true });
  let placeRaf = 0;
  const schedulePlace = () => {
    if (!dl.video || placeRaf) return;
    placeRaf = requestAnimationFrame(() => { placeRaf = 0; placeDl(); });
  };
  addEventListener('scroll', schedulePlace, { capture: true, passive: true });
  addEventListener('resize', () => { dl.btnW = 0; schedulePlace(); }, { passive: true });
  document.addEventListener('fullscreenchange', () => { if (dl.host) { ensureDl(); dl.left = dl.top = null; dl.btnW = 0; placeDl(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dl.open) closeMenu(); }, true);
  document.addEventListener('mousedown', (e) => {
    const path = e.composedPath();
    if (dl.open && dl.host && !path.includes(dl.host) && !(yt.btn && path.includes(yt.btn)) && !(yt.pbtn && path.includes(yt.pbtn))) closeMenu();
  }, true);

  function closeMenu() {
    dl.open = false;
    if (dl.menu) { dl.menu.hidden = true; dl.menu.replaceChildren(); }
    if (dl.anchor) {
      dl.anchor = null;
      dl.wrap?.classList?.remove('anchored');
      if (dl.host) dl.host.style.display = 'none';
      dl.video = null;
    }
  }

  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  // Một hàng: "1080p  H.264 · 60fps        ~948 MB  ⬇"
  function row(label, meta, size, onClick, opts = {}) {
    const b = mk('button', `row${opts.plain ? ' plain' : ''}${opts.rec ? ' rec' : ''}`);
    const nm = mk('span', 'nm');
    nm.append(mk('b', '', label));
    if (meta || opts.rec) {
      const m = mk('span', 'm', meta || '');
      if (opts.rec) { m.append(' '); m.append(mk('span', 'badge', VCI18n.t('de_xuat_ycyt'))); }
      nm.append(m);
    }
    b.append(nm, mk('span', 'sz', size || ''));
    if (!opts.plain) { const go = mk('span', 'go'); go.append(downloadIcon()); b.append(go); }
    if (opts.disabled) b.disabled = true;
    else b.addEventListener('click', (e) => { e.stopPropagation(); dl.lastRow = b; onClick(); });
    if (opts.title) b.title = opts.title;
    return b;
  }
  function flash(msg, isErr) {
    if (!isErr && dl.lastRow && dl.lastRow.isConnected) dl.lastRow.classList?.add('done');
    const n = mk('div', isErr ? 'err' : 'ok', msg);
    dl.menu.append(n);
    n.scrollIntoView({ block: 'nearest' });
    if (!isErr) setTimeout(() => { if (dl.open) closeMenu(); }, 1200);
  }
  // ---------- Kèm phụ đề / thuyết minh từ tiện ích "Song Ngữ & Thuyết Minh" (CC and dịch) ----------
  // Hai tiện ích nói chuyện qua window.postMessage trong khung có video (không cần biết ID của nhau).
  // Khi người dùng chọn chất lượng: mục tải được tạo ngay (kèm post = cách ghép), còn phụ đề ASS/SRT và file WAV
  // thuyết minh do CC and dịch tạo dần trong trang rồi được chuyển cho Trình tải; tải xong video thì ffmpeg ghép.
  const post = { opts: { subLines: 'both', subMode: 'none', dubMode: 'none', useOnline: true }, info: null, helper: null, enabled: true };
  chrome.storage.local.get({ vcPostOpts: {}, postEnabled: true }).then((r) => { Object.assign(post.opts, r.vcPostOpts || {}); if (post.opts.dubMode === 'both') post.opts.dubMode = 'mix'; post.enabled = r.postEnabled !== false; }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.postEnabled) return;
    post.enabled = ch.postEnabled.newValue !== false;
    // Tắt trong Cài đặt khi menu đang mở → gỡ mục ngay, không chờ mở lại menu
    if (!post.enabled) { post.info = null; dl.menu?.querySelectorAll('.popt, .sec.post').forEach((n) => n.remove()); }
  });
  const SUB_LINES = [['orig', VCI18n.t('goc_1bpx')], ['trans', VCI18n.t('dich_p05w')], ['both', VCI18n.t('ca_hai_16zt')]];
  const SUB_MODES = [['none', VCI18n.t('khong_123e')], ['burn', VCI18n.t('in_cung_vao_hinh_1y9u')], ['track', VCI18n.t('track_phu_de_bat_9vid')], ['both', VCI18n.t('ca_hai_16zt')]];
  // Thuyết minh: none = không · track = giữ tiếng gốc, thêm bản thuyết minh riêng (chọn khi xem) · voice = chỉ giọng thuyết minh · mix = trộn
  const DUB_MODES = [['none', VCI18n.t('khong_123e')], ['track', VCI18n.t('tieng_goc_1y7m')], ['voice', VCI18n.t('tieng_dich_1x65')], ['mix', VCI18n.t('tron_12bl')]];
  const DUB_HINT = { none: VCI18n.t('giu_nguyen_tieng_cua_h08a'), track: VCI18n.t('tieng_goc_la_mac_11c0'),
    voice: VCI18n.t('chi_con_giong_thuyet_lalh'), mix: VCI18n.t('giong_thuyet_minh_tieng_vevs') };
  const ysnTarget = (video) => (VCFrames.isPlayerFrame(video) ? video.contentWindow : window);
  let ysnSeq = 0;
  const ysnId = () => `vc${Date.now().toString(36)}${(++ysnSeq).toString(36)}`;
  // Hỏi CC and dịch trong khung có video (≤ 600 ms); null = không cài / chưa chạy trên video này
  function ysnPing(target) {
    return new Promise((resolve) => {
      const requestId = ysnId();
      const stop = (v) => { clearTimeout(timer); window.removeEventListener('message', on); resolve(v); };
      const on = (ev) => { const d = ev.data; if (d && d.type === 'YSN_EXPORT_INFO' && d.requestId === requestId) stop(d.ok ? d : null); };
      const timer = setTimeout(() => stop(null), 600);
      window.addEventListener('message', on);
      try { target.postMessage({ type: 'YSN_EXPORT_PING', requestId }, '*'); } catch { stop(null); }
    });
  }
  const postActive = () => post.enabled && !!post.info && post.helper === true && (post.opts.subMode !== 'none' || post.opts.dubMode !== 'none');
  const postSpec = () => ({ subMode: post.opts.subMode, subLines: ['orig', 'trans', 'both'].includes(post.opts.subLines) ? post.opts.subLines : 'both', dubMode: post.opts.dubMode, useOnline: post.opts.useOnline !== false, lang: post.info?.targetLang || '' });
  const withPost = (msg) => (postActive() ? { ...msg, post: postSpec() } : msg);
  const queuedMsg = () => (postActive() ? VCI18n.t('da_them_vao_trinh_11ov', [[post.opts.subMode !== 'none' ? VCI18n.t('phu_de_rrft') : '', post.opts.dubMode !== 'none' ? VCI18n.t('thuyet_minh_1g0w') : ''].filter(Boolean).join(' + ')]) : VCI18n.t('da_them_vao_trinh_4y70'));
  const langLabel = (c) => { try { return new Intl.DisplayNames(['vi'], { type: 'language' }).of(String(c || '').split('-')[0]) || c; } catch { return c; } };
  // Khối tuỳ chọn trong menu (chỉ hiện khi CC and dịch đang chạy trên video này)
  function postSection(info) {
    post.info = info;
    const box = mk('div', 'popt');
    const voice = info.voice;
    const sel = (key, list, allowed) => {
      const lab = mk('label');
      lab.append(mk('span', '', { subLines: VCI18n.t('phu_de_nd3q'), subMode: VCI18n.t('ghi_phu_de_8nv1'), dubMode: VCI18n.t('thuyet_minh_1cuq'), useOnline: VCI18n.t('giong_online_5vrg') }[key]));
      const s = mk('select');
      for (const [v, t] of list) { const o = mk('option', '', t); o.value = v; s.append(o); }
      const cur = key === 'useOnline' ? String(post.opts.useOnline !== false) : post.opts[key];
      s.value = list.some(([v]) => v === cur) ? cur : list[0][0];
      s.disabled = !allowed;
      if (!allowed) s.value = list[0][0];
      s.addEventListener('change', () => { post.opts[key] = key === 'useOnline' ? s.value !== 'false' : s.value; chrome.storage.local.set({ vcPostOpts: post.opts }).catch(() => {}); });
      s.addEventListener('click', (e) => e.stopPropagation());
      lab.append(s);
      box.append(lab);
      return s;
    };
    sel('subLines', SUB_LINES, info.cues > 0 && !info.sameLang);
    sel('subMode', SUB_MODES, info.cues > 0);
    const dubSel = sel('dubMode', DUB_MODES, info.cues > 0 && !info.noDub && !!voice && !info.sameLang);
    dubSel.title = Object.entries(DUB_HINT).map(([k, v]) => `${DUB_MODES.find(([m]) => m === k)[1]}: ${v}`).join('\n');
    if (voice && voice.online && !info.noDub) sel('useOnline', [['true', VCI18n.t('dung_ton_han_muc_i72q', [voice.name, Math.ceil((info.duration || 0) / 60)])], ['false', VCI18n.t('chuyen_sang_giong_tren_nqog')]], true);
    // Cần bộ tải trên máy (ffmpeg) để ghép: hỏi trạng thái, chưa có thì nói rõ và tắt lựa chọn
    const warn = mk('div', 'warn', VCI18n.t('dang_kiem_tra_bo_q2hg'));
    box.append(warn);
    chrome.runtime.sendMessage({ type: 'vc:helperStatus' }).then((h) => {
      post.helper = !!(h && h.ok);
      if (post.helper) warn.remove();
      else { warn.textContent = VCI18n.t('can_bo_tai_tren_9tgg'); box.querySelectorAll('select').forEach((x) => { x.disabled = true; }); }
    }).catch(() => { post.helper = false; warn.textContent = VCI18n.t('khong_hoi_duoc_bo_7f47'); });
    return box;
  }
  // WAV PCM 16-bit mono từ các khúc Int16 đã nhận
  function wavBlob(buffers, sampleRate) {
    const data = buffers.reduce((n, b) => n + (b ? b.byteLength : 0), 0);
    const h = new DataView(new ArrayBuffer(44));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) h.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); h.setUint32(4, 36 + data, true); str(8, 'WAVE'); str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, sampleRate, true); h.setUint32(28, sampleRate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); str(36, 'data'); h.setUint32(40, data, true);
    return new Blob([h.buffer, ...buffers.filter(Boolean)], { type: 'audio/wav' });
  }
  // Nhờ CC and dịch tạo phụ đề/thuyết minh cho mục tải vừa thêm; dữ liệu xong thì chuyển cho Trình tải (qua service worker)
  function startExport(jobId, target, spec) {
    const requestId = `vc-${jobId}`;
    const chunks = [];
    let lastSent = 0, finished = false;
    const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});
    const stop = () => { finished = true; window.removeEventListener('message', on); };
    const on = async (ev) => {
      const d = ev.data;
      if (finished || !d || typeof d.type !== 'string' || d.requestId !== requestId) return;
      if (d.type === 'YSN_EXPORT_PROGRESS') {
        const now = Date.now();
        if (now - lastSent < 800) return;
        lastSent = now;
        send({ type: 'vc:postProgress', jobId, phase: d.phase, done: d.done, total: d.total, note: d.note || '' });
      } else if (d.type === 'YSN_EXPORT_CHUNK') { if (d.buffer instanceof ArrayBuffer) chunks[d.index] = d.buffer; }
      else if (d.type === 'YSN_EXPORT_ERROR') { stop(); send({ type: 'vc:postError', jobId, error: d.error || VCI18n.t('cc_and_dich_bao_c4nl') }); }
      else if (d.type === 'YSN_EXPORT_DONE') {
        stop();
        // Gửi cho bộ tải trên máy qua service worker theo khúc base64 (không qua Chrome Downloads → không hộp thoại, không rác)
        const blobs = {};
        if (d.ass) blobs.ass = new Blob([d.ass]);
        if (d.srt) blobs.srt = new Blob([d.srt]);
        if (d.voice) blobs.voice = wavBlob(chunks, d.voice.sampleRate);
        if (d.env && d.env.buffer instanceof ArrayBuffer) blobs.env = wavBlob([d.env.buffer], d.env.sampleRate);
        chunks.length = 0;
        const ask = async (m) => { const r = await chrome.runtime.sendMessage(m); if (r && r.error) throw new Error(r.error); return r; };
        const b64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
        try {
          await ask({ type: 'vc:postBegin', jobId });
          const CH = 3 * 1024 * 1024, total = Object.values(blobs).reduce((n, b) => n + b.size, 0);
          let sentBytes = 0, lastP = 0;
          for (const [kind, blob] of Object.entries(blobs)) {
            for (let o = 0; o < blob.size; o += CH) {
              await ask({ type: 'vc:postChunk', jobId, kind, data: await b64(blob.slice(o, o + CH)) });
              sentBytes += Math.min(CH, blob.size - o);
              if (Date.now() - lastP > 800) { lastP = Date.now(); send({ type: 'vc:postProgress', jobId, phase: 'transfer', done: sentBytes, total, note: '' }); }
            }
          }
          await ask({ type: 'vc:postEnd', jobId, meta: d.meta || {} });
        } catch (e) { send({ type: 'vc:postError', jobId, error: e.message }); }
      }
    };
    window.addEventListener('message', on);
    try { target.postMessage({ type: 'YSN_EXPORT_RUN', requestId, subs: spec.subMode !== 'none', lines: spec.subLines || 'both', dub: spec.dubMode !== 'none', useOnline: spec.useOnline !== false }, '*'); }
    catch (e) { stop(); send({ type: 'vc:postError', jobId, error: e.message }); }
    send({ type: 'vc:postProgress', jobId, phase: 'start', done: 0, total: 0, note: '' });
  }
  const afterQueued = (r, video) => { if (r && r.id && postActive()) startExport(r.id, ysnTarget(video), postSpec()); };

  const ytDark = () => document.documentElement.hasAttribute('dark');
  const isDark = () => (IS_YOUTUBE ? ytDark() : !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches));
  const pageTitle = () => String(document.title || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');

  async function openMenu() {
    const video = dl.video;
    if (!video) return;
    dl.open = true;
    const menu = dl.menu;
    menu.hidden = false;
    menu.classList?.toggle('dark', isDark());
    menu.classList?.toggle('player', !!dl.anchor && dl.anchor === yt.pbtn);
    const close = mk('button', 'x', '✕');
    close.title = VCI18n.t('dong_b84t');
    close.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); });
    const head = mk('div', 'head');
    const headTitle = mk('div', 't', (IS_UDEMY || IS_COURSERA ? videoTitleNow() : pageTitle()) || VCI18n.t('tai_video_1mdg'));
    // Udemy (tên bài có thể phải hỏi API) / video trong iframe (tên lấy từ khung chính): cập nhật tiêu đề menu
    if (IS_UDEMY || window.top !== window) videoTitle().then((t) => { if (t) headTitle.textContent = t; });
    headTitle.title = `Video Catcher ${chrome.runtime.getManifest().version}`;
    // YouTube: ảnh thu nhỏ + thời lượng cạnh tiêu đề
    const ytId = (/[?&]v=([\w-]{11})/.exec(VCYouTube.normalize(VCFrames.isPlayerFrame(video) ? video.src : location.href) || '') || [])[1];
    if (ytId) {
      const thumb = mk('img', 'thumb');
      thumb.alt = '';
      thumb.src = `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg`;
      thumb.addEventListener('error', () => thumb.remove());
      const infoBox = mk('div', 'info');
      infoBox.append(headTitle);
      if (Number.isFinite(video.duration) && video.duration > 0) infoBox.append(mk('div', 'sub', `YouTube · ${fmt(video.duration * 1000)}`));
      head.append(thumb, infoBox, close);
    } else head.append(headTitle, close);
    menu.replaceChildren(head, mk('div', 'skel'), mk('div', 'skel'), mk('div', 'skel'));
    // Đặt menu ngay: nút có thể nằm sát mép dưới (vd: trình phát cao 100vh như VieON) và việc dò nguồn
    // có thể mất vài giây. Trước đây menu chỉ được đặt sau khi dò xong nên nằm ngoài màn hình.
    placeDl();
    post.info = null;
    const ysnPingP = post.enabled ? ysnPing(ysnTarget(video)) : Promise.resolve(null);   // tắt trong Cài đặt → không hỏi, không hiện mục

    const frameTarget = VCFrames.isPlayerFrame(video);
    const info = frameTarget ? { src: '', isBlob: true, duration: null } : describe(video);
    const youtubeUrl = VCYouTube.normalize(frameTarget ? video.src : location.href);
    let src = { files: [], streams: [] };
    try {
      if (!youtubeUrl) src = (await chrome.runtime.sendMessage({ type: 'vc:sources', videoSrc: info.src, declaredSources: info.sources || [], referer: location.href })) || src;
    } catch { /* extension vừa reload */ }
    if (!dl.open || dl.video !== video) return;
    // YouTube: chờ danh sách (thường đã đọc trước) để menu hiện một lần, không nhảy
    let ytFirst = null;
    if (youtubeUrl) {
      ytFirst = await Promise.race([chrome.runtime.sendMessage({ type: 'vc:youtubeInfo', url: youtubeUrl }).catch((e) => ({ error: e.message })),
        new Promise((r) => setTimeout(() => r(null), 1500))]);
      if (!dl.open || dl.video !== video) return;
    }
    menu.replaceChildren(head);
    const ysn = await ysnPingP;
    if (!dl.open || dl.video !== video) return;
    if (ysn && post.enabled) { menu.append(mk('div', 'sec post', VCI18n.t('phu_de_thuyet_minh_19yk')), postSection(ysn)); placeDl(); }
    if (!frameTarget && !info.src && !video.readyState && !youtubeUrl) menu.append(mk('div', 'note', VCI18n.t('phat_video_de_bat_1ifm')));
    if (youtubeUrl) {
      menu.append(mk('div', 'sec', VCI18n.t('chat_luong_1imd')));
      let slot = mk('div');
      slot.append(mk('div', 'skel'), mk('div', 'skel'));
      menu.append(slot);
      // Danh sách đọc trước từ trang (đủ mọi mức chất lượng video có)
      const show = (details) => {
        if (!dl.open || dl.video !== video || !slot.isConnected) return false;
        if (details.error) throw new Error(details.error);
        const choices = mk('div');
        if (details.engine === 'browser') {
          const n = mk('div', 'note', VCI18n.t('toi_da_1080p_cai_c9xx'));
          if (details.nativeError) n.title = VCI18n.t('bo_tai_tren_may_1n8h', [String(details.nativeError).slice(0, 300)]);
          choices.append(n);
        }
        const options = details.options && details.options.length ? details.options : details.heights.map((height) => ({ height }));
        // Đề xuất: 1080p nếu có, không thì mức cao nhất ≤ 1080p
        const recH = options.map((o) => o.height).find((h) => h === 1080) || options.map((o) => o.height).find((h) => h && h <= 1080) || 0;
        for (const { height, size, codec, fps } of options) choices.append(row(`${height}p`,
          [codec || '', fps > 30 ? `${fps}fps` : ''].filter(Boolean).join(' · '), size ? `~${fmtSize(size)}` : '', async () => {
          try {
            const title = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
            const result = await chrome.runtime.sendMessage(withPost({ type: 'vc:youtube', url: youtubeUrl, height, title }));
            if (result.error) throw new Error(result.error);
            afterQueued(result, video);
            flash(queuedMsg());
          } catch (error) { flash(error.message, true); }
        }, { rec: height === recH }));
        slot.replaceWith(choices);
        slot = choices;
        placeDl();
        return true;
      };
      const fail = (error) => { if (slot.isConnected) slot.replaceWith(slot = mk('div', 'note', error.message)); };
      if (ytFirst) { try { if (ytFirst.error) throw new Error(ytFirst.error); show(ytFirst); } catch (e) { fail(e); } }
      else chrome.runtime.sendMessage({ type: 'vc:youtubeInfo', url: youtubeUrl }).then(show).catch(fail);
    }

    let any = !!youtubeUrl;
    const streams = src.streams || [];
    if (!youtubeUrl && info.isBlob && !streams.length) {
      menu.append(mk('div', 'note', VCI18n.t('chua_bat_duoc_luong_dzyo')));
    }
    // Luồng có DRM: một dòng giải thích thay vì cả danh sách mức "không tải được"
    const drm = streams.some((s) => s.drm);
    const open = streams.filter((s) => !s.drm);
    if (drm && !open.length) menu.append(mk('div', 'note', VCI18n.t('video_co_drm_bao_14g0')));
    if (open.length) {
      menu.append(mk('div', 'sec', VCI18n.t('chat_luong_1imd')));
      for (const s of open) {
        const kindName = s.kind === 'dash' ? 'DASH' : 'HLS';
        if (s.error || !s.variants || !s.variants.length) {
          menu.append(row(kindName, VCI18n.t('khong_doc_duoc_xqyc', [s.kind === 'dash' ? 'manifest' : 'playlist', s.error || VCI18n.t('rong_61fo')]), '', null, { disabled: true, plain: true, title: s.url }));
          continue;
        }
        const blocked = (s.kind === 'dash' && s.live) ? VCI18n.t('livestream_dash_dung_ghi_vqjv') : '';
        for (const v of s.variants) {
          const unavailable = blocked || (v.needsPlayback ? VCI18n.t('chon_chat_luong_nay_13ns') : '');
          any = any || !unavailable;
          const [head0, ...rest] = String(v.label).split(' · ');
          const meta = unavailable || [s.live ? VCI18n.t('truc_tiep_1esj') : '', ...rest].filter(Boolean).join(' · ');
          menu.append(row(head0, meta, blocked || s.live ? '' : v.estSize ? `~${fmtSize(v.estSize)}` : '', async () => {
            try {
              const common = { type: 'vc:startHls', quality: v.label, title: await videoTitle(), referer: s.referer || location.href, estSize: v.estSize || null, duration: s.duration || null };
              const msg = s.kind === 'dash'
                ? { ...common, kind: 'dash', url: s.url, videoId: v.videoId, audioId: v.audioId, height: v.height, bandwidth: v.bandwidth }
                : { ...common, kind: 'hls', url: v.url, audioUrl: v.audioUrl };
              const r = await chrome.runtime.sendMessage(withPost(msg));
              if (r && r.error) throw new Error(r.error);
              afterQueued(r, video);
              flash(queuedMsg());
            } catch (e) { flash(VCI18n.t('loi_1bgh', [e.message]), true); }
          }, { disabled: !!unavailable, title: unavailable || v.url || s.url }));
        }
      }
    }

    // Clip xem trước / ảnh động khi rê chuột (nhỏ, tên kiểu preview/thumb) -> gom vào mục thu gọn
    const PREVIEW_RE = /preview|thumb|heatmap|sprite|teaser|trailer|poster|storyboard|hover|sample/i;
    const longVideo = (info.duration || 0) > 180;
    const isPreview = (f) => !f.isVideoSrc && (PREVIEW_RE.test(`${f.name} ${f.url}`) || (longVideo && f.size && f.size < 8 * 1048576));
    const allFiles = src.files || [];
    const mainFiles = allFiles.filter((f) => !isPreview(f));
    const previews = allFiles.filter(isPreview);
    const fileRow = (f) => {
      const ext = extOf(f);
      const kind = /^audio\//.test(f.contentType) || /^(mp3|m4a|ogg|wav|flac|weba)$/.test(ext) ? VCI18n.t('am_thanh_12el') : 'Video';
      const dur = f.isVideoSrc && info.duration ? info.duration : 0;
      const meta = [f.quality || '', dur ? fmt(dur * 1000) : '', f.isVideoSrc ? VCI18n.t('nguon_cua_video_nay_1wbi') : f.name].filter(Boolean).join(' · ');
      // Nhãn là định dạng ("MP4", "MP3") như trong popup (ISSUE-006); loại nội dung ghi trong tooltip
      return row(ext.toUpperCase(), meta, fmtSize(f.size), async () => {
        try {
          // tải qua Trình tải: nhiều luồng, có tiến trình, lưu vào thư mục đã chọn
          const r = await chrome.runtime.sendMessage(withPost({ type: 'vc:startHls', kind: 'file', url: f.url, ext, size: f.size || 0, estSize: f.size || null, duration: dur || null, quality: f.quality || ext.toUpperCase(), title: await videoTitle(), referer: f.referer || location.href }));
          if (r && r.error) throw new Error(r.error);
          afterQueued(r, video);
          flash(queuedMsg());
        } catch (e) { flash(VCI18n.t('loi_1bgh', [e.message]), true); }
      }, { title: f.url });
    };
    if (mainFiles.length) {
      menu.append(mk('div', 'sec', 'File'));
      mainFiles.forEach((f) => { any = true; menu.append(fileRow(f)); });
    }

    if (!any && !drm) {
      menu.append(mk('div', 'note', info.isBlob
          ? VCI18n.t('chua_bat_duoc_video_x19r')
          : VCI18n.t('chua_bat_duoc_video_166m')));
    }

    if (previews.length) {
      const box = mk('div');
      box.hidden = true;
      previews.forEach((f) => box.append(fileRow(f)));
      const toggle = row(VCI18n.t('clip_ngan_13vo', [previews.length]), VCI18n.t('xem_truoc_quang_cao_1kl4'), '', () => {
        box.hidden = !box.hidden;
        toggle.querySelector('b').textContent = VCI18n.t('clip_ngan_1www', [box.hidden ? '▸' : '▾', previews.length]);
        placeDl();
      }, { plain: true });
      menu.append(toggle, box);
    }

    // YouTube tải trực tiếp được: bỏ phần Ghi cho menu gọn (vẫn có trong popup)
    // Có DRM thì trình duyệt cũng chặn ghi: không hiện nút Ghi (chỉ dẫn tới lỗi)
    if (!frameTarget && !youtubeUrl && !(drm && !any)) {
    menu.append(mk('div', 'sec', VCI18n.t('ghi_lai_vf3z')));
    const sameVideo = session && session.video === video;
    const recs = mk('div', 'recs');
    menu.append(recs);
    const recBtn = (label, meta, onClick, disabled, title) => {
      const b = mk('button', 'recbtn');
      b.append(mk('b', '', label), mk('span', '', meta));
      if (title) b.title = title;
      if (disabled) b.disabled = true;
      else b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      recs.append(b);
    };
    if (sameVideo) {
      recBtn(VCI18n.t('dung_ghi_e1tz'), VCI18n.t('luu_file_mlpb'), () => { stopRecording(); closeMenu(); });
    } else {
      const doRec = (fromStart) => async () => {
        try {
          await startRecording(idOf(video), fromStart);
          closeMenu();
        } catch (e) { flash(e.message, true); }
      };
      const busy = session ? VCI18n.t('dang_ghi_video_khac_n05c') : '';
      recBtn('● Ghi', busy || VCI18n.t('tu_luc_nay_9rcm'), doRec(false), !!session, VCI18n.t('ghi_lai_video_dang_1upb'));
      if (info.duration) recBtn(VCI18n.t('tu_dau_lpaj'), busy || VCI18n.t('mat_1wwg', [fmt(info.duration * 1000)]), doRec(true), !!session, VCI18n.t('tua_ve_dau_va_1t7v'));
    }

    }
    // Chân menu: các thao tác phụ dạng chip
    const foot = mk('div', 'foot');
    const chip = (text, title, onClick, iconEl) => {
      const c = mk('button', 'chip');
      if (iconEl) c.append(iconEl);
      c.append(text);
      c.title = title;
      c.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      foot.append(c);
    };
    const { destLabel } = await chrome.storage.local.get({ destLabel: 'Downloads › Video Catcher' }).catch(() => ({ destLabel: 'Downloads' }));
    const destFull = String(destLabel).replace(/^📁\s*/, '').replace(/\s*\((hỏi mỗi lần|ask every time)\)$/, '');
    chip(destFull.split(/[›\\/]/).map((x) => x.trim()).filter(Boolean).pop() || destFull, VCI18n.t('luu_vao_bam_de_dxm4', [destFull]), () => { chrome.runtime.sendMessage({ type: 'vc:openManager' }).catch(() => {}); closeMenu(); }, folderIcon());
    // YouTube có đường tải riêng, không cần chẩn đoán nguồn
    if (!youtubeUrl) chip(VCI18n.t('chan_doan_hx87'), VCI18n.t('xem_tien_ich_da_nt93'), () => {
      chrome.runtime.sendMessage({ type: 'vc:openDiagnostics' }).catch((e) => flash(e.message, true));
    });
    chip(VCI18n.t('an_o_trang_nay_1f66'), VCI18n.t('an_nut_tai_tren_ak4t', [location.hostname]), async () => {
      const cfg = await chrome.storage.local.get({ overlayOff: [] });
      const list = new Set(cfg.overlayOff || []);
      list.add(location.hostname);
      await chrome.storage.local.set({ overlayOff: [...list] });
      hideDl(true);
    });
    menu.append(foot);
    placeDl();
  }

  // ---------- YouTube: nút "Tải" trong hàng nút dưới video (cạnh Thích / Chia sẻ) ----------
  // Luôn thấy được, không phải rê chuột lên video; bấm mở cùng menu chọn chất lượng ngay dưới nút.
  // Nút trên thanh điều khiển của trình phát (cạnh phụ đề / cài đặt): thấy được ở mọi chế độ
  // (mặc định, rạp hát, toàn màn hình), kể cả khi hàng nút dưới video bị đẩy khuất.
  function syncPlayerButton() {
    const ctrls = document.querySelector('#movie_player .ytp-right-controls');
    if (!ctrls) return;
    if (!yt.pbtn) {
      const b = document.createElement('button');
      b.className = 'ytp-button';
      b.setAttribute('data-video-catcher-ytp', '');
      b.setAttribute('aria-label', VCI18n.t('tai_video_video_catcher_w3bt'));
      b.title = VCI18n.t('tai_video_video_catcher_w3bt');
      Object.assign(b.style, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'top', opacity: '1' });
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      for (const [k, v] of Object.entries({ viewBox: '0 0 36 36', width: '100%', height: '100%', fill: 'none', stroke: '#fff', 'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
      // Trắng rõ như các nút khác của YouTube (có viền bóng nhẹ để nổi trên nền sáng)
      Object.assign(svg.style, { opacity: '1', filter: 'drop-shadow(0 0 1px rgba(0,0,0,.6))', pointerEvents: 'none' });
      for (const d of ['M18 10v11', 'M13.5 16.5 18 21l4.5-4.5', 'M11.5 25.5h13']) {
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
      }
      b.append(svg);
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleYouTubeMenu(b); });
      ['mousedown', 'pointerdown', 'dblclick'].forEach((ev) => b.addEventListener(ev, (e) => e.stopPropagation()));
      yt.pbtn = b;
    }
    if (yt.pbtn.parentNode !== ctrls) ctrls.prepend(yt.pbtn);
  }
  function syncYouTubeButton() {
    if (!IS_YOUTUBE || window.top !== window) return;
    if (!dl.enabled || location.pathname !== '/watch') { if (yt.btn) yt.btn.remove(); if (yt.pbtn) yt.pbtn.remove(); return; }
    syncPlayerButton();
    const after = document.querySelector('ytd-watch-metadata ytd-menu-renderer #top-level-buttons-computed');
    if (!after) return;
    if (!yt.btn) {
      const host = document.createElement('div');
      host.setAttribute('data-video-catcher-yt', '');
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = YT_BTN_CSS;
      const b = document.createElement('button');
      b.title = VCI18n.t('tai_video_nay_video_vl4s');
      const ytLabel = document.createTextNode(VCI18n.t('tai_5v37'));
      b.append(downloadIcon(), ytLabel);
      VCI18n.onChange(() => { ytLabel.textContent = VCI18n.t('tai_5v37'); b.title = VCI18n.t('tai_video_nay_video_vl4s'); });
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleYouTubeMenu(host); });
      ['mousedown', 'pointerdown', 'keydown'].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));
      root.append(style, b);
      yt.btn = host;
    }
    yt.btn.classList.toggle('dark', ytDark());
    if (!yt.btn.isConnected || yt.btn.previousElementSibling !== after) after.after(yt.btn);
  }
  function toggleYouTubeMenu(anchor) {
    if (!alive()) { teardown(); return; }
    if (dl.open && dl.anchor === anchor) { closeMenu(); return; }
    const video = document.querySelector('#movie_player video');
    if (!video) return;
    if (dl.open) closeMenu();
    hideDl(true);
    ensureDl();
    dl.video = video;
    dl.anchor = anchor;
    dl.wrap.classList.add('anchored');
    dl.host.style.display = '';
    openMenu().catch((error) => {
      if (!alive()) { teardown(); return; }
      if (dl.open) flash(error.message || String(error), true);
    });
  }
  // Tiện ích vừa được tải lại/cập nhật: bản này mồ côi (không gọi được tiện ích nữa) -> gỡ nút để bản mới thay
  let ytTimer = 0;
  function teardown() {
    clearInterval(ytTimer);
    try { closeMenu(); } catch { /* bỏ qua */ }
    for (const n of [yt.btn, yt.pbtn, dl.host]) if (n) n.remove();
    yt.btn = yt.pbtn = null;
    dl.host = null;
    dl.enabled = false;
  }
  if (IS_YOUTUBE && window.top === window) {
    document.addEventListener('yt-navigate-finish', () => { if (dl.anchor) closeMenu(); setTimeout(syncYouTubeButton, 50); });
    ytTimer = setInterval(() => { if (alive()) syncYouTubeButton(); else teardown(); }, 1500);
    syncYouTubeButton();
  }

  // ---------- Playlist do trang tự dựng (báo từ hook.js chạy trong trang) ----------
  let capturedManifests = 0;
  document.addEventListener('video-catcher:segment', (event) => {
    try {
      const data = JSON.parse(event.detail);
      if (typeof data.url === 'string' && data.url.length <= 2000 && /^https?:\/\//i.test(data.url)) {
        chrome.runtime.sendMessage({ type: 'vc:segment', url: data.url }).catch(() => {});
      }
    } catch { /* stale extension or invalid event */ }
  });
  document.addEventListener('video-catcher:manifest', (e) => {
    let d;
    try { d = JSON.parse(e.detail); } catch { return; }
    if (!d || typeof d.key !== 'string' || typeof d.text !== 'string' || !/^(hls|dash)$/.test(d.kind)) return;
    capturedManifests++;
    try {
      chrome.runtime.sendMessage({ type: 'vc:inline', key: d.key.slice(0, 2000), kind: d.kind, text: d.text.slice(0, 4e6), base: String(d.base || location.href).slice(0, 2000), playerDecoded: !!d.playerDecoded }).catch(() => {});
    } catch { /* extension vừa reload */ }
  });

  // ---------- Tab thu YouTube do Trình tải mở (phần trong trang: lib/yt-capture.js) ----------
  // Nhận init/fragment MP4 từ trang, chuyển cho Trình tải qua cổng riêng của tác vụ.
  const captureParams = /^#vc-capture=([\w-]{6,64})\.([\w-]{8,64})\.(\d{3,4})$/.exec(location.hash);
  if (captureParams && window.top === window && IS_YOUTUBE) captureBridge(captureParams[1], captureParams[2]);
  function captureBridge(jobId, token) {
    const CH = 'video-catcher:yt';
    let port;
    try { port = chrome.runtime.connect({ name: `vc-yt:${jobId}:${token}` }); } catch { return; }
    let open = true, started = false, audible = true, chain = Promise.resolve();
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', zIndex: '2147483647', left: '12px', bottom: '12px' });
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'font:600 13px/1.4 system-ui,"Segoe UI",sans-serif;background:rgba(24,24,24,.92);color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.4);max-width:360px';
    const say = (text) => { box.textContent = text; };
    say(VCI18n.t('video_catcher_dang_chuan_1lvv'));
    root.append(box);
    const attach = () => { if (!host.isConnected) (document.body || document.documentElement).append(host); };
    attach();
    document.addEventListener('DOMContentLoaded', attach, { once: true });
    const toB64 = (u8) => (typeof u8.toBase64 === 'function' ? Promise.resolve(u8.toBase64()) : new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const r = String(reader.result); resolve(r.slice(r.indexOf(',') + 1)); };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([u8]));
    }));
    port.onDisconnect.addListener(() => {
      open = false;
      window.postMessage({ 'video-catcher:yt-cmd': token, cmd: 'stop' }, location.origin);
      say(VCI18n.t('video_catcher_da_dung_nfpy'));
      // Trình tải bị đóng giữa chừng -> tự đóng tab thu (chỉ tab do tiện ích mở mới được đóng)
      chrome.runtime.sendMessage({ type: 'vc:ytCaptureEnded' }).catch(() => {});
    });
    window.addEventListener('message', (event) => {
      const d = event.data;
      if (!open || !d || typeof d !== 'object' || d[CH] !== token || typeof d.t !== 'string') return;
      chain = chain.then(async () => {
        if (!open) return;
        const msg = { t: d.t.slice(0, 16), kind: d.kind === 'audio' ? 'audio' : 'video' };
        if (d.data && typeof d.data.byteLength === 'number') msg.b64 = await toB64(new Uint8Array(d.data));
        for (const k of ['time', 'dur', 'covered', 'duration', 'height']) if (Number.isFinite(d[k])) msg[k] = d[k];
        if (typeof d.title === 'string') msg.title = d.title.slice(0, 300);
        if (typeof d.message === 'string') msg.message = d.message.slice(0, 500);
        if (Array.isArray(d.tracks)) msg.tracks = d.tracks.filter((x) => x === 'audio' || x === 'video');
        if (typeof d.audible === 'boolean') msg.audible = d.audible;
        if (!open) return;
        port.postMessage(msg);
        if (msg.t === 'muted') audible = false;
        // Chỉ báo "đã bắt đầu" khi trình phát đã phát ổn định (biết chắc có tiếng hay phải tắt tiếng),
        // để background không đưa một tab thu bị tắt tiếng ra nền (Chrome sẽ bóp tốc độ).
        if (msg.t === 'progress' && msg.covered > 0 && !started) {
          started = true;
          if (msg.audible === false) audible = false;
          chrome.runtime.sendMessage({ type: 'vc:ytCaptureStarted', audible }).catch(() => {});
        }
        if (msg.t === 'progress' && msg.duration) {
          const pct = Math.min(100, Math.floor((msg.covered / msg.duration) * 100));
          say(VCI18n.t('video_catcher_dang_thu_fuzh', [pct, fmt(msg.covered * 1000), fmt(msg.duration * 1000), audible ? VCI18n.t('co_the_chuyen_sang_8fo5') : VCI18n.t('giu_tab_nay_o_7zav')]));
        }
        if (msg.t === 'done') say(VCI18n.t('video_catcher_da_thu_1952'));
        if (msg.t === 'error') say(`Video Catcher: ${msg.message || VCI18n.t('loi_khi_thu_video_ehu5')}`);
      }).catch(() => {});
    });
  }

  document.dispatchEvent(new CustomEvent('video-catcher:ready'));

  // ---------- Nhận lệnh từ popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('vc:')) return false;
    (async () => {
      switch (msg.type) {
        case 'vc:list':
          return {
            extensionVersion: chrome.runtime.getManifest().version,
            capturedManifests,
            frameUrl: location.href,
            videos: collectVideos().filter((v) => !isLiveCam(v)).map(describe).filter((v) => v.src || v.width > 0),
            recording: session ? { id: session.id, elapsedMs: elapsedMs(session), running: session.running, part: session.partNo } : null,
          };
        case 'vc:record':
          await startRecording(msg.id, !!msg.fromStart);
          return { ok: true };
        case 'vc:stop':
          if (!stopRecording()) throw new Error(VCI18n.t('khong_co_ban_ghi_1nh3'));
          return { ok: true };
        case 'vc:videoTitle': { // popup / Chẩn đoán / iframe hỏi tên video để đặt tên file (chỉ khung chính trả lời)
          if (window.top !== window) return undefined;
          const info = await videoTitleInfo();
          return msg.probe ? { ...info, probe: titleProbe() } : info;
        }
        default:
          return undefined;
      }
    })().then(sendResponse, (e) => sendResponse({ error: (e && e.message) || String(e) }));
    return true;
  });
})();
