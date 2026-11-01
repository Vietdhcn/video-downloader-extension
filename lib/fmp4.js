// Video Catcher – ghép nhiều luồng MP4 phân mảnh (fMP4) thành 1 file MP4 (vd: hình + tiếng của DASH/YouTube/HLS).
// Làm việc ở mức "box": gộp moov của các track, đánh lại track_ID, xếp xen kẽ các fragment theo thời gian.
// Dữ liệu lớn (mdat) giữ dạng Blob nên không tốn RAM.
(function (root) {
  const u32 = (b, o) => (b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const u64 = (b, o) => u32(b, o) * 0x100000000 + u32(b, o + 4);
  function w32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
  function w64(b, o, v) { w32(b, o, Math.floor(v / 0x100000000)); w32(b, o + 4, v % 0x100000000); }
  const typeAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  function children(b, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      let hdr = 8;
      const type = typeAt(b, o + 4);
      if (size === 1) { size = u64(b, o + 8); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type, start: o, end: o + size, body: o + hdr });
      o += size;
    }
    return out;
  }
  const kids = (b, box) => children(b, box.body, box.end);
  const child = (b, box, type) => kids(b, box).find((x) => x.type === type);
  function path(b, box, types) {
    let cur = box;
    for (const t of types) { cur = cur && child(b, cur, t); }
    return cur;
  }

  function makeBox(type, parts) {
    const len = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    w32(out, 0, len);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const slice = (b, box) => b.slice(box.start, box.end);

  // ---------- Một track đầu vào ----------
  class Track {
    constructor(label) {
      this.label = label || '';
      this.ftyp = null;
      this.moov = null;     // Uint8Array
      this.timescales = {}; // trackId -> timescale
      this.frags = [];      // { moof: Uint8Array, rest: Blob, time: number|NaN, idx }
      this.offset = 0;      // giây cộng thêm vào thời gian (nối nhiều Period của DASH)
    }

    shiftTfdt(moof) {
      const box = children(moof, 0, moof.length)[0];
      for (const traf of kids(moof, box).filter((x) => x.type === 'traf')) {
        const tfhd = child(moof, traf, 'tfhd');
        const tfdt = child(moof, traf, 'tfdt');
        if (!tfhd || !tfdt) continue;
        const ts = this.timescales[u32(moof, tfhd.body + 4)];
        if (!ts) continue;
        const add = Math.round(this.offset * ts);
        if (moof[tfdt.body] === 1) w64(moof, tfdt.body + 4, u64(moof, tfdt.body + 4) + add);
        else {
          const v = u32(moof, tfdt.body + 4) + add;
          if (v <= 0xffffffff) w32(moof, tfdt.body + 4, v);
        }
      }
    }

    // Đường nhanh: dữ liệu đã nằm trong RAM (đoạn vừa tải) -> tách box đồng bộ, không đọc Blob
    addBytes(b) {
      let o = 0;
      let cur = null;
      // Có bộ đệm đĩa (spool) -> phần mdat ghi xuống file tạm, RAM chỉ giữ moof nhỏ
      const flush = () => { if (cur) { cur.rest = this.spool ? this.spool.append(cur.restParts) : new Blob(cur.restParts); delete cur.restParts; this.frags.push(cur); cur = null; } };
      while (o + 8 <= b.length) {
        let size = u32(b, o);
        const type = typeAt(b, o + 4);
        if (size === 1) size = u64(b, o + 8);
        else if (size === 0) size = b.length - o;
        if (size < 8 || o + size > b.length) break;
        if (type === 'ftyp') { if (!this.ftyp) this.ftyp = b.slice(o, o + size); }
        else if (type === 'moov') { if (!this.moov) this.setMoov(b.slice(o, o + size)); }
        else if (type === 'moof') {
          flush();
          const moof = b.slice(o, o + size);
          if (this.offset) this.shiftTfdt(moof);
          cur = { moof, restParts: [], time: this.fragTime(moof), idx: this.frags.length };
        } else if (type === 'mdat' && cur) cur.restParts.push(b.subarray(o, o + size));
        o += size;
      }
      flush();
    }

    // Nạp dữ liệu (init, segment, hoặc cả file) – tách theo box top-level
    async add(data) {
      if (data instanceof Uint8Array) return this.addBytes(data);
      if (data instanceof ArrayBuffer) return this.addBytes(new Uint8Array(data));
      const blob = data instanceof Blob ? data : new Blob([data]);
      let o = 0;
      let cur = null; // fragment đang gom
      const flush = () => { if (cur) { cur.rest = new Blob(cur.restParts); delete cur.restParts; this.frags.push(cur); cur = null; } };
      while (o + 8 <= blob.size) {
        const h = new Uint8Array(await blob.slice(o, o + 16).arrayBuffer());
        let size = u32(h, 0);
        const type = typeAt(h, 4);
        if (size === 1) size = u64(h, 8);
        else if (size === 0) size = blob.size - o;
        if (size < 8 || o + size > blob.size) break; // cụt -> bỏ phần thừa
        if (type === 'ftyp' || type === 'moov') {
          const bytes = new Uint8Array(await blob.slice(o, o + size).arrayBuffer());
          if (type === 'ftyp') { if (!this.ftyp) this.ftyp = bytes; } else if (!this.moov) this.setMoov(bytes);
        } else if (type === 'moof') {
          flush();
          const moof = new Uint8Array(await blob.slice(o, o + size).arrayBuffer());
          if (this.offset) this.shiftTfdt(moof);
          cur = { moof, restParts: [], time: this.fragTime(moof), idx: this.frags.length };
        } else if (type === 'mdat' && cur) {
          cur.restParts.push(blob.slice(o, o + size));
        }
        // sidx, styp, emsg, free, mfra… bỏ qua
        o += size;
      }
      flush();
    }

    setMoov(bytes) {
      this.moov = bytes;
      const moov = children(bytes, 0, bytes.length)[0];
      for (const trak of kids(bytes, moov).filter((x) => x.type === 'trak')) {
        const tkhd = child(bytes, trak, 'tkhd');
        const mdhd = path(bytes, trak, ['mdia', 'mdhd']);
        if (!tkhd || !mdhd) continue;
        const id = u32(bytes, tkhd.body + (bytes[tkhd.body] === 1 ? 20 : 12));
        const ts = u32(bytes, mdhd.body + (bytes[mdhd.body] === 1 ? 20 : 12));
        this.timescales[id] = ts;
      }
      this.trexDur = {};
      const mvex = child(bytes, moov, 'mvex');
      if (mvex) for (const t of kids(bytes, mvex).filter((x) => x.type === 'trex')) this.trexDur[u32(bytes, t.body + 4)] = u32(bytes, t.body + 12);
    }

    // Thời điểm kết thúc của track (giây) tính từ dữ liệu thật
    endTime() {
      let end = 0;
      for (const f of this.frags) {
        const t = Number.isFinite(f.time) ? f.time : this.fragTime(f.moof);
        if (Number.isFinite(t)) end = Math.max(end, t + this.fragDur(f.moof));
      }
      return end;
    }

    // Thời lượng (giây) của 1 fragment: cộng sample_duration trong trun (hoặc mặc định từ tfhd/trex)
    fragDur(moof) {
      const box = children(moof, 0, moof.length)[0];
      const traf = child(moof, box, 'traf');
      if (!traf) return 0;
      const tfhd = child(moof, traf, 'tfhd');
      if (!tfhd) return 0;
      const id = u32(moof, tfhd.body + 4);
      const ts = this.timescales[id];
      if (!ts) return 0;
      const tf = u32(moof, tfhd.body) & 0xffffff;
      let o = tfhd.body + 8;
      if (tf & 0x1) o += 8;
      if (tf & 0x2) o += 4;
      let def = tf & 0x8 ? u32(moof, o) : (this.trexDur && this.trexDur[id]) || 0;
      let total = 0;
      for (const trun of kids(moof, traf).filter((x) => x.type === 'trun')) {
        const fl = u32(moof, trun.body) & 0xffffff;
        const n = u32(moof, trun.body + 4);
        let p = trun.body + 8;
        if (fl & 0x1) p += 4;
        if (fl & 0x4) p += 4;
        const per = ((fl & 0x100) ? 4 : 0) + ((fl & 0x200) ? 4 : 0) + ((fl & 0x400) ? 4 : 0) + ((fl & 0x800) ? 4 : 0);
        if (fl & 0x100) { for (let k = 0; k < n && p + 4 <= trun.end; k++, p += per) total += u32(moof, p); }
        else total += n * def;
      }
      return total / ts;
    }

    fragTime(moof) {
      const box = children(moof, 0, moof.length)[0];
      const traf = child(moof, box, 'traf');
      if (!traf) return NaN;
      const tfhd = child(moof, traf, 'tfhd');
      const tfdt = child(moof, traf, 'tfdt');
      if (!tfhd || !tfdt) return NaN;
      const id = u32(moof, tfhd.body + 4);
      const t = moof[tfdt.body] === 1 ? u64(moof, tfdt.body + 4) : u32(moof, tfdt.body + 4);
      const ts = this.timescales[id];
      return ts ? t / ts : NaN; // tính lại sau nếu init đến sau
    }
  }

  function mvhdTimescale(b, moov) {
    const mvhd = child(b, moov, 'mvhd');
    return mvhd ? u32(b, mvhd.body + (b[mvhd.body] === 1 ? 20 : 12)) : 1000;
  }
  // Ghi thời lượng vào tkhd (theo timescale của movie) và mdhd (theo timescale của track)
  function setTrakDuration(c, tk, tkhd, sec, movieTs) {
    const tv1 = c[tkhd.body] === 1;
    const td = Math.round(sec * movieTs);
    if (tv1) w64(c, tkhd.body + 28, td); else w32(c, tkhd.body + 20, Math.min(td, 0xfffffffe));
    const mdhd = path(c, tk, ['mdia', 'mdhd']);
    if (mdhd) {
      const mv1 = c[mdhd.body] === 1;
      const ts = u32(c, mdhd.body + (mv1 ? 20 : 12));
      const md = Math.round(sec * ts);
      if (mv1) w64(c, mdhd.body + 24, md); else w32(c, mdhd.body + 16, Math.min(md, 0xfffffffe));
    }
  }

  // ---------- Ghép ----------
  // tracks: Track[]; opts.duration (giây, tuỳ chọn)
  async function mux(tracks, opts = {}) {
    tracks = tracks.filter((t) => t.moov && t.frags.length);
    if (!tracks.length) throw new Error(VCI18n.t('khong_co_du_lieu_1deq'));
    // Thời lượng thật (nhiều bộ mux ghi 0xFFFFFFFF = "không rõ" -> trình phát hiện 13 tiếng)
    const real = Math.max(...tracks.map((t) => t.endTime()));
    const duration = real > 0 ? real : opts.duration || 0;

    // Đánh lại track_ID: 1, 2, 3…
    const movieTs = (() => { const b0 = tracks[0].moov; return mvhdTimescale(b0, children(b0, 0, b0.length)[0]); })();
    let nextId = 1;
    const maps = tracks.map(() => new Map());
    const traks = [];
    const trexs = [];
    let mvhd = null;
    tracks.forEach((t, i) => {
      const b = t.moov;
      const moov = children(b, 0, b.length)[0];
      if (!mvhd) mvhd = slice(b, child(b, moov, 'mvhd'));
      const mvex = child(b, moov, 'mvex');
      for (const trak of kids(b, moov).filter((x) => x.type === 'trak')) {
        const copy = slice(b, trak);
        const tk = children(copy, 0, copy.length)[0];
        const tkhd = child(copy, tk, 'tkhd');
        const off = tkhd.body + (copy[tkhd.body] === 1 ? 20 : 12);
        const oldId = u32(copy, off);
        const newId = nextId++;
        maps[i].set(oldId, newId);
        w32(copy, off, newId);
        setTrakDuration(copy, tk, tkhd, duration, movieTs);
        traks.push(copy);
        const trex = mvex && kids(b, mvex).find((x) => x.type === 'trex' && u32(b, x.body + 4) === oldId);
        if (trex) {
          const tc = slice(b, trex);
          w32(tc, 12, newId);
          trexs.push(tc);
        } else {
          // trex mặc định
          const tc = new Uint8Array(32);
          w32(tc, 0, 32); tc.set([116, 114, 101, 120], 4); w32(tc, 12, newId); w32(tc, 16, 1);
          trexs.push(tc);
        }
      }
    });

    // mvhd: next_track_ID + thời lượng
    const mv = mvhd.slice();
    const v1 = mv[8] === 1;
    w32(mv, mv.length - 4, nextId);
    const mvTs = u32(mv, v1 ? 28 : 20);
    const durUnits = duration ? Math.round(duration * mvTs) : 0;
    if (v1) w64(mv, 32, durUnits); else w32(mv, 24, Math.min(durUnits, 0xfffffffe));
    const mvexParts = [];
    if (durUnits) {
      const mehd = new Uint8Array(16);
      w32(mehd, 0, 16); mehd.set([109, 101, 104, 100], 4); w32(mehd, 12, Math.min(durUnits, 0xfffffffe));
      mvexParts.push(mehd);
    }
    const moov = makeBox('moov', [mv, ...traks, makeBox('mvex', [...mvexParts, ...trexs])]);
    const ftyp = (tracks.find((t) => t.ftyp) || {}).ftyp || makeBox('ftyp', [new Uint8Array([105, 115, 111, 53, 0, 0, 2, 0, 105, 115, 111, 53, 105, 115, 111, 54, 109, 112, 52, 49])]);

    // Gom fragment, đánh lại track_ID, xếp theo thời gian
    const all = [];
    tracks.forEach((t, i) => {
      const n = t.frags.length;
      t.frags.forEach((f, k) => {
        let time = f.time;
        if (!Number.isFinite(time)) time = t.fragTime(f.moof);
        if (!Number.isFinite(time)) time = opts.duration ? (k / n) * opts.duration : k;
        all.push({ t: i, f, time, k });
      });
    });
    all.sort((a, b) => (a.time - b.time) || (a.t - b.t) || (a.k - b.k));
    const parts = [ftyp, moov];
    let seq = 1;
    for (const { t, f } of all) {
      const m = f.moof.slice();
      const box = children(m, 0, m.length)[0];
      const mfhd = child(m, box, 'mfhd');
      if (mfhd) w32(m, mfhd.body + 4, seq++);
      for (const traf of kids(m, box).filter((x) => x.type === 'traf')) {
        const tfhd = child(m, traf, 'tfhd');
        if (!tfhd) continue;
        const old = u32(m, tfhd.body + 4);
        w32(m, tfhd.body + 4, maps[t].get(old) || old);
      }
      parts.push(m, f.rest && typeof f.rest.resolve === 'function' ? f.rest.resolve() : f.rest);
    }
    return new Blob(parts, { type: 'video/mp4' });
  }

  root.VCFMP4 = { Track, mux };
})(typeof self !== 'undefined' ? self : this);
