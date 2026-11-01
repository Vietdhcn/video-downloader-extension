// Ghép phụ đề / thuyết minh vào file video đã tải bằng ffmpeg (thư mục tools). Dùng chung cho mọi nguồn:
// file do bộ tải YouTube lưu, file Chrome đã tải, hoặc file trong thư mục tự chọn (tìm bằng locate.cjs).
//   subMode: 'none' | 'burn' (in cứng, mã hoá lại hình) | 'track' (track phụ đề bật/tắt) | 'both'
//   dubMode: 'none' | 'mix' (trộn: giọng + tiếng gốc hạ theo đường bao) | 'track' (giữ tiếng gốc, thuyết minh là bản 2)
//            | 'voice' (chỉ giọng thuyết minh, bỏ tiếng gốc) | 'both' (bản 1 trộn, bản 2 tiếng gốc — bản cũ)
// Đầu vào: video + ass/srt (phụ đề) + voice.wav (giọng đọc) + env.wav (đường bao âm lượng tiếng gốc, 0..1).
// Kết quả ghi ra file tạm cạnh video, xong mới thay file gốc (lỗi giữa chừng thì file gốc còn nguyên).
const { t } = require('../lib/i18n.js');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const os = require('node:os');
const { locate } = require('./locate.cjs');

// ---------- Nhận file phụ đề/thuyết minh từ tiện ích theo khúc base64 (không qua Chrome Downloads → không hộp thoại) ----------
const TMP_ROOT = path.join(os.tmpdir(), 'VideoCatcher');
const STAGE_EXT = { ass: 'ass', srt: 'srt', voice: 'voice.wav', env: 'env.wav' };
const validJobId = (id) => typeof id === 'string' && /^[a-z0-9_]{3,40}$/i.test(id);
function stageBegin(jobId) {
  if (!validJobId(jobId)) throw new Error(t('ma_muc_tai_khong_uspi'));
  const dir = path.join(TMP_ROOT, jobId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return { dir, files: {}, bytes: 0 };
}
function stageChunk(session, kind, data) {
  if (!session) throw new Error(t('chua_bat_dau_nhan_73q9'));
  if (!STAGE_EXT[kind]) throw new Error(t('loai_file_khong_hop_1mur'));
  if (typeof data !== 'string' || data.length > 6 * 1024 * 1024) throw new Error(t('khuc_du_lieu_khong_1t9i'));
  const buf = Buffer.from(data, 'base64');
  session.bytes += buf.length;
  if (session.bytes > 4 * 1024 ** 3) throw new Error(t('du_lieu_qua_lon_1pg8'));
  const file = path.join(session.dir, `${kind}.${STAGE_EXT[kind]}`);
  fs.appendFileSync(file, buf);
  session.files[kind] = file;
  return buf.length;
}
function stageEnd(session) {
  if (!session) throw new Error(t('chua_bat_dau_nhan_73q9'));
  for (const f of Object.values(session.files)) if (!fs.statSync(f).size) throw new Error(t('file_rong_1chm', [path.basename(f)]));
  return { ...session.files };
}
function stageAbort(session) { if (session) fs.rmSync(session.dir, { recursive: true, force: true }); }

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts', '.m2ts']);
const MP4_EXT = new Set(['.mp4', '.m4v', '.mov']);
const localPath = (p) => typeof p === 'string' && p.length < 1024 && !/[\0\r\n"]/.test(p) && (process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : path.isAbsolute(p)) && !/^[\\/]{2}/.test(p);
// Không xét đuôi file: Chrome có lúc lưu blob với tên ngẫu nhiên không đuôi; nội dung được ffprobe/ffmpeg kiểm tra sau.
function checkFile(p, exts, what) {
  if (p == null || p === '') return null;
  if (!localPath(p)) throw new Error(t('duong_dan_khong_hop_1cxh', [what]));
  const abs = path.resolve(p);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(t('khong_thay_file_179m', [what, path.basename(abs)])); }
  if (!st.isFile()) throw new Error(t('khong_phai_la_file_1nel', [what]));
  return abs;
}
function resolveVideo(video) {
  if (typeof video === 'string') return checkFile(video, VIDEO_EXT, 'video');
  if (video && typeof video === 'object') {
    const found = locate({ folder: video.folder, files: video.files, hints: Array.isArray(video.hints) ? video.hints.slice(0, 20) : [] });
    if (!found) throw new Error(t('khong_tim_thay_file_2ztv', [video.folder]));
    return checkFile(found, VIDEO_EXT, 'video');
  }
  throw new Error(t('thieu_file_video_13er'));
}

function probe(ffprobe, file) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name', '-of', 'json', file], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(t('khong_doc_duoc_file_1lss', [(r.stderr || '').trim().slice(0, 200) || t('ffprobe_loi_1ymo')]));
  const info = JSON.parse(r.stdout || '{}');
  const streams = info.streams || [];
  return { duration: Number(info.format?.duration) || 0, hasAudio: streams.some((s) => s.codec_type === 'audio'), hasVideo: streams.some((s) => s.codec_type === 'video'),
    vcodec: (streams.find((s) => s.codec_type === 'video') || {}).codec_name || '', format: String(info.format?.format_name || '') };
}
let nvencOk = null;
function hasNvenc(ffmpeg) {
  if (nvencOk !== null) return nvencOk;
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { windowsHide: true, timeout: 20000 });
  nvencOk = r.status === 0;
  return nvencOk;
}

// Dựng lệnh ffmpeg. Trả về { args, output, finalExt, cleanup[] }.
function plan(opts, tools, probed) {
  const dir = path.dirname(opts.video), base = path.basename(opts.video, path.extname(opts.video));
  const inExt = path.extname(opts.video).toLowerCase();
  const subMode = ['none', 'burn', 'track', 'both'].includes(opts.subMode) ? opts.subMode : 'none';
  const dubMode = ['none', 'mix', 'track', 'voice', 'both'].includes(opts.dubMode) ? opts.dubMode : 'none';
  const burn = subMode === 'burn' || subMode === 'both', track = subMode === 'track' || subMode === 'both';
  const dub = dubMode !== 'none';
  if (!burn && !track && !dub) throw new Error(t('khong_co_gi_de_a6k3'));
  if (burn && !opts.ass) throw new Error(t('thieu_file_phu_de_fbrc'));
  if (track && !opts.srt && !opts.ass) throw new Error(t('thieu_file_phu_de_rkru'));
  if (dub && (!opts.voice || !opts.env)) throw new Error(t('thieu_file_thuyet_minh_1t9v'));
  // MP4 giữ MP4 (track phụ đề mov_text); định dạng khác ra MKV (chép nguyên codec, phụ đề SRT/ASS). Nhận dạng theo nội dung.
  const outExt = MP4_EXT.has(inExt) || /\b(mp4|mov)\b/.test(probed.format) ? '.mp4' : '.mkv';
  const tag = Math.random().toString(36).slice(2, 8);
  const output = path.join(dir, `${base}.vcpost-${tag}${outExt}`);
  const cleanup = [];
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', opts.video];
  const inputs = { video: 0 };
  let n = 1;
  if (dub) { args.push('-i', opts.voice); inputs.voice = n++; args.push('-i', opts.env); inputs.env = n++; }
  const subFile = opts.srt || opts.ass;
  if (track) { args.push('-f', opts.srt ? 'srt' : 'ass', '-i', subFile); inputs.sub = n++; }
  const fc = [];
  if (burn) {
    // Bộ lọc ass nhận tên file: chép vào cạnh video với tên đơn giản (cwd = thư mục video) để khỏi phải escape đường dẫn
    const assName = `vc_sub_${tag}.ass`;
    fs.copyFileSync(opts.ass, path.join(dir, assName));
    cleanup.push(path.join(dir, assName));
    fc.push(`[0:v]ass=${assName},format=yuv420p[vout]`);
  }
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  if (dub) {
    fc.push(`[${inputs.voice}:a]${fmt}[v]`);
    if (dubMode === 'mix' || dubMode === 'both') {
      if (probed.hasAudio) {
        fc.push(`[0:a]${fmt}[o]`, `[${inputs.env}:a]${fmt}[e]`, '[o][e]amultiply[duck]', '[duck][v]amix=inputs=2:duration=first:normalize=0[mix]');
      } else fc.push('[v]acopy[mix]');
    }
  }
  if (fc.length) args.push('-filter_complex', fc.join(';'));
  // Hình
  if (burn) {
    args.push('-map', '[vout]');
    if (hasNvenc(tools.ffmpeg)) args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '19', '-b:v', '0');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18');
  } else args.push('-map', '0:v:0', '-c:v', 'copy');
  // Tiếng
  let aIdx = 0;
  const aMeta = (title, lang) => { args.push(`-metadata:s:a:${aIdx}`, `title=${title}`, `-metadata:s:a:${aIdx}`, `language=${lang}`); aIdx++; };
  const lang3 = opts.lang3 || 'vie';
  if (!dub) { if (probed.hasAudio) args.push('-map', '0:a?', '-c:a', 'copy'); }
  else if (dubMode === 'mix') { args.push('-map', '[mix]'); aMeta(t('thuyet_minh_1cuq'), lang3); }
  else if (dubMode === 'voice') { args.push('-map', '[v]'); aMeta(t('thuyet_minh_1cuq'), lang3); }
  else if (dubMode === 'track') { if (probed.hasAudio) { args.push('-map', '0:a:0'); aMeta(t('tieng_goc_1y7m'), 'und'); } args.push('-map', '[v]'); aMeta(t('thuyet_minh_1cuq'), lang3); }
  else { args.push('-map', '[mix]'); aMeta(t('thuyet_minh_1cuq'), lang3); if (probed.hasAudio) { args.push('-map', '0:a:0'); aMeta(t('tieng_goc_1y7m'), 'und'); } }
  if (dub) args.push('-c:a', 'aac', '-b:a', '160k', '-disposition:a:0', 'default');
  // Phụ đề (track)
  if (track) {
    args.push('-map', `${inputs.sub}:s:0`, '-c:s', outExt === '.mp4' ? 'mov_text' : (path.extname(subFile).toLowerCase() === '.ass' ? 'ass' : 'srt'),
      '-metadata:s:s:0', `language=${lang3}`, '-metadata:s:s:0', t('title_song_ngu_1ize'));
  }
  if (outExt === '.mp4') args.push('-movflags', '+faststart');
  args.push(output);
  return { args, output, outExt, cleanup, burn, cwd: dir };
}

// Chạy: onProgress({percent, speed}), trả Promise<{file, size}>; handle.cancel() để huỷ.
function run(opts, tools, { onProgress } = {}) {
  let child = null, cancelled = false, finished = false;
  const promise = new Promise((resolve, reject) => {
    let video, probed, p;
    const staged = [];
    try {
      video = resolveVideo(opts.video);
      const ass = checkFile(opts.ass, new Set(['.ass']), t('phu_de_ass_10or'));
      const srt = checkFile(opts.srt, new Set(['.srt']), t('phu_de_srt_1k8d'));
      const voice = checkFile(opts.voice, new Set(['.wav']), t('giong_doc_1is6'));
      const env = checkFile(opts.env, new Set(['.wav']), t('duong_bao_am_luong_1vgf'));
      probed = probe(tools.ffprobe, video);
      if (!probed.hasVideo) throw new Error(t('file_khong_co_hinh_9y21'));
      // File tạm có thể mang tên ngẫu nhiên không đuôi → đặt lại cạnh video với đuôi đúng (chuyển nếu được xoá, sao chép nếu không)
      const tag = Math.random().toString(36).slice(2, 8), dir = path.dirname(video);
      const stage = (file, ext) => {
        if (!file) return null;
        const dest = path.join(dir, `vc_${tag}.${ext}`);
        if (opts.deleteTemp) { try { fs.renameSync(file, dest); } catch { fs.copyFileSync(file, dest); } } else fs.copyFileSync(file, dest);
        staged.push(dest);
        return dest;
      };
      const stagedBy = { ass: stage(ass, 'ass'), srt: stage(srt, 'srt'), voice: stage(voice, 'voice.wav'), env: stage(env, 'env.wav') };
      p = plan({ ...opts, video, ...stagedBy }, tools, probed);
      p.staged = stagedBy;
    } catch (error) { staged.forEach((f) => { try { fs.unlinkSync(f); } catch { /* bỏ qua */ } }); reject(error); return; }
    const temps = [...p.cleanup, ...staged, ...(opts.deleteTemp ? [opts.ass, opts.srt, opts.voice, opts.env].filter(Boolean) : [])];
    const rm = (f) => { try { fs.unlinkSync(f); } catch { /* không bắt buộc */ } };
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      p.cleanup.forEach(rm);
      if (error) { staged.forEach(rm); rm(p.output); reject(error); } else {
        // Giữ file rời cạnh video (theo cài đặt): phụ đề .srt/.ass và giọng thuyết minh .wav; đường bao âm lượng chỉ là file nội bộ
        if (opts.keep) {
          const base = path.join(path.dirname(video), path.basename(video, path.extname(video)));
          const lang = /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(String(opts.lang || '')) ? String(opts.lang).toLowerCase() : 'sub';
          const keepAs = { ass: `${base}.${lang}.ass`, srt: `${base}.${lang}.srt`, voice: `${base}.thuyet-minh.wav` };
          for (const [kind, dest] of Object.entries(keepAs)) {
            const src = p.staged[kind];
            if (!src || !fs.existsSync(src)) continue;
            try { fs.renameSync(src, dest); result[`kept_${kind}`] = dest; } catch { /* giữ không được thì xoá như thường */ }
          }
        }
        temps.forEach(rm);
        // Thư mục tạm (Downloads/Video Catcher/_tmp) rỗng thì xoá luôn
        for (const d of new Set(temps.map((f) => path.dirname(f)))) {
          const inTmp = path.resolve(d).toLowerCase().startsWith(path.resolve(TMP_ROOT).toLowerCase() + path.sep);
          if (inTmp || path.basename(d).toLowerCase() === '_tmp') { try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* không bắt buộc */ } }
        }
        resolve(result);
      }
    };
    let stderr = '';
    child = spawn(tools.ffmpeg, p.args, { cwd: p.cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-8000); });
    const lines = readline.createInterface({ input: child.stdout });
    let speed = 0;
    lines.on('line', (line) => {
      const [k, v] = line.split('=');
      if (k === 'speed') speed = parseFloat(v) || 0;
      else if ((k === 'out_time_us' || k === 'out_time_ms') && probed.duration > 0 && onProgress) {
        const sec = Number(v) / 1e6;
        onProgress({ percent: Math.max(0, Math.min(99, (sec / probed.duration) * 100)), speed, burn: p.burn });
      }
    });
    child.on('error', (e) => done(e));
    child.on('close', (code) => {
      if (cancelled) return done(Object.assign(new Error(t('da_huy_12ms')), { cancelled: true }));
      if (code !== 0) return done(new Error(stderr.trim().split('\n').pop() || t('ffmpeg_dung_voi_ma_1k6q', [code])));
      try {
        const size = fs.statSync(p.output).size;
        if (size < 1024) throw new Error(t('file_ghep_rong_rnat'));
        // Thay file gốc: đổi đuôi nếu đổi định dạng (webm → mkv)
        const finalPath = path.join(path.dirname(video), `${path.basename(video, path.extname(video))}${p.outExt}`);
        fs.unlinkSync(video);
        fs.renameSync(p.output, finalPath);
        done(null, { file: finalPath, size, burn: p.burn, replacedExt: p.outExt !== path.extname(video).toLowerCase() });
      } catch (error) { done(error); }
    });
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      if (!child || child.exitCode !== null) return;
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else child.kill('SIGTERM');
    },
  };
}

module.exports = { run, plan, probe, resolveVideo, checkFile, stageBegin, stageChunk, stageEnd, stageAbort, TMP_ROOT };
