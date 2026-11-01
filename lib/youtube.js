(function (root) {
  function normalize(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      const host = url.hostname.toLowerCase();
      let id;
      if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
      else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
        if (url.pathname === '/watch') id = url.searchParams.get('v');
        else id = /^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1];
      }
      return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : null;
    } catch { return null; }
  }
  // Lấy JSON ytInitialPlayerResponse từ HTML trang watch (đếm ngoặc, bỏ qua ngoặc trong chuỗi)
  function extractPlayerResponse(html) {
    const at = String(html || '').search(/ytInitialPlayerResponse\s*=\s*\{/);
    if (at < 0) return null;
    const start = html.indexOf('{', at);
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length && i - start < 8e6; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }
  // Chế độ tải trong trình duyệt: chỉ H.264 + AAC (fMP4), tối đa 1080p. Dung lượng = hình + tiếng.
  function browserOptions(playerResponse, maxHeight = 1080) {
    const formats = playerResponse?.streamingData?.adaptiveFormats || [];
    const duration = Number(playerResponse?.videoDetails?.lengthSeconds) || 0;
    const sizeOf = (f) => Number(f.contentLength) || (f.bitrate && duration ? Math.round((f.bitrate / 8) * duration) : 0);
    const audio = formats.filter((f) => /^audio\/mp4/i.test(f.mimeType || '') && /mp4a/i.test(f.mimeType || ''))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    const audioSize = audio ? sizeOf(audio) : 0;
    const best = new Map();
    for (const f of formats) {
      if (!/^video\/mp4/i.test(f.mimeType || '') || !/avc1/i.test(f.mimeType || '')) continue;
      const height = parseInt(f.qualityLabel, 10) || Math.min(f.height || 0, f.width || f.height || 0);
      if (!height || height > maxHeight) continue;
      const size = sizeOf(f);
      const cur = best.get(height);
      if (!cur || (f.bitrate || 0) > cur.bitrate) best.set(height, { height, bitrate: f.bitrate || 0, fps: f.fps || 0, size: size && audioSize ? size + audioSize : size || 0 });
    }
    const options = [...best.values()].sort((a, b) => b.height - a.height)
      .map(({ height, fps, size }) => ({ height, fps, size, codec: 'H.264' }));
    return {
      title: playerResponse?.videoDetails?.title || '',
      duration,
      playable: playerResponse?.playabilityStatus?.status || '',
      options,
    };
  }
  // Bộ tải trên máy (yt-dlp): mọi mức chất lượng có bản MP4 (H.264, AV1…), chọn như lệnh tải của helper
  // ('-f bv[ext=mp4][height<=H]+ba[ext=m4a]', '-S res:H,vcodec:h264,acodec:aac': ưu tiên H.264, rồi fps, rồi bitrate).
  function downloaderOptions(playerResponse) {
    const formats = playerResponse?.streamingData?.adaptiveFormats || [];
    const duration = Number(playerResponse?.videoDetails?.lengthSeconds) || 0;
    const sizeOf = (f) => Number(f.contentLength) || (f.bitrate && duration ? Math.round((f.bitrate / 8) * duration) : 0);
    const codecOf = (mime) => { const c = (/codecs="([^".]+)/i.exec(mime) || [])[1] || ''; return /^avc/i.test(c) ? 'H.264' : /^av01/i.test(c) ? 'AV1' : /^vp0?9/i.test(c) ? 'VP9' : /^(hev|hvc)/i.test(c) ? 'H.265' : c; };
    const audio = formats.filter((f) => /^audio\/mp4/i.test(f.mimeType || '')).sort((a, b) => (/mp4a/i.test(b.mimeType) - /mp4a/i.test(a.mimeType)) || ((b.bitrate || 0) - (a.bitrate || 0)))[0];
    const audioSize = audio ? sizeOf(audio) : 0;
    const best = new Map();
    for (const f of formats) {
      if (!/^video\/mp4/i.test(f.mimeType || '')) continue;
      const height = parseInt(f.qualityLabel, 10) || f.height || 0;
      if (!height) continue;
      const rank = [/avc1/i.test(f.mimeType) ? 1 : 0, f.fps || 0, f.bitrate || 0];
      const cur = best.get(height);
      if (!cur || rank[0] > cur.rank[0] || (rank[0] === cur.rank[0] && (rank[1] > cur.rank[1] || (rank[1] === cur.rank[1] && rank[2] > cur.rank[2])))) {
        const size = sizeOf(f);
        best.set(height, { rank, option: { height, fps: f.fps || 0, codec: codecOf(f.mimeType), size: size ? size + audioSize : 0 } });
      }
    }
    return [...best.values()].map((x) => x.option).sort((a, b) => b.height - a.height);
  }
  const api = { normalize, extractPlayerResponse, browserOptions, downloaderOptions };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VCYouTube = api;
})(globalThis);
