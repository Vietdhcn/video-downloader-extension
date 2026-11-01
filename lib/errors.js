// Video Catcher – phân loại lỗi của một mục tải thành nguyên nhân dễ hiểu + việc nên làm.
// Hàm thuần (không gọi API trình duyệt) để Trình tải hiển thị và để kiểm thử bằng Node.
(function (root) {
  const CASES = [
    // [mã, điều kiện(info) -> bool, tiêu đề, gợi ý, hành động]
    ['cancelled', (i) => i.name === 'AbortError', VCI18n.t('da_huy_12ms'), VCI18n.t('bam_thu_lai_thi9'), ['retry']],
    ['interrupted', (i) => /gián đoạn vì Trình tải đã đóng|Download Manager was closed/i.test(i.text), VCI18n.t('luot_tai_dung_khi_9enw'),
      VCI18n.t('bam_thu_lai_loi_p50m'), ['retry', 'openSource']],
    ['disk', (i) => i.name === 'QuotaExceededError' || /quota|không đủ dung lượng|disk full|no space|not enough free/i.test(i.text),
      VCI18n.t('o_dia_khong_du_1lvk'), VCI18n.t('can_trong_khoang_gap_1216'), ['retry']],
    ['permission', (i) => i.phase === 'save' && (i.name === 'NotAllowedError' || i.name === 'SecurityError' || /permission|quyền|write access/i.test(i.text)),
      VCI18n.t('khong_co_quyen_ghi_1lig'), VCI18n.t('cap_quyen_lai_hoac_14m3'), ['grant', 'downloads']],
    ['save', (i) => i.phase === 'save', VCI18n.t('tai_xong_nhung_chua_1xpp'),
      VCI18n.t('du_lieu_van_con_1gx8'), ['saveAgain', 'downloads']],
    ['drm', (i) => /DRM|ContentProtection|FairPlay|Widevine|SAMPLE-AES/i.test(i.text), VCI18n.t('video_duoc_bao_ve_1sek'),
      VCI18n.t('khong_tai_duoc_thu_1m5c'), ['openSource']],
    ['live-dash', (i) => /Livestream DASH/i.test(i.text), VCI18n.t('chua_ho_tro_tai_1r70'),
      VCI18n.t('dung_ghi_i2qe'), ['openSource']],
    ['in-page', (i) => /chỉ tồn tại trong trang|only exists inside the page/i.test(i.text), VCI18n.t('playlist_chi_co_trong_cb56'),
      VCI18n.t('mo_trang_nguon_phat_10mi'), ['openSource', 'retry']],
    ['helper', (i) => i.kind === 'youtube' && i.engine !== 'browser' && /bộ tải YouTube|YouTube helper|local helper|native messaging|setup-youtube|Specified native/i.test(i.text),
      VCI18n.t('bo_tai_youtube_tren_1gbt'), VCI18n.t('tai_trong_trinh_duyet_1ojz'), ['browser', 'retry']],
    ['capture-closed', (i) => /tab thu video .*đóng|capture tab was closed/i.test(i.text), VCI18n.t('tab_thu_youtube_da_5g7r'), VCI18n.t('bam_thu_lai_giu_19j5'), ['retry']],
    ['capture-stalled', (i) => /ngừng gửi dữ liệu|không phản hồi|chưa phát|Không bắt đầu thu|stopped sending data|not responding|is not playing|Capture could not start/i.test(i.text), VCI18n.t('youtube_chua_gui_du_m92b'),
      VCI18n.t('mo_video_tren_youtube_1um8'), ['retry', 'openSource']],
    ['youtube-bot', (i) => i.kind === 'youtube' && /confirm you.?re not a bot|Sign in to confirm|bot/i.test(i.text),
      VCI18n.t('youtube_yeu_cau_xac_1eve'), VCI18n.t('tai_trong_trinh_duyet_1tfd'), ['browser', 'retry']],
    ['youtube-unavailable', (i) => i.kind === 'youtube' && /unavailable|private|members-only|age|đăng nhập|xác minh tuổi|bị chặn|login|verification|blocked/i.test(i.text),
      VCI18n.t('video_youtube_khong_xem_1mrm'), VCI18n.t('video_rieng_tu_gioi_1kjm'), ['openSource', 'browser']],
    ['expired', (i) => [401, 403, 404, 410].includes(i.status), null, VCI18n.t('link_da_het_han_fhrg'), ['openSource', 'retry']],
    ['rate-limit', (i) => i.status === 429, VCI18n.t('may_chu_dang_gioi_9rbe'), VCI18n.t('tai_it_video_cung_17f7'), ['fewer', 'retry']],
    ['server', (i) => i.status >= 500, null, VCI18n.t('thu_lai_sau_it_6sgw'), ['retry']],
    ['expired-page', (i) => /link có thể đã hết hạn|link may have expired/i.test(i.text), VCI18n.t('may_chu_khong_con_139y'),
      VCI18n.t('link_da_het_han_fhrg'), ['openSource', 'retry']],
    ['timeout', (i) => /thời gian chờ|timed? ?out|quá lâu|within the timeout|took too long/i.test(i.text), VCI18n.t('may_chu_khong_gui_1oyl'),
      VCI18n.t('thu_lai_hoac_tai_146a'), ['retry', 'fewer']],
    ['range', (i) => /khoảng byte|chia luồng|thiếu byte|byte range|multi-connection|missing bytes/i.test(i.text), VCI18n.t('may_chu_tra_du_nzvs'),
      VCI18n.t('thu_lai_hoac_tai_1hki'), ['retry', 'chrome']],
    ['network', (i) => i.name === 'TypeError' || /Failed to fetch|NetworkError|network|ERR_/i.test(i.text), VCI18n.t('khong_ket_noi_duoc_sdn1'),
      VCI18n.t('kiem_tra_mang_roi_a5lv'), ['retry', 'openSource']],
    ['mux', (i) => i.mux || /MUX_FAILED|ghép|MP4 để ghép|could not mux|no MP4 data/i.test(i.text), VCI18n.t('khong_ghep_duoc_hinh_ckj3'),
      VCI18n.t('thu_lai_co_the_8b84'), ['retry']],
    ['parse', (i) => /playlist|manifest|luồng nào|không tìm thấy luồng|dữ liệu nào|segment list|no video\/audio streams|no data could be/i.test(i.text), VCI18n.t('khong_doc_duoc_danh_ymqy'),
      VCI18n.t('mo_trang_nguon_phat_1fg2'), ['openSource', 'retry']],
  ];
  function classify(error, ctx = {}) {
    const e = error || {};
    const text = String(e.message || e || '');
    const info = { name: e.name || '', text, status: Number(e.status) || Number((/HTTP (\d{3})/.exec(text) || [])[1]) || 0, mux: !!e.mux,
      phase: ctx.phase || e.phase || '', kind: ctx.kind || '', engine: ctx.engine || '' };
    const hit = CASES.find(([, when]) => when(info));
    const [code, , title, hint, actions] = hit || ['unknown', null, VCI18n.t('loi_chua_xac_dinh_1iwl'), VCI18n.t('bam_thu_lai_thi9'), ['retry']];
    let finalTitle = title;
    if (!finalTitle && code === 'expired') finalTitle = VCI18n.t('may_chu_tu_choi_er5q', [info.status]);
    if (!finalTitle && code === 'server') finalTitle = VCI18n.t('may_chu_nguon_loi_1u7c', [info.status]);
    let list = actions.slice();
    if (ctx.kind !== 'file') list = list.filter((a) => a !== 'chrome');
    if (ctx.kind !== 'youtube' || ctx.engine === 'browser') list = list.filter((a) => a !== 'browser');
    if (!ctx.hasOutputs) list = list.filter((a) => a !== 'saveAgain' && a !== 'downloads');
    if (!ctx.hasFolder) list = list.filter((a) => a !== 'grant');
    if (!ctx.canOpenSource) list = list.filter((a) => a !== 'openSource');
    return { code, title: finalTitle, hint, actions: list, detail: text };
  }
  const api = { classify };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VCErrors = api;
})(globalThis);
