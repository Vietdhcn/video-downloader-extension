// Video Catcher – trang Chẩn đoán: tóm tắt dễ đọc (✓/⚠/✗ + việc nên làm), chi tiết JSON để báo lỗi.
(function (root) {
  const YT = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
  const isWeb = (url) => /^https?:/i.test(url || '');

  // data: phản hồi vc:diagnostics (+ manifests đã phân tích); frames: phản hồi vc:list từng khung
  function summarize(page, data, frames) {
    const checks = [];
    const add = (level, what, todo = '') => checks.push({ level, what, todo });
    let host = '';
    try { host = new URL(page).hostname; } catch { /* bỏ qua */ }
    if (YT.test(host)) add('info', VCI18n.t('day_la_trang_youtube_rukr'), VCI18n.t('dung_nut_tren_trinh_1jy3'));

    const webFrames = frames.filter((f) => isWeb(f.url));
    const answered = webFrames.filter((f) => !f.error);
    const silent = webFrames.filter((f) => f.error);
    const stale = answered.filter((f) => f.extensionVersion && f.extensionVersion !== data.version);
    if (!answered.length) add('bad', VCI18n.t('tien_ich_chua_chay_81w6'), VCI18n.t('tai_lai_trang_f5_u72c'));
    else if (stale.length) add('warn', VCI18n.t('trang_dang_chay_ban_9acb', [stale[0].extensionVersion]), VCI18n.t('tai_lai_trang_f5_1wi0'));
    else add('ok', VCI18n.t('tien_ich_dang_chay_1a6l', [answered.length]));
    if (answered.length && silent.length) add('info', VCI18n.t('khung_khac_khong_phan_tbhu', [silent.length]), VCI18n.t('thuong_la_quang_cao_ekri'));

    const videos = answered.flatMap((f) => f.videos || []);
    const playing = videos.filter((v) => v.playing);
    if (!videos.length) add('warn', VCI18n.t('chua_thay_video_nao_qzdd'), VCI18n.t('phat_video_chinh_roi_18hb'));
    else add('ok', VCI18n.t('thay_video_1ba3', [videos.length, playing.length ? VCI18n.t('dang_phat_772y', [playing.length]) : '']));

    const manifests = data.manifests || [];
    const usable = manifests.filter((m) => m.parsed && !m.parsed.error && (m.parsed.type === 'master' ? m.parsed.variants?.length : m.parsed.segments));
    const wrapped = manifests.filter((m) => m.parsed?.error && /bọc mã hóa|wrapped/i.test(m.parsed.error));
    const drm = manifests.filter((m) => m.parsed?.drm);
    const files = (data.media || []).filter((m) => m.kind === 'file');
    if (usable.length) {
      // Một playlist tổng và các mức chất lượng của nó là một luồng (ISSUE-005); bỏ trùng link khác nhau ở tham số
      const bare = (u) => String(u || '').split('#')[0].split('?')[0];
      // Playlist tổng trùng (vd bản "hls-levels:" do hls.js công bố) có cùng các mức: chỉ tính một lần
      const masters = [...new Map(usable.filter((m) => m.parsed.type === 'master')
        .map((m) => [(m.parsed.variants || []).map((v) => bare(v.url)).sort().join('|') || m.key, m])).values()];
      const children = new Set(masters.flatMap((m) => (m.parsed.variants || []).map((v) => bare(v.url))));
      const standalone = [...new Map(usable.filter((m) => m.parsed.type !== 'master' && !children.has(bare(m.key))).map((m) => [bare(m.key) || Math.random(), m])).values()];
      const streams = masters.length + standalone.length;
      const qualities = masters.reduce((n, m) => n + (m.parsed.variants || []).length, 0) + standalone.length;
      const longest = Math.max(0, ...usable.map((m) => m.parsed.duration || 0));
      const extra = [qualities > streams ? VCI18n.t('chat_luong_mprq', [qualities]) : '', longest ? VCI18n.t('dai_nhat_1k63', [fmt(longest)]) : ''].filter(Boolean).join(', ');
      add('ok', VCI18n.t('bat_duoc_luong_co_14t4', [streams, extra ? ` (${extra})` : '']), VCI18n.t('mo_menu_tai_va_114o'));
    }
    if (wrapped.length && !usable.length) add('warn', VCI18n.t('playlist_dang_duoc_trinh_1hul'), VCI18n.t('cho_video_chay_them_yuoe'));
    if (drm.length) add('bad', VCI18n.t('video_dung_drm_bao_126a'), VCI18n.t('khong_tai_duoc_thu_1m5c'));
    if (files.length) add('ok', VCI18n.t('bat_duoc_file_media_1l3l', [files.length]), VCI18n.t('file_nho_thuong_la_9ir2'));
    if (!usable.length && !files.length && !wrapped.length && !drm.length && !YT.test(host)) {
      add('warn', VCI18n.t('chua_bat_duoc_nguon_z3m3'), VCI18n.t('phat_video_chinh_het_1xk7'));
    }
    return checks;
  }
  function fmt(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }
  root.VCDiagnostics = { summarize };
  if (typeof module === 'object' && module.exports) { module.exports = { summarize }; return; }

  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const output = $('report');
  const refresh = $('refresh');
  const copy = $('copy');
  const ICON = { ok: '✓', warn: '!', bad: '✕', info: 'i' };

  async function update() {
    refresh.disabled = true;
    copy.disabled = true;
    status.textContent = VCI18n.t('dang_kiem_tra_1va4');
    try {
      const params = new URLSearchParams(location.search);
      let rawTabId = params.get('tabId');
      if (rawTabId === null && params.get('source')) {
        const source = new URL(params.get('source'));
        if (!/^https?:$/.test(source.protocol)) throw new Error(VCI18n.t('nguon_trang_khong_hop_kyqf'));
        const tabs = await chrome.tabs.query({ url: `${source.origin}/*` });
        const match = tabs.find((tab) => new URL(tab.url).pathname === source.pathname);
        if (match) rawTabId = String(match.id);
      }
      if (rawTabId === null || !/^\d+$/.test(rawTabId)) throw new Error(VCI18n.t('mo_chan_doan_tu_1nwr'));
      const tabId = Number(rawTabId);
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch { throw new Error(VCI18n.t('tab_video_da_dong_1p8t')); }
      const data = await chrome.runtime.sendMessage({ type: 'vc:diagnostics', tabId });
      if (data.error) throw new Error(data.error);
      data.manifests = await Promise.all(data.manifests.map(async (manifest) => {
        const captured = await chrome.runtime.sendMessage({ type: 'vc:manifestText', tabId, url: manifest.key });
        let parsed;
        try {
          if (manifest.kind === 'hls' && captured.text) {
            const playlist = VCM3U8.parse(captured.text, captured.base || manifest.base);
            parsed = { type: playlist.type, duration: playlist.duration, endList: playlist.endList, drm: playlist.drm,
              segments: playlist.segments?.length, variants: playlist.variants,
              firstSegment: playlist.segments?.[0], lastSegment: playlist.segments?.at(-1) };
          }
        } catch (error) { parsed = { error: error.message }; }
        return { ...manifest, parsed, preview: captured.text?.slice(0, 1800) };
      }));
      if (params.get('probe') === '1') {
        data.sources = await chrome.runtime.sendMessage({ type: 'vc:sources', tabId, referer: tab.url });
        data.probes = await Promise.all(data.manifests.filter((manifest) => manifest.parsed?.type === 'media' && manifest.parsed.endList).slice(0, 2).map(async (manifest) => ({
          playlist: manifest.key,
          ...(await chrome.runtime.sendMessage({ type: 'vc:probeSource', tabId, url: manifest.key })),
        })));
      }
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const videoFrames = await Promise.all((frames || []).map(async (frame) => {
        try {
          const state = await chrome.tabs.sendMessage(tabId, { type: 'vc:list' }, { frameId: frame.frameId });
          return { frameId: frame.frameId, url: frame.url, ...state };
        } catch {
          return { frameId: frame.frameId, url: frame.url, error: VCI18n.t('khong_phan_hoi_1jbl') };
        }
      }));

      // Tên file sẽ đặt (vd Udemy: "Tên khoá - 12. Tên bài") và cách tiện ích tìm ra nó
      data.naming = await Promise.race([chrome.tabs.sendMessage(tabId, { type: 'vc:videoTitle', probe: true }, { frameId: 0 }),
        new Promise((res) => setTimeout(() => res(null), 8000))]).catch(() => null);

      const pageBox = $('page');
      pageBox.hidden = false;
      let host = '';
      try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch { /* bỏ qua */ }
      const tx = document.createElement('div');
      tx.className = 'tx';
      tx.append(Object.assign(document.createElement('b'), { textContent: tab.title || 'Tab video', title: tab.title || '' }),
        Object.assign(document.createElement('small'), { textContent: host || tab.url, title: tab.url }));
      pageBox.replaceChildren(Object.assign(document.createElement('span'), { className: 'av', textContent: (host || '?').charAt(0).toUpperCase() }), tx);
      const checks = summarize(tab.url, data, videoFrames);
      const naming = data.naming;
      if (!naming || !naming.title) checks.push({ level: 'warn', what: VCI18n.t('chua_doc_duoc_ten_4rze'), todo: VCI18n.t('tai_lai_trang_f5_19pm') });
      else if (naming.trace && naming.trace.udemy && ![VCI18n.t('danh_sach_bai_1lle'), 'API Udemy'].includes(naming.trace.source)) {
        checks.push({ level: 'warn', what: VCI18n.t('ten_file_1pq1', [naming.title]), todo: VCI18n.t('chua_tim_duoc_ten_13wi', [naming.trace.source]) });
      } else checks.push({ level: 'ok', what: VCI18n.t('ten_file_1pq1', [naming.title]), todo: naming.trace?.source ? VCI18n.t('lay_tu_1c5v', [naming.trace.source]) : '' });
      const NAME = { ok: VCI18n.t('on_8og2'), warn: VCI18n.t('can_lam_1k0l'), bad: VCI18n.t('loi_nqa6'), info: VCI18n.t('luu_y_1vhm') };
      $('tally').replaceChildren(...['ok', 'warn', 'bad', 'info'].map((lv) => [lv, checks.filter((c) => c.level === lv).length])
        .filter(([, n]) => n).map(([lv, n]) => Object.assign(document.createElement('span'), { className: lv, textContent: `${ICON[lv]} ${n} ${NAME[lv]}` })));
      $('checks').hidden = false;
      $('checks').replaceChildren(...checks.map((c) => {
        const li = document.createElement('li');
        li.className = c.level;
        li.append(Object.assign(document.createElement('span'), { className: 'icon', textContent: ICON[c.level] }),
          Object.assign(document.createElement('span'), { className: 'what', textContent: c.what }));
        if (c.todo) li.append(Object.assign(document.createElement('span'), { className: 'todo', textContent: c.todo }));
        return li;
      }));

      // Chi tiết: bỏ các khung không phải trang web (about:blank…) vì không liên quan tới video
      const shownFrames = videoFrames.filter((f) => /^https?:/i.test(f.url || '') || (f.videos && f.videos.length));
      const report = params.get('probe') === '1' ? {
        page: tab.url, version: data.version,
        streams: (data.sources?.streams || []).map((stream) => ({
          kind: stream.kind, name: stream.name, duration: stream.duration, live: stream.live, error: stream.error,
          qualities: (stream.variants || []).map((variant) => ({ label: variant.label, ready: !variant.needsPlayback, estSize: variant.estSize })),
        })),
        probes: (data.probes || []).map((probe) => ({ status: probe.status, bytesRead: probe.bytesRead, contentType: probe.contentType, error: probe.error })),
        naming: data.naming,
      } : { page: tab.url, summary: checks.map((c) => `${ICON[c.level]} ${c.what}`), ...data, frames: shownFrames };
      output.textContent = JSON.stringify(report, null, 2);
      $('details').hidden = false;
      status.textContent = `${new Date().toLocaleTimeString('vi-VN')} · Video Catcher ${data.version}`;
      copy.disabled = false;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', update);
  VCI18n.onChange(update);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.textContent);
      status.textContent = VCI18n.t('da_sao_chep_9yir');
    } catch {
      $('details').open = true;
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(output);
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = VCI18n.t('bam_ctrl_c_de_6loa');
    }
  });
  VCI18n.init().then(update);
})(globalThis);
