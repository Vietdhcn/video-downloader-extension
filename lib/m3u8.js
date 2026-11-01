// Video Catcher – phân tích playlist HLS (.m3u8). Dùng chung cho service worker (importScripts) và trang quản lý tải.
(function (root) {
  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  function resolve(u, base) {
    try { return new URL(u, base).toString(); } catch { return u; }
  }

  // "1234@5678" -> { length: 1234, offset: 5678 }; offset bỏ trống = nối tiếp đoạn trước
  function parseByteRange(s, prevEnd) {
    const [len, off] = String(s).split('@');
    const length = Number(len);
    const offset = off !== undefined ? Number(off) : prevEnd || 0;
    return { offset, length };
  }

  function isWrapped(text) {
    return /^\s*#(?:ENC-AESGCM|EXT-X-B65)(?:[:;]|$)/im.test(String(text));
  }
  function parse(text, baseUrl) {
    text = String(text);
    if (isWrapped(text)) throw new Error(VCI18n.t('playlist_con_duoc_boc_1ipb'));
    const at = text.indexOf('#EXTM3U');
    if (at > 0 && at < 4096) text = text.slice(at); // bỏ phần rác/nguỵ trang phía trước
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith('#EXTM3U')) throw new Error(VCI18n.t('khong_phai_playlist_hls_1uyr'));

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const audios = [];
      const subtitles = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.startsWith('#EXT-X-STREAM-INF:')) {
          const a = parseAttrs(l.slice(18));
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (j >= lines.length) break;
          const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
          variants.push({
            url: resolve(lines[j], baseUrl),
            bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
            width: w || 0,
            height: h || 0,
            codecs: a.CODECS || '',
            audioGroup: a.AUDIO || '',
            fps: Number(a['FRAME-RATE']) || 0,
          });
          i = j;
        } else if (l.startsWith('#EXT-X-MEDIA:')) {
          const a = parseAttrs(l.slice(13));
          if (a.TYPE === 'AUDIO' && a.URI) {
            audios.push({ group: a['GROUP-ID'] || '', url: resolve(a.URI, baseUrl), name: a.NAME || a.LANGUAGE || '', isDefault: a.DEFAULT === 'YES' });
          }
          if (a.TYPE === 'SUBTITLES' && a.URI) subtitles.push({ url: resolve(a.URI, baseUrl), name: a.NAME || a.LANGUAGE || '' });
        }
      }
      // bỏ trùng (cùng URL)
      const seen = new Set();
      const uniq = variants.filter((v) => {
        const key = `${v.url}|${v.audioGroup}`;
        return seen.has(key) ? false : seen.add(key);
      });
      uniq.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
      return { type: 'master', variants: uniq, audios, subtitles };
    }

    if (!lines.some((line) => /^#EXT(?:INF:|-X-(?:TARGETDURATION|MEDIA-SEQUENCE|MAP):)/.test(line))) throw new Error(VCI18n.t('playlist_chua_co_thong_1nm0'));
    const segments = [];
    let map = null;
    let key = { method: 'NONE' };
    let pendingDuration = 0;
    let pendingRange = null;
    let lastEnd = 0;
    let endList = false;
    let hasDiscontinuity = false;
    let mediaSequence = 0;
    let targetDuration = 0;
    for (const l of lines) {
      if (l.startsWith('#EXTINF:')) pendingDuration = parseFloat(l.slice(8)) || 0;
      else if (l.startsWith('#EXT-X-BYTERANGE:')) pendingRange = l.slice(17);
      else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number(l.slice(22)) || 0;
      else if (l.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(l.slice(22)) || 0;
      else if (l.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(l.slice(11));
        key = { method: a.METHOD || 'NONE', uri: a.URI ? resolve(a.URI, baseUrl) : '', keyformat: (a.KEYFORMAT || 'identity').toLowerCase(), iv: a.IV || '' };
      } else if (l.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(l.slice(11));
        map = { url: resolve(a.URI, baseUrl), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      } else if (l.startsWith('#EXT-X-ENDLIST')) endList = true;
      else if (l.startsWith('#EXT-X-DISCONTINUITY')) hasDiscontinuity = true;
      else if (!l.startsWith('#')) {
        const seg = { url: resolve(l, baseUrl), duration: pendingDuration, range: null, keyMethod: key.method, seq: mediaSequence + segments.length, key: key.method === 'NONE' ? null : key };
        if (pendingRange) {
          seg.range = parseByteRange(pendingRange, lastEnd);
          lastEnd = seg.range.offset + seg.range.length;
        }
        segments.push(seg);
        pendingDuration = 0;
        pendingRange = null;
      }
    }
    const encrypted = segments.some((s) => s.keyMethod && s.keyMethod !== 'NONE');
    // AES-128 với khoá "identity" = mã hoá truyền tải thông thường (trình phát nào cũng nhận được khoá) -> giải mã được.
    // SAMPLE-AES hoặc keyformat khác (FairPlay, Widevine…) = DRM.
    const drm = segments.some((s) => s.key && (s.key.method !== 'AES-128' || s.key.keyformat !== 'identity'));
    const duration = segments.reduce((t, s) => t + s.duration, 0);
    return { type: 'media', segments, map, endList, encrypted, drm, keyMethod: key.method, duration, hasDiscontinuity, mediaSequence, targetDuration };
  }

  function qualityLabel(v) {
    const audioOnly = v.codecs && !/avc|hvc|hev|vp0?9|av01|mp4v/i.test(v.codecs) && /mp4a|ac-3|ec-3|opus/i.test(v.codecs);
    if (audioOnly) return VCI18n.t('chi_tieng_encz');
    if (v.height) return `${v.height}p${v.fps > 30 ? Math.round(v.fps) : ''}${v.height === 720 ? ' · HD' : v.height === 1080 ? ' · Full HD' : v.height === 1440 ? ' · QHD' : v.height === 2160 ? ' · 4K' : ''}`;
    // BANDWIDTH quá nhỏ (vd: 1) là giá trị giả của trang, không dùng làm nhãn
    if (v.bandwidth >= 50000) return v.bandwidth >= 1e6 ? `${(v.bandwidth / 1e6).toFixed(1)} Mbps` : `${Math.round(v.bandwidth / 1000)} kbps`;
    return 'MP4';
  }

  function qualityFromUrl(url) {
    const match = /(?:^|[/_.?&=\-])(144|240|360|480|540|576|720|1080|1440|2160|4320)p(?=$|[/_.?&=\-]|\d{2}(?:[/_.?&=\-]|$))/i.exec(url || '');
    return match ? Number(match[1]) : 0;
  }
  root.VCM3U8 = { parse, parseAttrs, qualityLabel, qualityFromUrl, isWrapped };
})(typeof self !== 'undefined' ? self : this);
