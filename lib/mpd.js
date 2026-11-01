// Video Catcher – đọc manifest DASH (.mpd). Không dùng DOMParser để chạy được trong service worker.
(function (root) {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] !== undefined ? ENT[e] : m;
  });
  const local = (n) => n.replace(/^.*:/, '');

  function parseXml(text) {
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) top.text += m[1];
      else if (m[2]) { if (stack.length > 1) stack.pop(); }
      else if (m[3]) {
        const node = { name: local(m[3]), attrs: {}, children: [], text: '' };
        const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let a;
        while ((a = ar.exec(m[4] || ''))) node.attrs[local(a[1])] = decode(a[2] !== undefined ? a[2] : a[3]);
        top.children.push(node);
        if (!m[5]) stack.push(node);
      } else if (m[6]) top.text += decode(m[6]);
    }
    return root;
  }
  const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
  const kid = (n, name) => kids(n, name)[0];

  // PT1H2M3.5S -> giây
  function isoDur(s) {
    if (!s) return 0;
    const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
    if (!m) return 0;
    const n = (i) => parseFloat(m[i] || 0);
    return n(1) * 31536000 + n(2) * 2592000 + n(3) * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
  }
  const resolve = (u, base) => { try { return new URL(u, base).toString(); } catch { return u; } };
  function range(s) {
    if (!s) return null;
    const [a, b] = s.split('-').map(Number);
    return { offset: a, length: b - a + 1 };
  }
  function fill(tpl, v) {
    return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$|\$\$/g, (m, k, w) => {
      if (!k) return '$';
      let val = String(v[k] !== undefined ? v[k] : '');
      if (w) val = val.padStart(Number(w), '0');
      return val;
    });
  }
  // Gộp thuộc tính SegmentTemplate/SegmentBase/SegmentList kế thừa từ các cấp cha
  function inherit(nodes, name) {
    let out = null;
    for (const n of nodes) {
      const s = kid(n, name);
      if (s) out = { attrs: { ...(out ? out.attrs : {}), ...s.attrs }, node: s, parent: out };
    }
    return out;
  }
  function baseUrl(nodes, mpdUrl) {
    let b = mpdUrl;
    for (const n of nodes) {
      const bu = kid(n, 'BaseURL');
      if (bu && bu.text.trim()) b = resolve(bu.text.trim(), b);
    }
    return b;
  }

  function segmentsFor(chain, rep, base, periodDur) {
    const vars = { RepresentationID: rep.attrs.id, Bandwidth: rep.attrs.bandwidth };
    const tpl = inherit(chain, 'SegmentTemplate');
    if (tpl) {
      const a = tpl.attrs;
      const timescale = Number(a.timescale || 1);
      const startNumber = Number(a.startNumber !== undefined ? a.startNumber : 1);
      const init = a.initialization ? { url: resolve(fill(a.initialization, vars), base), range: null } : null;
      const segs = [];
      // SegmentTimeline có thể nằm ở cấp cha
      let tl = null;
      for (let t = tpl; t && !tl; t = t.parent) tl = kid(t.node, 'SegmentTimeline');
      if (tl) {
        let time = 0;
        let num = startNumber;
        const S = kids(tl, 'S');
        S.forEach((s, i) => {
          if (s.attrs.t !== undefined) time = Number(s.attrs.t);
          const d = Number(s.attrs.d);
          let r = Number(s.attrs.r || 0);
          if (r < 0) {
            const next = S[i + 1] && S[i + 1].attrs.t !== undefined ? Number(S[i + 1].attrs.t) : (periodDur * timescale + Number(a.presentationTimeOffset || 0));
            r = Math.max(0, Math.ceil((next - time) / d) - 1);
          }
          for (let k = 0; k <= r; k++) {
            segs.push({ url: resolve(fill(a.media, { ...vars, Number: num, Time: time }), base), range: null, duration: d / timescale });
            time += d;
            num++;
          }
        });
      } else if (a.duration) {
        const d = Number(a.duration) / timescale;
        const count = Math.max(1, Math.ceil(periodDur / d - 1e-6));
        for (let k = 0; k < count; k++) {
          segs.push({ url: resolve(fill(a.media, { ...vars, Number: startNumber + k, Time: Math.round(k * d * timescale) }), base), range: null, duration: d });
        }
        // Số đoạn chỉ là ước tính: cho phép thiếu ở cuối (404) và dò thêm vài đoạn sau
        segs.forEach((sg, k) => { if (k >= 1) sg.tail = true; });
        const extra = [];
        for (let k = count; k < count + 3; k++) {
          extra.push({ url: resolve(fill(a.media, { ...vars, Number: startNumber + k, Time: Math.round(k * d * timescale) }), base), range: null, duration: d, tail: true, probe: true });
        }
        return { init, segments: segs, extra };
      }
      return { init, segments: segs };
    }
    const list = inherit(chain, 'SegmentList');
    if (list) {
      const n = list.node;
      const ini = kid(n, 'Initialization');
      const init = ini ? { url: ini.attrs.sourceURL ? resolve(ini.attrs.sourceURL, base) : base, range: range(ini.attrs.range) } : null;
      const timescale = Number(list.attrs.timescale || 1);
      const d = list.attrs.duration ? Number(list.attrs.duration) / timescale : 0;
      const segments = kids(n, 'SegmentURL').map((s) => ({ url: s.attrs.media ? resolve(s.attrs.media, base) : base, range: range(s.attrs.mediaRange), duration: d }));
      return { init, segments };
    }
    // SegmentBase hoặc chỉ có BaseURL: cả track là 1 file
    return { init: null, segments: [{ url: base, range: null, duration: periodDur, whole: true }] };
  }

  function parse(text, mpdUrl) {
    const doc = parseXml(text);
    const mpd = kid(doc, 'MPD');
    if (!mpd) throw new Error(VCI18n.t('khong_phai_manifest_dash_ukhh'));
    const live = mpd.attrs.type === 'dynamic';
    const total = isoDur(mpd.attrs.mediaPresentationDuration);
    const periods = kids(mpd, 'Period');
    let drm = false;
    const perPeriod = [];
    let acc = 0;
    periods.forEach((p, pi) => {
      const start = p.attrs.start ? isoDur(p.attrs.start) : acc;
      const next = periods[pi + 1] && periods[pi + 1].attrs.start ? isoDur(periods[pi + 1].attrs.start) : null;
      const dur = isoDur(p.attrs.duration) || (next !== null ? next - start : total - start) || total;
      acc = start + dur;
      const reps = { video: [], audio: [] };
      for (const as of kids(p, 'AdaptationSet')) {
        if (kids(as, 'ContentProtection').length) drm = true;
        for (const rep of kids(as, 'Representation')) {
          if (kids(rep, 'ContentProtection').length) drm = true;
          const mime = rep.attrs.mimeType || as.attrs.mimeType || '';
          const ctype = as.attrs.contentType || mime.split('/')[0];
          const kind = ctype === 'video' ? 'video' : ctype === 'audio' ? 'audio' : null;
          if (!kind) continue;
          const chain = [mpd, p, as, rep];
          const base = baseUrl(chain, mpdUrl);
          reps[kind].push({
            id: rep.attrs.id || '',
            bandwidth: Number(rep.attrs.bandwidth || 0),
            width: Number(rep.attrs.width || as.attrs.width || 0),
            height: Number(rep.attrs.height || as.attrs.height || 0),
            fps: (() => { const [n, d = 1] = String(rep.attrs.frameRate || as.attrs.frameRate || 0).split('/').map(Number); return d ? n / d : 0; })(),
            codecs: rep.attrs.codecs || as.attrs.codecs || '',
            mimeType: mime,
            lang: as.attrs.lang || '',
            ...segmentsFor(chain, rep, base, dur),
          });
        }
      }
      perPeriod.push({ duration: dur, ...reps });
    });
    const duration = total || perPeriod.reduce((t, p) => t + p.duration, 0);
    return { type: 'dash', live, drm, duration, periods: perPeriod };
  }

  const isMp4 = (r) => /mp4/.test(r.mimeType) || /^(avc|hev|hvc|av01|mp4a|ac-3|ec-3)/.test(r.codecs);
  // Danh sách chất lượng (dựa trên Period dài nhất)
  function variants(info) {
    const main = info.periods.slice().sort((a, b) => b.duration - a.duration)[0];
    if (!main) return [];
    const audio = bestAudio(main.audio);
    const vids = main.video.slice().sort((a, b) => (b.height - a.height) || (isMp4(b) - isMp4(a)) || (b.bandwidth - a.bandwidth));
    const out = [];
    const seen = new Set();
    for (const v of vids) {
      const key = v.id ? `${v.id}|${v.codecs}|${v.bandwidth}` : `${v.height}|${v.fps}|${v.codecs}|${v.bandwidth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bw = v.bandwidth + (audio ? audio.bandwidth : 0);
      const rate = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbps` : `${Math.round(b / 1000)} kbps`);
      out.push({
        label: `${v.height ? `${v.height}p${v.fps > 30 ? Math.round(v.fps) : ''}` : v.bandwidth >= 50000 ? rate(v.bandwidth) : 'MP4'}${v.height === 720 ? ' · HD' : v.height === 1080 ? ' · Full HD' : v.height === 1440 ? ' · QHD' : v.height === 2160 ? ' · 4K' : ''}${v.codecs ? ` · ${v.codecs.split('.')[0]}` : ''}${v.height && v.bandwidth >= 50000 ? ` · ${rate(v.bandwidth)}` : ''}${isMp4(v) ? '' : ' (WebM)'}`,
        height: v.height, bandwidth: v.bandwidth, videoId: v.id, audioId: audio ? audio.id : null,
        estSize: info.duration && v.bandwidth >= 50000 ? Math.round((bw / 8) * info.duration) : null,
      });
    }
    if (!vids.length && audio) out.push({ label: VCI18n.t('chi_tieng_encz'), height: 0, bandwidth: audio.bandwidth, videoId: null, audioId: audio.id, estSize: info.duration ? Math.round((audio.bandwidth / 8) * info.duration) : null });
    return out;
  }
  function bestAudio(list) {
    return list.slice().sort((a, b) => (isMp4(b) - isMp4(a)) || (b.bandwidth - a.bandwidth))[0] || null;
  }
  // Chọn representation tương ứng trong mỗi Period theo id, rồi theo độ phân giải/bitrate gần nhất
  function pick(list, id, height, bandwidth) {
    if (!list.length) return null;
    return list.find((r) => r.id === id)
      || list.slice().sort((a, b) => (Math.abs(a.height - height) - Math.abs(b.height - height)) || (Math.abs(a.bandwidth - bandwidth) - Math.abs(b.bandwidth - bandwidth)))[0];
  }

  root.VCMPD = { parse, variants, pick, bestAudio, isMp4, parseXml, isoDur };
})(typeof self !== 'undefined' ? self : this);
