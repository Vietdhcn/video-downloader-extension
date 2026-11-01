// Video Catcher – thu video YouTube ngay trong trình duyệt (không cần chương trình cài thêm).
// Chạy trong ngữ cảnh trang (MAIN world) từ document_start, NHƯNG chỉ hoạt động trong tab thu do
// Trình tải mở (URL có #vc-capture=<job>.<token>.<chiều cao>). Ở mọi tab khác file này không làm gì.
//
// Cách làm: trình phát YouTube tự tải dữ liệu (đã có chữ ký/PO token hợp lệ) rồi nạp vào MediaSource.
// Ta ép trình phát chọn H.264 + AAC (fMP4) giống tiện ích h264ify, quan sát các lần appendBuffer,
// ghép lại thành từng box MP4 hoàn chỉnh (YouTube có thể cắt giữa box), bỏ đoạn trùng theo thời điểm,
// rồi chuyển init + fragment cho content script. Tua/phát nhanh để trình phát tải hết video.
(() => {
  const PARAMS = /^#vc-capture=([\w-]{6,64})\.([\w-]{8,64})\.(\d{3,4})$/;
  const match = PARAMS.exec(location.hash);
  if (!match || window.top !== window || !/(^|\.)youtube\.com$/i.test(location.hostname)) return;
  const token = match[2];
  const target = Number(match[3]);
  const CH = 'video-catcher:yt';
  const CMD = 'video-catcher:yt-cmd';
  const post = (msg) => { try { window.postMessage({ [CH]: token, ...msg }, location.origin); } catch { /* bỏ qua */ } };

  // ---------- Ép H.264/AAC: YouTube chỉ còn chọn luồng fMP4 mà Trình tải ghép được ----------
  const BLOCK = /webm|vp0?8|vp0?9|av01|av1\b|opus|vorbis|hev1|hvc1|ec-3|ac-3|flac/i;
  const wrap = (obj, key, handler) => {
    try {
      const orig = obj && obj[key];
      if (typeof orig !== 'function') return;
      obj[key] = new Proxy(orig, { apply: (fn, self, args) => handler(fn, self, args) });
    } catch { /* bỏ qua */ }
  };
  wrap(window.MediaSource, 'isTypeSupported', (fn, self, args) => (BLOCK.test(String(args[0])) ? false : Reflect.apply(fn, self, args)));
  wrap(HTMLMediaElement.prototype, 'canPlayType', (fn, self, args) => (BLOCK.test(String(args[0])) ? '' : Reflect.apply(fn, self, args)));
  if (navigator.mediaCapabilities) {
    wrap(Object.getPrototypeOf(navigator.mediaCapabilities), 'decodingInfo', (fn, self, args) => {
      const c = args[0] || {};
      const types = `${c.video?.contentType || ''} ${c.audio?.contentType || ''}`;
      return BLOCK.test(types) ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false }) : Reflect.apply(fn, self, args);
    });
  }

  // ---------- Đọc box MP4 ----------
  const u32 = (b, o) => (b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const typeAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function kids(b, start, end) {
    const out = [];
    for (let o = start; o + 8 <= end;) {
      let size = u32(b, o), hdr = 8;
      if (size === 1) { size = u32(b, o + 8) * 0x100000000 + u32(b, o + 12); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type: typeAt(b, o + 4), start: o, end: o + size, body: o + hdr });
      o += size;
    }
    return out;
  }
  const find = (b, box, type) => kids(b, box.body, box.end).find((x) => x.type === type);
  function initInfo(moov) {
    const root = kids(moov, 0, moov.length)[0];
    const info = { timescale: {}, trexDur: {} };
    for (const trak of kids(moov, root.body, root.end).filter((x) => x.type === 'trak')) {
      const tkhd = find(moov, trak, 'tkhd');
      const mdia = find(moov, trak, 'mdia');
      const mdhd = mdia && find(moov, mdia, 'mdhd');
      if (!tkhd || !mdhd) continue;
      const id = u32(moov, tkhd.body + (moov[tkhd.body] === 1 ? 20 : 12));
      info.timescale[id] = u32(moov, mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12));
    }
    const mvex = find(moov, root, 'mvex');
    if (mvex) for (const trex of kids(moov, mvex.body, mvex.end).filter((x) => x.type === 'trex')) info.trexDur[u32(moov, trex.body + 4)] = u32(moov, trex.body + 12);
    return info;
  }
  // Thời điểm bắt đầu (đơn vị gốc + giây) và thời lượng (giây) của một fragment
  function fragTiming(moof, info) {
    const root = kids(moof, 0, moof.length)[0];
    const traf = root && find(moof, root, 'traf');
    const tfhd = traf && find(moof, traf, 'tfhd');
    const tfdt = traf && find(moof, traf, 'tfdt');
    if (!tfhd || !tfdt) return null;
    const id = u32(moof, tfhd.body + 4);
    const ts = info.timescale[id];
    if (!ts) return null;
    const raw = moof[tfdt.body] === 1 ? u32(moof, tfdt.body + 4) * 0x100000000 + u32(moof, tfdt.body + 8) : u32(moof, tfdt.body + 4);
    const flags = u32(moof, tfhd.body) & 0xffffff;
    let p = tfhd.body + 8;
    if (flags & 0x1) p += 8;
    if (flags & 0x2) p += 4;
    const def = flags & 0x8 ? u32(moof, p) : info.trexDur[id] || 0;
    let total = 0;
    for (const trun of kids(moof, traf.body, traf.end).filter((x) => x.type === 'trun')) {
      const fl = u32(moof, trun.body) & 0xffffff;
      const n = u32(moof, trun.body + 4);
      let q = trun.body + 8;
      if (fl & 0x1) q += 4;
      if (fl & 0x4) q += 4;
      const per = ((fl & 0x100) ? 4 : 0) + ((fl & 0x200) ? 4 : 0) + ((fl & 0x400) ? 4 : 0) + ((fl & 0x800) ? 4 : 0);
      if (fl & 0x100) for (let k = 0; k < n && q + 4 <= trun.end; k++, q += per) total += u32(moof, q);
      else total += n * def;
    }
    return { raw, start: raw / ts, dur: total / ts };
  }
  const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

  // ---------- Quan sát MediaSource / SourceBuffer ----------
  // Mỗi SourceBuffer có bộ ghép box riêng. Dữ liệu đã chuyển đi được theo dõi theo track (video/audio),
  // không theo MediaSource: trình phát có thể tạo MediaSource mới (sau quảng cáo giữa video, khi nạp
  // lại) mà không làm gửi trùng các đoạn đã có.
  const sources = new Map(); // MediaSource -> { buffers: Set<state>, held: [], heldBytes }
  const states = new WeakMap(); // SourceBuffer -> state
  const newTrack = () => ({ init: null, seen: new Set(), spans: [] });
  const tracks = { video: newTrack(), audio: newTrack() };
  let mainMs = null;
  let finished = false;
  let needReload = false;

  wrap(MediaSource.prototype, 'addSourceBuffer', (fn, self, args) => {
    const sb = Reflect.apply(fn, self, args);
    try {
      let src = sources.get(self);
      if (!src) sources.set(self, src = { buffers: new Set(), held: [], heldBytes: 0 });
      const mime = String(args[0] || '');
      const st = { ms: self, kind: /^audio\//i.test(mime) ? 'audio' : 'video', acc: null, moof: null, ftyp: null, info: null };
      src.buffers.add(st);
      states.set(sb, st);
    } catch { /* chỉ quan sát */ }
    return sb;
  });
  wrap(SourceBuffer.prototype, 'appendBuffer', (fn, self, args) => {
    try { feed(states.get(self), args[0]); } catch { /* chỉ quan sát */ }
    return Reflect.apply(fn, self, args);
  });
  wrap(SourceBuffer.prototype, 'abort', (fn, self, args) => {
    const st = states.get(self);
    if (st) { st.acc = null; st.moof = null; }
    return Reflect.apply(fn, self, args);
  });

  const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  // Chuyển một init/fragment của video chính đi (bỏ trùng theo thời điểm, theo dõi phần đã thu)
  function commit(msg) {
    const tr = tracks[msg.kind];
    if (msg.t === 'init') {
      const bytes = new Uint8Array(msg.data);
      if (tr.init && sameBytes(tr.init, bytes)) return;
      if (tr.init) {
        // Đổi chất lượng/định dạng: dữ liệu cũ không ghép chung được với init mới -> thu lại track này
        if (tr.seen.size) needReload = true;
        tr.seen.clear();
        tr.spans = [];
        post({ t: 'reset', kind: msg.kind });
      }
      tr.init = bytes;
      post({ t: 'init', kind: msg.kind, data: msg.data });
      return;
    }
    if (!tr.init || tr.seen.has(msg.key)) return;
    tr.seen.add(msg.key);
    tr.spans.push([msg.time, msg.time + msg.dur]);
    post({ t: 'frag', kind: msg.kind, time: msg.time, dur: msg.dur, data: msg.data });
  }
  function emit(st, msg) {
    const src = sources.get(st.ms);
    if (!src) return;
    if (src === mainMs) { commit(msg); return; }
    // Chưa biết đây là video chính hay quảng cáo -> giữ lại có giới hạn; không bao giờ bỏ init
    src.held.push(msg);
    src.heldBytes += msg.data ? msg.data.byteLength : 0;
    const cap = mainMs ? 64 * 1048576 : 256 * 1048576;
    while (src.heldBytes > cap) {
      const k = src.held.findIndex((m) => m.t === 'frag');
      if (k < 0) break;
      src.heldBytes -= src.held[k].data.byteLength;
      src.held.splice(k, 1);
    }
  }
  function feed(st, data) {
    if (!st || finished) return;
    const u = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!u || !u.length) return;
    const b = st.acc ? concat(st.acc, u) : u.slice(); // sao chép: trình phát có thể dùng lại bộ đệm
    let o = 0;
    while (o + 8 <= b.length) {
      let size = u32(b, o), hdr = 8;
      const type = typeAt(b, o + 4);
      if (size === 1) {
        if (o + 16 > b.length) break;
        size = u32(b, o + 8) * 0x100000000 + u32(b, o + 12);
        hdr = 16;
      }
      if (!/^[a-z0-9 ]{4}$/i.test(type) || size < hdr || size > 512 * 1048576) { st.acc = null; st.moof = null; return; } // mất đồng bộ
      if (o + size > b.length) break;
      onBox(st, type, b.subarray(o, o + size));
      o += size;
    }
    st.acc = o >= b.length ? null : b.slice(o);
  }
  function onBox(st, type, bytes) {
    if (type === 'ftyp') st.ftyp = bytes.slice();
    else if (type === 'moov') {
      const init = st.ftyp ? concat(st.ftyp, bytes) : bytes.slice();
      st.info = initInfo(bytes);
      emit(st, { t: 'init', kind: st.kind, data: init.buffer });
    } else if (type === 'moof') st.moof = bytes.slice();
    else if (type === 'mdat' && st.moof && st.info) {
      const timing = fragTiming(st.moof, st.info);
      const moof = st.moof;
      st.moof = null;
      if (!timing) return;
      emit(st, { t: 'frag', kind: st.kind, key: Math.round(timing.start * 1000), time: timing.start, dur: timing.dur, data: concat(moof, bytes).buffer });
    }
  }
  // Thời điểm đầu tiên chưa thu (tính liên tục từ 0)
  function coveredEnd(kind) {
    const spans = tracks[kind].spans.slice().sort((a, b) => a[0] - b[0]);
    let cur = 0;
    for (const [s, e] of spans) { if (s > cur + 0.3) break; cur = Math.max(cur, e); }
    return cur;
  }

  // ---------- Điều khiển trình phát ----------
  const LABELS = [[2160, 'hd2160'], [1440, 'hd1440'], [1080, 'hd1080'], [720, 'hd720'], [480, 'large'], [360, 'medium'], [240, 'small'], [144, 'tiny']];
  const expected = () => {
    const n = Number(window.ytInitialPlayerResponse?.videoDetails?.lengthSeconds);
    return n > 0 ? n : 0;
  };
  let chosen = null;
  let metaSent = false;
  let lastCovered = -1;
  let lastGrowth = Date.now();
  let lastBeat = 0;
  let nudged = 0;
  let reloads = 0;
  let mutedFallback = false;
  let lastProgress = 0;

  function pickMain() {
    const want = expected();
    let best = null;
    for (const [ms, src] of sources) {
      if (ms.readyState === 'closed') { if (src !== mainMs) sources.delete(ms); continue; } // quảng cáo/nguồn cũ đã đóng
      const d = ms.duration;
      if (!Number.isFinite(d) || d <= 0 || src.buffers.size === 0) continue;
      if (want ? Math.abs(d - want) <= 2.5 : d > 30) { if (!best || d > best[0].duration) best = [ms, src]; }
    }
    if (best && best[1] !== mainMs) {
      if (mainMs) for (const [ms, src] of sources) if (src === mainMs) sources.delete(ms);
      mainMs = best[1];
      const held = mainMs.held;
      mainMs.held = [];
      mainMs.heldBytes = 0;
      held.forEach(commit);
    }
    return best ? best[0] : null;
  }

  function finish() {
    finished = true;
    post({ t: 'done' });
    try { document.querySelector('video')?.pause(); } catch { /* bỏ qua */ }
  }
  function fail(message) {
    finished = true;
    post({ t: 'error', message });
    try { document.querySelector('video')?.pause(); } catch { /* bỏ qua */ }
  }
  function checkStall(now) {
    if (now - lastGrowth > 120000) {
      fail(mainMs ? "YouTube stopped sending data. Retry or pick a lower quality."
        : "Capture could not start: the video is not playing (login, age verification or a block may be needed).");
    }
  }

  function tick() {
    if (finished) return;
    const now = Date.now();
    if (now - lastBeat > 5000) { lastBeat = now; post({ t: 'alive' }); } // Trình tải biết tab còn chạy
    const player = document.getElementById('movie_player');
    const video = player?.querySelector('video') || document.querySelector('video');
    if (!player || !video) { checkStall(now); return; }
    try {
      const levels = (player.getAvailableQualityLevels?.() || []).filter((l) => l !== 'auto');
      if (levels.length) {
        const available = LABELS.filter(([, label]) => levels.includes(label));
        const pick = available.find(([h]) => h <= target) || available[available.length - 1];
        if (pick && player.getPlaybackQuality?.() !== pick[1]) player.setPlaybackQualityRange?.(pick[1], pick[1]);
        if (pick) chosen = pick[0];
      }
    } catch { /* bỏ qua */ }
    // Giữ video có tiếng (tab đã bị tiện ích tắt tiếng) để Chrome không bóp tốc độ tab chạy nền.
    if (video.muted && !mutedFallback) video.muted = false;
    if (video.paused && !video.ended) {
      video.play().catch(() => { mutedFallback = true; video.muted = true; video.play().catch(() => {}); post({ t: 'muted' }); });
    }
    if (player.classList.contains('ad-showing')) { lastGrowth = now; return; } // quảng cáo: chờ hết, không tính là đứng yên
    if (needReload && reloads < 2) {
      // Đổi chất lượng sau khi đã thu: phần đã đệm ở chất lượng cũ sẽ không được tải lại -> nạp lại video từ đầu
      needReload = false;
      reloads++;
      lastGrowth = now;
      const id = player.getVideoData?.().video_id || window.ytInitialPlayerResponse?.videoDetails?.videoId;
      try { if (id && player.loadVideoById) player.loadVideoById(id, 0); else video.currentTime = 0; } catch { /* bỏ qua */ }
      return;
    }
    if (video.playbackRate !== 2) video.playbackRate = 2;
    const ms = pickMain();
    if (!ms) { checkStall(now); return; }
    const duration = expected() || ms.duration;
    const kinds = [...new Set([...mainMs.buffers].map((b) => b.kind))];
    if (!kinds.length) { checkStall(now); return; }
    if (!metaSent && chosen) {
      metaSent = true;
      const title = player.getVideoData?.().title || window.ytInitialPlayerResponse?.videoDetails?.title || document.title.replace(/ - YouTube$/, '');
      post({ t: 'meta', title, duration, height: chosen, tracks: kinds });
    }
    const covered = Math.min(...kinds.map(coveredEnd));
    if (now - lastProgress > 700) { lastProgress = now; post({ t: 'progress', covered, duration, audible: !video.muted }); }
    if (covered >= duration - 0.75 || (video.ended && covered >= duration - 2)) { finish(); return; }
    if (covered > lastCovered + 0.05) { lastCovered = covered; lastGrowth = now; nudged = 0; }
    // Đoạn đã đệm chứa vị trí phát hiện tại
    const t = video.currentTime;
    let bufEnd = t;
    for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) - 0.2 <= t && t <= video.buffered.end(i) + 0.2) bufEnd = video.buffered.end(i);
    if (covered < t - 1.5 || covered > bufEnd + 2) video.currentTime = Math.max(0, covered - 0.1); // lỗ hổng ở chỗ khác -> tua tới đó
    else if (bufEnd - t > 8) video.currentTime = Math.max(t, bufEnd - 3); // đã đệm xa -> nhảy tới gần cuối để trình phát tải tiếp
    const stalled = now - lastGrowth;
    if (stalled > 20000 * (nudged + 1) && nudged < 3) { nudged++; video.currentTime = Math.max(0, covered - 0.1); }
    checkStall(now);
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data[CMD] === token && e.data.cmd === 'stop') {
      finished = true;
      try { document.querySelector('video')?.pause(); } catch { /* bỏ qua */ }
    }
  });
  const timer = setInterval(() => { if (finished) clearInterval(timer); else { try { tick(); } catch { /* bỏ qua */ } } }, 400);
})();
