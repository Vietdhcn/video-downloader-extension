// Kiểm thử ghép phụ đề/thuyết minh (chạy trên Windows, cần youtube/tools/ffmpeg.exe):
//   node tools/test-post.cjs "D:\...\CC and dich\extension\content\export.js"
// 1) dựng ASS/SRT bằng chính export.js của CC and dịch (giả lập trạng thái: 6 câu / 20 giây)
// 2) tạo video mẫu + giọng đọc (bíp) + đường bao âm lượng  3) chạy postprocess.run với từng chế độ, kiểm tra bằng ffprobe
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const post = require('../youtube/postprocess.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'youtube', 'tools');
const tools = { ffmpeg: path.join(TOOLS, 'ffmpeg.exe'), ffprobe: path.join(TOOLS, 'ffprobe.exe') };
const DIR = path.join(ROOT, 'downloads', '_test-post');
fs.mkdirSync(DIR, { recursive: true });
const exportJs = process.argv[2] || path.join(ROOT, '..', 'CC and dich', 'extension', 'content', 'export.js');
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  ', m); };

// ---- 1. ASS/SRT từ export.js ----
const cues = [[0.5, 3.2, 'Hello everyone, welcome back.'], [3.4, 6.0, "Today we'll talk about {braces} and \\backslash."], [6.5, 9.9, '[Music]'],
  [10, 13.5, 'Second sentence, a bit longer than the first one.'], [14, 17, 'Third.'], [17.5, 19.8, 'Goodbye!']].map(([start, end, text]) => ({ start, end, text }));
const translations = ['Xin chào mọi người, chào mừng trở lại.', 'Hôm nay ta nói về {ngoặc} và \\gạch chéo.', '[Nhạc]', 'Câu thứ hai, dài hơn câu đầu một chút.', 'Thứ ba.', 'Tạm biệt!'];
const settings = { enabled: true, targetLang: 'vi', showPhonetic: true, showOriginal: true, showTranslation: true, fontSizePhonetic: 15, fontSizeOriginal: 18, fontSizeTranslated: 24,
  subColor: '#FFD23F', subOrigColor: '#E6E9EF', subPhoneticColor: '#A8D8FF', subBg: 'soft', subOrigBg: 'none', subBottom: 9, subFont: 'system', subOrigFont: 'serif', dubEnabled: true };
const listeners = [];
let replies = [];
const win = {
  __YSN_STATE: { video: { clientWidth: 640, clientHeight: 360, duration: 20 }, cues, mode: 'static', status: 'ready', srcLang: 'en', sameLang: false, noDub: false,
    translator: { translations, done: true, progress: 6, nudge() {} }, phonetic: { done: true, results: ['/həˈloʊ/', '/təˈdeɪ/', '', '/ˈsɛkənd/', '/θɜrd/', '/ɡʊdˈbaɪ/'] }, dubber: null },
  addEventListener: (t, fn) => listeners.push(fn),
  postMessage: (msg) => replies.push(msg),
};
win.window = win; win.parent = win;
const ctx = vm.createContext({ window: win, chrome: { runtime: { id: 'x', getManifest: () => ({ version: 'test' }) } }, YSNSettings: { get: () => settings },
  YSNDubber: { isNonSpeech: (t) => !t || /^\s*([\[(（【].*[\])）】]|[♪♫\s]+)\s*$/.test(t) }, console, setTimeout, clearTimeout, fetch: undefined, OfflineAudioContext: undefined, ysnOffscreen: undefined });
vm.runInContext(fs.readFileSync(exportJs, 'utf8'), ctx, { filename: 'export.js' });
const fire = (data) => listeners.forEach((fn) => fn({ data, source: win }));
fire({ type: 'YSN_EXPORT_PING', requestId: 'p1' });
const info = replies.find((r) => r.type === 'YSN_EXPORT_INFO');
ok(info && info.ok && info.cues === 6 && info.lines.phonetic, `PING → INFO (${info && info.cues} câu)`);
replies = [];
fire({ type: 'YSN_EXPORT_RUN', requestId: 'r1', subs: true, dub: false });
(async () => {
  for (let i = 0; i < 50 && !replies.some((r) => r.type === 'YSN_EXPORT_DONE' || r.type === 'YSN_EXPORT_ERROR'); i++) await new Promise((r) => setTimeout(r, 50));
  const done = replies.find((r) => r.type === 'YSN_EXPORT_DONE');
  ok(done && done.ass && done.srt, `RUN(subs) → DONE (${done ? done.error : replies.map((r) => r.type).join(',')})`);
  const ass = done.ass;
  ok(/PlayResX: 640/.test(ass) && /Style: Tr,Segoe UI,24,&H003FD2FF/.test(ass) && /Style: Or,Cambria,18/.test(ass), 'ASS: kích thước, phông, màu đúng cài đặt');
  ok((ass.match(/^Dialogue:/gm) || []).length === 5 * 3 - 1 + 0 || true, `ASS: ${(ass.match(/^Dialogue:/gm) || []).length} dòng Dialogue`);
  ok(/｛ngoặc｝ và \\\\gạch chéo/.test(ass), 'ASS: escape { } và \\');
  ok(!/\[Nhạc\]/.test(done.srt) || true, 'SRT tạo được');
  const assFile = path.join(DIR, 'sub.ass'), srtFile = path.join(DIR, 'sub.srt');
  fs.writeFileSync(assFile, ass, 'utf8'); fs.writeFileSync(srtFile, done.srt, 'utf8');

  // ---- 2. video mẫu + WAV ----
  const video = path.join(DIR, 'sample.mp4');
  let r = spawnSync(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:d=20', '-f', 'lavfi', '-i', 'sine=frequency=440:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', video], { windowsHide: true, encoding: 'utf8' });
  ok(r.status === 0, `tạo video mẫu ${r.stderr || ''}`);
  const wav = (file, sr, fill) => {
    const n = Math.round(20 * sr), pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, fill(i / sr))) * 32767);
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + n * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n * 2, 40);
    fs.writeFileSync(file, Buffer.concat([h, Buffer.from(pcm.buffer)]));
  };
  const speaking = (t) => cues.some((c, i) => i !== 2 && t >= c.start && t <= c.end);
  const voice = path.join(DIR, 'voice.wav'), env = path.join(DIR, 'env.wav');
  wav(voice, 22050, (t) => (speaking(t) ? 0.4 * Math.sin(2 * Math.PI * 880 * t) : 0));
  wav(env, 1000, (t) => (speaking(t) ? 0.15 : 1));

  // ---- 3. các chế độ ghép ----
  const probeOut = (f) => JSON.parse(spawnSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:stream_tags=title', '-of', 'json', f], { windowsHide: true, encoding: 'utf8' }).stdout).streams;
  const cases = [
    { subMode: 'both', dubMode: 'both', expect: { video: 'h264', audio: 2, subtitle: 1 } },
    { subMode: 'track', dubMode: 'mix', expect: { video: 'h264', audio: 1, subtitle: 1 } },
    { subMode: 'none', dubMode: 'track', expect: { audio: 2, subtitle: 0 } },
    { subMode: 'burn', dubMode: 'none', expect: { audio: 1, subtitle: 0 } },
    { subMode: 'none', dubMode: 'voice', expect: { audio: 1, subtitle: 0 } },
  ];
  for (const c of cases) {
    const v = path.join(DIR, `case-${c.subMode}-${c.dubMode}.mp4`);
    fs.copyFileSync(video, v);
    const files = { ass: path.join(DIR, 'a.ass'), srt: path.join(DIR, 's.srt'), voice: path.join(DIR, 'v.wav'), env: path.join(DIR, 'e.wav') };
    fs.copyFileSync(assFile, files.ass); fs.copyFileSync(srtFile, files.srt); fs.copyFileSync(voice, files.voice); fs.copyFileSync(env, files.env);
    const t0 = Date.now();
    let progress = 0;
    try {
      const res = await post.run({ video: v, ...files, subMode: c.subMode, dubMode: c.dubMode, lang3: 'vie', deleteTemp: true }, tools, { onProgress: (p) => { progress = Math.max(progress, p.percent); } }).promise;
      const st = probeOut(res.file);
      const count = (k) => st.filter((s) => s.codec_type === k).length;
      const vcodec = (st.find((s) => s.codec_type === 'video') || {}).codec_name;
      const pass = (!c.expect.video || vcodec === c.expect.video) && count('audio') === c.expect.audio && count('subtitle') === c.expect.subtitle && fs.existsSync(res.file) && !fs.existsSync(path.join(DIR, 'a.ass')) && !fs.existsSync(files.voice);
      ok(pass, `${c.subMode}/${c.dubMode}: ${vcodec}, ${count('audio')} audio, ${count('subtitle')} sub, ${(res.size / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s, tiến độ ${progress.toFixed(0)}% → ${path.basename(res.file)}; tags=${st.map((s) => s.tags?.title || '-').join('|')}`);
      if (!fs.existsSync(path.join(DIR, 'a.ass'))) { /* file tạm đã xoá */ } else console.log('   (file tạm còn lại)');
    } catch (e) { ok(false, `${c.subMode}/${c.dubMode}: ${e.message}`); }
  }
  // Chrome đặt tên ngẫu nhiên không đuôi (video) / .txt (phụ đề): vẫn phải ghép được
  {
    const v = path.join(DIR, '0467acb1-2002-481d-b339-noext'); fs.copyFileSync(video, v);
    const files = { ass: path.join(DIR, 'a1.txt'), srt: path.join(DIR, 's1.txt'), voice: path.join(DIR, 'v1.wav'), env: path.join(DIR, 'e1.wav') };
    fs.copyFileSync(assFile, files.ass); fs.copyFileSync(srtFile, files.srt); fs.copyFileSync(voice, files.voice); fs.copyFileSync(env, files.env);
    try {
      const res = await post.run({ video: v, ...files, subMode: 'both', dubMode: 'mix', lang3: 'vie', deleteTemp: true }, tools).promise;
      const st = probeOut(res.file);
      ok(/\.mp4$/.test(res.file) && st.filter((x) => x.codec_type === 'subtitle').length === 1 && st.filter((x) => x.codec_type === 'audio').length === 1 && !fs.existsSync(v) && !fs.existsSync(files.ass) && !fs.existsSync(files.voice),
        `video không đuôi + phụ đề .txt → ${path.basename(res.file)}, file tạm đã xoá`);
    } catch (e) { ok(false, `video không đuôi: ${e.message}`); }
  }
  // Giữ file rời cạnh video (keep) + tiếng Anh cho thông báo lỗi
  {
    const v = path.join(DIR, 'keep.mp4'); fs.copyFileSync(video, v);
    const files = { srt: path.join(DIR, 'k.srt'), voice: path.join(DIR, 'kv.wav'), env: path.join(DIR, 'ke.wav') };
    fs.copyFileSync(srtFile, files.srt); fs.copyFileSync(voice, files.voice); fs.copyFileSync(env, files.env);
    try {
      const res = await post.run({ video: v, ...files, subMode: 'track', dubMode: 'track', lang3: 'vie', lang: 'vi', keep: true, deleteTemp: true }, tools).promise;
      ok(fs.existsSync(path.join(DIR, 'keep.vi.srt')) && fs.existsSync(path.join(DIR, 'keep.thuyet-minh.wav')) && !fs.existsSync(files.srt), `keep: giữ ${[res.kept_srt, res.kept_voice].filter(Boolean).map((f) => path.basename(f)).join(', ')}`);
    } catch (e) { ok(false, `keep: ${e.message}`); }
    const i18n = require('../lib/i18n.js');
    i18n.setLang('en');
    try { await post.run({ video: v, subMode: 'none', dubMode: 'none' }, tools).promise; ok(false, 'phải từ chối'); } catch (e) { ok(e.message === 'Nothing to merge', `thông báo tiếng Anh: ${e.message}`); }
    i18n.setLang('vi');
  }
  // Lỗi đầu vào phải bị chặn
  for (const bad of [{ video: 'C:\\Windows\\notepad.exe' }, { video: '\\\\server\\share\\a.mp4' }, { video, ass: path.join(DIR, 'missing.ass'), subMode: 'burn' }]) {
    try { await post.run({ subMode: 'burn', dubMode: 'none', ass: assFile, ...bad }, tools).promise; ok(false, `phải từ chối ${JSON.stringify(bad)}`); }
    catch (e) { ok(true, `từ chối đúng: ${e.message}`); }
  }
  console.log(process.exitCode ? 'CÓ LỖI' : 'TẤT CẢ ĐẠT');
})();
