// Video Catcher – chạy trong ngữ cảnh của trang (MAIN world) từ document_start.
// Bắt playlist mà trang tự dựng trong trình duyệt (không có request mạng để bắt):
//  1) URL.createObjectURL(Blob chứa #EXTM3U / <MPD)
//  2) trình phát hls.js nạp xong danh sách đoạn (kể cả khi trang dùng bộ nạp riêng để giấu link)
// Nguyên tắc để không xung đột với trang / extension khác:
//  - không tạo biến toàn cục, không định nghĩa thuộc tính trên window
//  - bọc hàm bằng Proxy: tên, độ dài và toString vẫn như hàm gốc ("[native code]")
//  - báo cho content script bằng sự kiện riêng (chuỗi JSON), không dùng window.postMessage
(() => {
  const EVT = 'video-catcher:manifest';
  const MARK = Symbol.for('video-catcher.hook');
  if (document[MARK]) return; // đã cài trong khung này
  try { Object.defineProperty(document, MARK, { value: true }); } catch { /* bỏ qua */ }

  const send = (detail) => {
    try { document.dispatchEvent(new CustomEvent(EVT, { detail: JSON.stringify(detail) })); } catch { /* bỏ qua */ }
  };

  const lastSent = new Map(); // key -> { text, at, timer }
  // MAIN world can run before the isolated content script has its listener.
  document.addEventListener('video-catcher:ready', () => {
    for (const [key, entry] of lastSent) send({ key, kind: entry.kind, text: entry.text, base: entry.base, playerDecoded: entry.playerDecoded });
  });
  function report(key, kind, text, base, playerDecoded = false) {
    if (!key || !text || text.length > 4e6) return;
    const prev = lastSent.get(key);
    if (prev && prev.text === text) return;
    const upgraded = prev && /^#ENC-AESGCM/im.test(prev.text) && !/^#ENC-AESGCM/im.test(text);
    const entry = prev || { at: 0, timer: 0 };
    entry.text = text;
    entry.kind = kind;
    entry.base = base || location.href;
    entry.playerDecoded = playerDecoded;
    lastSent.set(key, entry);
    if (lastSent.size > 60) lastSent.delete(lastSent.keys().next().value);
    const fire = () => {
      entry.at = Date.now();
      entry.timer = 0;
      send({ key, kind: entry.kind, text: entry.text, base: entry.base, playerDecoded: entry.playerDecoded });
    };
    const wait = prev && !upgraded ? 8000 - (Date.now() - prev.at) : 0; // decoded envelopes must replace ciphertext immediately
    if (wait <= 0) { clearTimeout(entry.timer); fire(); } else if (!entry.timer) entry.timer = setTimeout(fire, wait);
  }

  // Observe text already read by the player. This also works when Hls is
  // bundled privately and the service worker cannot repeat a signed request.
  const wrapped = new Map(); // IV -> response context; no cryptographic keys
  const decoded = new Map(); // IV -> manifest text already decrypted by the player
  const ivHex = (data) => {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  function inspectText(text, url, key = url) {
    if (typeof text !== 'string' || text.length > 4e6) return;
    const start = text.indexOf('#EXTM3U');
    const clean = (start >= 0 && start < 4096 ? text.slice(start) : text).replace(/^\uFEFF/, '').trimStart();
    const kind = /^#EXTM3U[^\S\r\n]*(?:\r?\n|$)/.test(clean) ? 'hls'
      : /^(<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(clean) ? 'dash' : null;
    if (kind) {
      const base = url || location.href;
      const envelope = /^#ENC-AESGCM;iv=([a-f0-9]+)/im.exec(clean);
      if (envelope) {
        const iv = envelope[1].toLowerCase();
        wrapped.set(iv, { key: key || base, base });
        if (wrapped.size > 60) wrapped.delete(wrapped.keys().next().value);
        if (decoded.has(iv)) { report(key || base, 'hls', decoded.get(iv), base, true); return; }
      }
      report(key || base, kind, clean, base);
    }
  }
  // Shaka and other players read manifests as ArrayBuffer, then decode them.
  // Remember the response URL so relative segment paths retain their base.
  const bufferUrls = new WeakMap();
  const NativeDecoder = typeof TextDecoder === 'function' ? TextDecoder : null;
  const nativeDecode = NativeDecoder && NativeDecoder.prototype.decode;
  // Observe the page's own successful decrypt result without changing the
  // promise, algorithm or key, and without exporting cryptographic keys.
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && nativeDecode) {
      crypto.subtle.decrypt = new Proxy(crypto.subtle.decrypt, {
        apply(target, self, args) {
          const result = Reflect.apply(target, self, args);
          let iv;
          try { if (/^AES-GCM$/i.test(args[0]?.name) && args[0].iv) iv = ivHex(args[0].iv); } catch { /* no correlation */ }
          if (iv) result.then((bytes) => {
            try {
              if (bytes.byteLength > 4e6) return;
              const text = Reflect.apply(nativeDecode, new NativeDecoder(), [bytes]);
              if (!/^\uFEFF?\s*#EXTM3U\s*[\r\n]/.test(text) || !/#EXT(?:INF:|-X-STREAM-INF:)/.test(text) || /^#ENC-AESGCM/im.test(text)) return;
              decoded.set(iv, text);
              if (decoded.size > 60) decoded.delete(decoded.keys().next().value);
              const context = wrapped.get(iv);
              if (context) {
                bufferUrls.set(bytes, context.base);
                report(context.key, 'hls', text, context.base, true);
              }
            } catch { /* observation must not affect the player */ }
          }, () => {});
          return result;
        },
      });
    }
  } catch { /* locked or unavailable Web Crypto implementation */ }
  const reportedSegments = new Set();
  const isPdfUrl = (url) => /\.pdf(?:[?#]|$)/i.test(url || '');
  function isTsSegment(bytes) {
    const end = Math.min(bytes.length - 376, 4096);
    for (let i = 0; i < end; i++) {
      if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) return true;
    }
    return false;
  }
  function reportSegment(url) {
    if (!isPdfUrl(url) || reportedSegments.has(url)) return;
    reportedSegments.add(url);
    if (reportedSegments.size > 500) reportedSegments.delete(reportedSegments.values().next().value);
    try { document.dispatchEvent(new CustomEvent('video-catcher:segment', { detail: JSON.stringify({ url }) })); } catch { /* observation only */ }
  }
  function inspectBuffer(data, url) {
    try {
      if (!data || !nativeDecode || data.byteLength < 8) return;
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      if (isPdfUrl(url) && isTsSegment(bytes)) { reportSegment(url); return; }
      if (data.byteLength > 4e6) return;
      const decoder = new NativeDecoder();
      const head = Reflect.apply(nativeDecode, decoder, [bytes.subarray(0, 4096)]);
      if (!/#EXTM3U|<MPD[\s>]/i.test(head)) return;
      inspectText(Reflect.apply(nativeDecode, decoder, [bytes]), url);
    } catch { /* observation must never break playback */ }
  }
  // Some players consume Response.body with a reader instead of calling text()
  // or arrayBuffer(). Inspect a bounded clone and leave the player's stream alone.
  async function inspectResponse(response) {
    let reader;
    let timer;
    let timedOut = false;
    try {
      if (!response.ok || !nativeDecode || !response.body || (!isPdfUrl(response.url) && Number(response.headers.get('content-length')) > 4e6)) return;
      reader = response.clone().body.getReader();
      timer = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, 4000);
      const chunks = [];
      let size = 0;
      let recognized = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4e6) return;
        chunks.push(value);
        if (!recognized) {
          const head = new Uint8Array(Math.min(size, 4096));
          let offset = 0;
          for (const chunk of chunks) {
            const part = chunk.subarray(0, head.length - offset);
            head.set(part, offset);
            offset += part.length;
            if (offset === head.length) break;
          }
          recognized = /#EXTM3U|<MPD[\s>]/i.test(Reflect.apply(nativeDecode, new NativeDecoder(), [head]));
          if (isPdfUrl(response.url) && isTsSegment(head)) { reportSegment(response.url); return; }
          if (!recognized && size >= 4096) return;
        }
      }
      if (!timedOut && size && recognized) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        inspectBuffer(bytes, response.url);
      }
    } catch { /* clone/read failure must not affect playback */ }
    finally {
      clearTimeout(timer);
      if (reader) reader.cancel().catch(() => {});
    }
  }
  if (typeof globalThis.fetch === 'function') {
    try {
      globalThis.fetch = new Proxy(globalThis.fetch, {
        apply(target, self, args) {
          const result = Reflect.apply(target, self, args);
          result.then((response) => { inspectResponse(response); }, () => {});
          return result;
        },
      });
    } catch { /* locked fetch */ }
  }
  try {
    Response.prototype.arrayBuffer = new Proxy(Response.prototype.arrayBuffer, {
      apply(target, self, args) {
        return Reflect.apply(target, self, args).then((data) => {
          try { bufferUrls.set(data, self.url); inspectBuffer(data, self.url); } catch { /* observation only */ }
          return data;
        });
      },
    });
  } catch { /* locked or unavailable prototype */ }
  if (nativeDecode) {
    try {
      NativeDecoder.prototype.decode = new Proxy(nativeDecode, {
        apply(target, self, args) {
          const text = Reflect.apply(target, self, args);
          try {
            const data = args[0];
            const base = data && (bufferUrls.get(data) || (data.buffer && bufferUrls.get(data.buffer)));
            // If the decoder has no URL, Blob/response inspection supplies it.
            if (base) inspectText(text, base);
          } catch { /* observation only */ }
          return text;
        },
      });
    } catch { /* locked prototype */ }
  }
  try {
    Response.prototype.text = new Proxy(Response.prototype.text, {
      apply(target, self, args) {
        return Reflect.apply(target, self, args).then((text) => {
          try { inspectText(text, self.url); } catch { /* observation only */ }
          return text;
        });
      },
    });
  } catch { /* locked prototype */ }
  try {
    const observed = new WeakSet();
    XMLHttpRequest.prototype.send = new Proxy(XMLHttpRequest.prototype.send, {
      apply(target, self, args) {
        if (!observed.has(self)) {
          observed.add(self);
          self.addEventListener('load', () => {
            try {
              if (!self.responseType || self.responseType === 'text') inspectText(self.responseText, self.responseURL);
              else if (self.responseType === 'arraybuffer' && self.response) {
                bufferUrls.set(self.response, self.responseURL);
                inspectBuffer(self.response, self.responseURL);
              } else if (self.responseType === 'blob') inspectBlob(self.response, self.responseURL);
            } catch { /* inaccessible response */ }
          });
        }
        return Reflect.apply(target, self, args);
      },
    });
  } catch { /* locked prototype */ }

  // 1) Blob playlist – Proxy giữ nguyên tên/độ dài/toString của hàm gốc
  function inspectBlob(obj, url) {
      try {
        if (!(obj instanceof Blob) || obj.size < 8 || obj.size > 4e6) return;
        obj.slice(0, 4096).text().then((head) => {
          if (/#EXTM3U|<MPD[\s>]/i.test(head)) {
            return obj.text().then((text) => {
              // Blob URLs cannot resolve relative segment references.
              inspectText(text, /^https?:/i.test(url) ? url : location.href, url);
            });
          }
        }).catch(() => {});
      } catch { /* bỏ qua */ }
  }
  const origCreate = URL.createObjectURL;
  if (typeof origCreate === 'function') {
    try {
      URL.createObjectURL = new Proxy(origCreate, {
        apply(target, thisArg, args) {
          const url = Reflect.apply(target, thisArg, args);
          inspectBlob(args[0], url);
          return url;
        },
      });
    } catch { /* trang/extension khác đã khoá */ }
  }

  // 2) hls.js: dựng lại playlist từ danh sách đoạn mà trình phát đã nạp
  const hex = (u8) => Array.from(u8 || [], (b) => b.toString(16).padStart(2, '0')).join('');
  function fromDetails(d) {
    const frags = d && d.fragments;
    if (!frags || !frags.length) return null;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${Math.ceil(d.targetduration || 10)}`, `#EXT-X-MEDIA-SEQUENCE:${d.startSN || 0}`];
    let lastKey = '';
    let lastMap = '';
    for (const f of frags) {
      const dd = f.decryptdata;
      const key = dd && dd.method && dd.method !== 'NONE'
        ? `#EXT-X-KEY:METHOD=${dd.method},URI="${dd.uri}"${dd.iv ? `,IV=0x${hex(dd.iv)}` : ''}${dd.keyFormat && dd.keyFormat !== 'identity' ? `,KEYFORMAT="${dd.keyFormat}"` : ''}`
        : '#EXT-X-KEY:METHOD=NONE';
      if (key !== lastKey && !(key.endsWith('NONE') && !lastKey)) { lines.push(key); lastKey = key; }
      const init = f.initSegment;
      if (init && init.url) {
        const br = init.byteRange && init.byteRange.length === 2 ? `,BYTERANGE="${init.byteRange[1] - init.byteRange[0]}@${init.byteRange[0]}"` : '';
        const m = `#EXT-X-MAP:URI="${init.url}"${br}`;
        if (m !== lastMap) { lines.push(m); lastMap = m; }
      }
      lines.push(`#EXTINF:${Number(f.duration || 0).toFixed(3)},`);
      if (f.byteRange && f.byteRange.length === 2 && f.byteRange[1] > f.byteRange[0]) lines.push(`#EXT-X-BYTERANGE:${f.byteRange[1] - f.byteRange[0]}@${f.byteRange[0]}`);
      lines.push(f.url);
    }
    if (!d.live) lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
  }
  const patched = new WeakSet();
  function reportLevels(player, data) {
    const levels = data.levels || player.levels;
    const source = player.url || data.url;
    if (!source || !Array.isArray(levels) || !levels.length) return;
    // Keep an observed master with its original language/subtitle metadata.
    if (lastSent.get(source)?.text.includes('#EXT-X-STREAM-INF:')) return;
    const lines = ['#EXTM3U'];
    const quote = (value) => String(value || '').replace(/["\r\n]/g, '');
    const absolute = (url) => { try { return new URL(url, /^https?:/i.test(source) ? source : location.href).href; } catch { return ''; } };
    for (const track of data.audioTracks || player.audioTracks || []) {
      if (!track.url) continue;
      const url = absolute(track.url);
      if (!url || /[\r\n]/.test(url)) continue;
      lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${quote(track.groupId || 'audio')}",NAME="${quote(track.name || track.lang || 'Audio')}",DEFAULT=${track.default ? 'YES' : 'NO'},URI="${quote(url)}"`);
    }
    for (const level of levels.slice(0, 100)) {
      const urls = Array.isArray(level.url) ? level.url : [level.url];
      for (const raw of urls) {
        const url = absolute(raw);
        if (!raw || !/^(https?:|blob:)/i.test(url) || /[\r\n]/.test(url)) continue;
        const attrs = [`BANDWIDTH=${Math.max(1, Number(level.bitrate || level.maxBitrate) || 1)}`];
        if (level.width && level.height) attrs.push(`RESOLUTION=${Number(level.width)}x${Number(level.height)}`);
        if (level.frameRate) attrs.push(`FRAME-RATE=${Number(level.frameRate)}`);
        const codecs = level.attrs?.CODECS || [level.videoCodec, level.audioCodec].filter(Boolean).join(',');
        if (codecs) attrs.push(`CODECS="${quote(codecs)}"`);
        const group = level.attrs?.AUDIO || level.audioGroupIds?.[0];
        if (group) attrs.push(`AUDIO="${quote(group)}"`);
        lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, url);
      }
    }
    if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'))) {
      report(`hls-levels:${source}`, 'hls', lines.join('\n') + '\n', source, !!lastSent.get(source)?.playerDecoded);
    }
  }
  function patchHls(H) {
    try {
      const proto = H && H.prototype;
      if (!proto || patched.has(proto) || typeof proto.trigger !== 'function') return;
      patched.add(proto);
      proto.trigger = new Proxy(proto.trigger, {
        apply(target, thisArg, args) {
          const [ev, data] = args;
          if ((ev === 'hlsManifestLoaded' || ev === 'hlsManifestParsed') && data) {
            try { reportLevels(thisArg, data); } catch { /* observation only */ }
          }
          if ((ev === 'hlsLevelLoaded' || ev === 'hlsAudioTrackLoaded') && data && data.details) {
            try {
              const text = fromDetails(data.details);
              const key = data.details.url || (data.details.fragments[0] && data.details.fragments[0].url);
              if (text) report(key, 'hls', text, location.href);
            } catch { /* bỏ qua */ }
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    } catch { /* bỏ qua */ }
  }
  // Không định nghĩa window.Hls (trang hay dùng `'Hls' in window` để biết đã nạp thư viện chưa).
  // Thay vào đó: kiểm tra ngay sau mỗi <script> chạy xong (sự kiện load phát ngay sau khi script thực thi).
  const check = () => { try { if (typeof window.Hls === 'function') patchHls(window.Hls); } catch { /* bỏ qua */ } };
  check();
  document.addEventListener('load', (e) => { if (e.target && e.target.localName === 'script') check(); }, true);
  document.addEventListener('DOMContentLoaded', check, { once: true });
  addEventListener('load', check, { once: true });
})();
