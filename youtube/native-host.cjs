// Native Messaging host. Tải YouTube (chỉ nhận URL video YouTube hợp lệ, chất lượng trong giới hạn) và ghép
// phụ đề / thuyết minh vào file đã tải bằng ffmpeg (postprocess.cjs: chỉ nhận đường dẫn file cục bộ, đuôi cho phép).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { normalize } = require('../lib/youtube.js');
const { locate } = require('./locate.cjs');
const postprocess = require('./postprocess.cjs');
const { t, setLang } = require('../lib/i18n.js');
const HOST = __dirname;
const TOOLS = path.join(HOST, 'tools');

function quality(value) {
  const height = Number(value);
  if (!Number.isInteger(height) || height < 144 || height > 4320) throw new Error(t('chat_luong_video_khong_haou'));
  return height;
}
function argsFor(action, url, height, outputDir) {
  const canonical = normalize(url);
  if (!canonical) throw new Error(t('chi_ho_tro_mot_dt5k'));
  const args = ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-playlist',
    '--no-warnings', '--no-colors', '--socket-timeout', '20', '--retries', '3',
    '--js-runtimes', `node:${process.execPath}`, '--ffmpeg-location', TOOLS];
  if (action === 'inspect') args.push('--dump-single-json', '--skip-download');
  else if (action === 'download') {
    const limit = quality(height);
    args.push('--no-simulate', '--windows-filenames', '--newline', '--progress',
      '--progress-delta', '0.5', '--progress-template', 'download:__VC_PROGRESS__%(progress)j',
      '--print', 'after_move:__VC_FILE__%(filepath)j', '--no-overwrites', '--no-mtime',
      '-P', outputDir, '-o', '%(title).140B [%(id)s].%(ext)s',
      // Ưu tiên file tải trực tiếp (https); luồng HLS (m3u8) chỉ dùng khi không còn lựa chọn khác
      '-f', `bv[ext=mp4][height<=${limit}][protocol^=http][protocol!*=dash]+ba[ext=m4a][protocol^=http][protocol!*=dash]/bv[ext=mp4][height<=${limit}]+ba[ext=m4a]/b[ext=mp4][height<=${limit}]`,
      '-S', `res:${limit},vcodec:h264,acodec:aac`, '--merge-output-format', 'mp4');
  } else throw new Error(t('lenh_khong_duoc_ho_1hba'));
  args.push('--', canonical);
  return args;
}
function summarize(info) {
  if (info.is_live || info.live_status === 'is_upcoming') throw new Error(t('trinh_tai_youtube_nay_18xv'));
  const heights = [...new Set((info.formats || []).filter((f) => !f.has_drm && f.ext === 'mp4' && f.vcodec && f.vcodec !== 'none' && f.height >= 144).map((f) => f.height))].sort((a, b) => b - a);
  if (!heights.length) throw new Error(t('khong_tim_thay_dinh_1ft2'));
  return { title: info.title, duration: info.duration, heights, id: info.id, options: heights.map((height) => estimate(info, height)) };
}
// Ước tính dung lượng theo đúng cách chọn của lệnh tải: '-f bv[ext=mp4][height<=H]+ba[ext=m4a]'
// với '-S res:H,vcodec:h264,acodec:aac' (ưu tiên H.264, rồi fps, rồi bitrate).
function estimate(info, height) {
  const duration = info.duration || 0;
  const sizeOf = (f) => f.filesize || f.filesize_approx || (f.tbr && duration ? Math.round(f.tbr * 125 * duration) : 0);
  const codecName = (v) => (/^avc/i.test(v) ? 'H.264' : /^av01/i.test(v) ? 'AV1' : /^vp0?9/i.test(v) ? 'VP9' : /^(hev|hvc)/i.test(v) ? 'H.265' : String(v || '').split('.')[0]);
  const formats = (info.formats || []).filter((f) => !f.has_drm);
  // Giống bộ chọn của lệnh tải: chỉ xét file tải trực tiếp nếu có (luồng HLS có bitrate/dung lượng rất khác)
  const direct = (f) => /^https?$/i.test(f.protocol || 'https');
  const prefer = (list) => (list.some(direct) ? list.filter(direct) : list);
  const video = prefer(formats.filter((f) => f.ext === 'mp4' && f.vcodec && f.vcodec !== 'none' && f.height === height))
    .sort((a, b) => (/^avc/i.test(b.vcodec) - /^avc/i.test(a.vcodec)) || ((b.fps || 0) - (a.fps || 0)) || ((b.tbr || 0) - (a.tbr || 0)))[0];
  const audio = video && video.acodec && video.acodec !== 'none' ? null
    : prefer(formats.filter((f) => f.ext === 'm4a' && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')))
      .sort((a, b) => (/^mp4a/i.test(b.acodec) - /^mp4a/i.test(a.acodec)) || ((b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)))[0];
  const v = video ? sizeOf(video) : 0;
  const a = audio ? sizeOf(audio) : 0;
  return { height, size: v && (a || !audio) ? v + a : 0, codec: video ? codecName(video.vcodec) : '', fps: video?.fps || 0 };
}
// Nhật ký ngắn để chẩn đoán kết nối (youtube/host.log, tối đa ~200 KB, không ghi URL có token)
function log(line) {
  try {
    const file = path.join(HOST, 'host.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 200000) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* nhật ký không bắt buộc */ }
}
function startHost() {
  log(`start pid=${process.pid} args=${JSON.stringify(process.argv.slice(2))}`);
  process.on('uncaughtException', (error) => { log(`crash ${error && error.stack}`); process.exit(1); });
  const configPath = path.join(HOST, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) : {};
  const outputDir = path.resolve(config.downloadDir || path.join(HOST, '..', 'downloads'));
  let input = Buffer.alloc(0), active = null, staging = null;
  const stageAbort = () => { try { postprocess.stageAbort(staging); } catch { /* bỏ qua */ } staging = null; };
  const send = (data) => {
    const body = Buffer.from(JSON.stringify(data));
    if (body.length > 1024 * 1024) return;
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([header, body]));
  };
  function kill() {
    if (active && active.cancel) { active.cancelled = true; active.cancel(); return; }   // tác vụ ghép (ffmpeg)
    if (!active || !active.child.pid || active.child.exitCode !== null) return;
    active.cancelled = true;
    if (process.platform === 'win32') {
      spawn('taskkill.exe', ['/PID', String(active.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else active.child.kill('SIGTERM');
  }
  function handle(message) {
    if (message && typeof message.lang === 'string') setLang(message.lang);
    log(`recv ${message && message.action}`);
    if (message.action === 'openFolder') {
      fs.mkdirSync(outputDir, { recursive: true });
      // Không dùng windowsHide: Explorer sẽ mở cửa sổ ở chế độ ẩn. Có file vừa tải (nằm trong thư mục
      // lưu, tồn tại) thì mở thư mục và chọn sẵn file đó như IDM.
      const file = typeof message.file === 'string' ? path.resolve(message.file) : '';
      const inside = file && !path.relative(outputDir, file).startsWith('..') && !path.isAbsolute(path.relative(outputDir, file)) && !/["\r\n]/.test(file) && fs.existsSync(file);
      const args = inside ? [`/select,"${file}"`] : [`"${outputDir}"`];
      log(`openFolder ${inside ? 'select' : 'dir'}`);
      spawn('explorer.exe', args, { stdio: 'ignore', shell: false, windowsVerbatimArguments: true, detached: true })
        .on('spawn', () => send({ type: 'folderOpened' }))
        .on('error', (error) => send({ type: 'error', error: error.message }));
      return;
    }
    if (message.action === 'reveal') {
      // File lưu vào thư mục tự chọn trong Trình tải: tìm đường dẫn thật rồi mở Explorer chọn sẵn file
      let file = null;
      try { file = locate({ folder: message.folder, files: message.files, hints: Array.isArray(message.hints) ? message.hints.slice(0, 20) : [] }); }
      catch (error) { send({ type: 'error', error: error.message }); return; }
      log(`reveal ${file ? 'found' : 'missing'}`);
      if (!file || /["\r\n]/.test(file)) { send({ type: 'error', error: t('khong_tim_thay_file_1if8', [message.folder]) }); return; }
      spawn('explorer.exe', [`/select,"${file}"`], { stdio: 'ignore', shell: false, windowsVerbatimArguments: true, detached: true })
        .on('spawn', () => send({ type: 'folderOpened', file }))
        .on('error', (error) => send({ type: 'error', error: error.message }));
      return;
    }
    if (message.action === 'cancel') { kill(); return; }
    if (message.action === 'stageBegin') {
      try { stageAbort(); staging = postprocess.stageBegin(message.jobId); send({ type: 'staging', dir: staging.dir }); }
      catch (error) { send({ type: 'error', error: error.message }); }
      return;
    }
    if (message.action === 'stageChunk') {
      try { const n = postprocess.stageChunk(staging, message.kind, message.data); send({ type: 'chunk', kind: message.kind, bytes: n }); }
      catch (error) { stageAbort(); send({ type: 'error', error: error.message }); }
      return;
    }
    if (message.action === 'stageEnd') {
      try { const files = postprocess.stageEnd(staging); staging = null; log(`staged ${Object.keys(files).join(',')}`); send({ type: 'staged', files }); }
      catch (error) { stageAbort(); send({ type: 'error', error: error.message }); }
      return;
    }
    if (message.action === 'postprocess') {
      // Ghép phụ đề/thuyết minh vào file đã tải (mọi nguồn). Tiến độ: progress{phase:'post', percent}; xong: done{file,size}
      if (active) { send({ type: 'error', error: t('dang_xu_ly_video_fr7x') }); return; }
      const tools = { ffmpeg: path.join(TOOLS, 'ffmpeg.exe'), ffprobe: path.join(TOOLS, 'ffprobe.exe') };
      if (!fs.existsSync(tools.ffmpeg) || !fs.existsSync(tools.ffprobe)) { send({ type: 'error', error: t('chay_setup_youtube_cmd_1eqh') }); return; }
      log(`postprocess sub=${message.subMode} dub=${message.dubMode}`);
      let last = 0;
      const task = postprocess.run(message, tools, { onProgress: (p) => { const now = Date.now(); if (now - last < 500) return; last = now; send({ type: 'progress', phase: 'post', ...p }); } });
      active = { child: null, cancelled: false, cancel: task.cancel };
      task.promise.then((r) => { active = null; log('postprocess done'); send({ type: 'done', ...r }); },
        (e) => { active = null; log(`postprocess ${e.cancelled ? 'cancelled' : 'error ' + String(e.message).slice(0, 300)}`); send(e.cancelled ? { type: 'cancelled' } : { type: 'error', error: e.message }); });
      return;
    }
    if (message.action === 'hello') { send({ type: 'ready', downloadDir: outputDir }); return; }
    if (active) { send({ type: 'error', error: t('dang_xu_ly_video_1gns') }); return; }
    try {
      const exe = path.join(TOOLS, 'yt-dlp.exe');
      if (!fs.existsSync(exe) || !fs.existsSync(path.join(TOOLS, 'ffmpeg.exe'))) throw new Error(t('chay_setup_youtube_cmd_zua2'));
      fs.mkdirSync(outputDir, { recursive: true });
      const args = argsFor(message.action, message.url, message.height, outputDir);
      const child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const job = active = { child, cancelled: false, output: '', error: '', file: null };
      let finished = false;
      const finish = (data) => {
        if (finished) return;
        finished = true;
        clearTimeout(job.timer);
        active = null;
        log(`send ${data.type}${data.error ? ` ${String(data.error).slice(0, 300)}` : ''}`);
        send(data);
      };
      if (message.action === 'inspect') {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          if (finished) return;
          job.output += chunk;
          if (job.output.length > 16e6) { kill(); finish({ type: 'error', error: t('thong_tin_video_vuot_e92a') }); }
        });
        job.timer = setTimeout(() => { kill(); finish({ type: 'error', error: t('youtube_phan_hoi_qua_vv9g') }); }, 90000);
      } else {
        const lines = readline.createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          try {
            if (line.startsWith('__VC_PROGRESS__')) {
              const progress = JSON.parse(line.slice(15));
              send({ type: 'progress', downloaded: progress.downloaded_bytes || 0,
                total: progress.total_bytes || progress.total_bytes_estimate || 0,
                speed: progress.speed || 0, eta: progress.eta, status: progress.status });
            } else if (line.startsWith('__VC_FILE__')) job.file = JSON.parse(line.slice(11));
          } catch { /* Ignore non-progress lines emitted by yt-dlp. */ }
        });
      }
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { job.error = (job.error + chunk).slice(-16000); });
      child.on('error', (error) => finish({ type: 'error', error: error.message }));
      child.on('close', (code) => {
        if (finished) return;
        if (job.cancelled) return finish({ type: 'cancelled' });
        if (code !== 0) return finish({ type: 'error', error: job.error.trim() || t('bo_tai_dung_voi_1587', [code]) });
        try {
          if (message.action === 'inspect') finish({ type: 'info', ...summarize(JSON.parse(job.output)), downloadDir: outputDir });
          else if (job.file && fs.existsSync(job.file)) finish({ type: 'done', file: job.file, size: fs.statSync(job.file).size });
          else finish({ type: 'error', error: t('chua_xac_nhan_duoc_1ixw') });
        } catch (error) { finish({ type: 'error', error: error.message }); }
      });
    } catch (error) { send({ type: 'error', error: error.message }); }
  }
  process.stdin.on('data', (chunk) => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4) {
      const length = input.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) { kill(); process.exit(1); }   // khúc file tạm tối đa ~6 MB base64
      if (input.length < length + 4) break;
      const body = input.subarray(4, length + 4);
      input = input.subarray(length + 4);
      try { handle(JSON.parse(body.toString('utf8'))); }
      catch { send({ type: 'error', error: t('thong_diep_khong_hop_qtuj') }); }
    }
  });
  process.stdin.on('end', () => { kill(); stageAbort(); process.exit(0); });   // mất kết nối giữa chừng: dọn file tạm dở
  process.stdout.on('error', () => { kill(); process.exit(0); });
}
if (require.main === module) startHost();
module.exports = { argsFor, quality, summarize, estimate };
