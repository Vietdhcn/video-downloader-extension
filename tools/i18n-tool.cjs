// Công cụ song ngữ giao diện Video Catcher.
//   node tools/i18n-tool.cjs extract   → tools/i18n/strings.json (khoá, tiếng Việt, nơi dùng) — để dịch sang tools/i18n/en.json
//   node tools/i18n-tool.cjs apply     → thay chuỗi trong mã bằng VCI18n.t('khoá') / t('khoá') (bộ tải trên máy) / chuỗi tiếng Anh
//                                        (script chạy trong MAIN world), thêm data-i18n vào HTML, sinh lib/locales/{en,vi}.js
// Chuỗi tiếng Việt = chuỗi có dấu. Chuỗi không dấu (vd "Xong") được liệt kê trong tools/i18n/extra.json để xử lý tay.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'i18n');
const VN = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđĐÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ]/;
// mode: ext = VCI18n.t ; host = t (require ../lib/i18n.js) ; main = chuỗi tiếng Anh thẳng (MAIN world, không có chrome.storage)
const JS_FILES = [
  ['content.js', 'ext'], ['popup.js', 'ext'], ['manager.js', 'ext'], ['diagnostics.js', 'ext'], ['background.js', 'ext'],
  ['lib/errors.js', 'ext'], ['lib/m3u8.js', 'ext'], ['lib/mpd.js', 'ext'], ['lib/fmp4.js', 'ext'], ['lib/position.js', 'ext'], ['lib/native-youtube.js', 'ext'],
  ['youtube/native-host.cjs', 'host'], ['youtube/postprocess.cjs', 'host'], ['youtube/locate.cjs', 'host'],
  ['hook.js', 'main'], ['lib/yt-capture.js', 'main'],
];
const HTML_FILES = ['popup.html', 'manager.html', 'diagnostics.html'];
const EXTRA = new Set(['Xong', 'Ghi']);   // chuỗi tiếng Việt không dấu vẫn phải dịch

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36).slice(0, 4); };
function keyOf(value) {
  const words = fold(value).toLowerCase().replace(/\{\d+\}/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4);
  return `${words.join('_') || 'txt'}_${hash(value)}`;
}
const unescapeJs = (s) => s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (m, e) => {
  if (e[0] === 'u') return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16));
  if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
  return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }[e] ?? e;
});

// ---------- bộ quét JS: gọi onString cho từng chuỗi/template, trả mã đã thay ----------
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'await', 'yield']);
function transformJs(src, onString) {
  let out = '', i = 0;
  const n = src.length;
  let prevSig = '', prevWord = '';
  const pushCode = (c) => { out += c; if (!/\s/.test(c)) { prevSig = c; if (/\w/.test(c)) prevWord += c; else prevWord = ''; } };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? n : e; out += src.slice(i, j); i = j; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; out += src.slice(i, j); i = j; continue; }
    if (c === '/' && (prevSig === '' || REGEX_PREV.has(prevSig) || REGEX_WORDS.has(prevWord))) {
      // regex literal
      let j = i + 1, cls = false;
      for (; j < n; j++) { const x = src[j]; if (x === '\\') { j++; continue; } if (cls) { if (x === ']') cls = false; continue; } if (x === '[') cls = true; else if (x === '/') break; if (x === '\n') break; }
      j++; while (j < n && /[gimsuyd]/.test(src[j])) j++;
      out += src.slice(i, j); prevSig = '/'; prevWord = ''; i = j; continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      for (; j < n; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === c || src[j] === '\n') break; }
      const raw = src.slice(i + 1, j);
      const value = unescapeJs(raw);
      // ngữ cảnh: khoá object ({ 'x': ...) hay case 'x': → không thay
      let k = j + 1; while (k < n && /[ \t]/.test(src[k])) k++;
      const isKey = src[k] === ':' && (prevSig === '{' || prevSig === ',' || prevWord === 'case');
      const rep = (VN.test(value) || EXTRA.has(value)) && !isKey ? onString({ kind: 'str', value, quote: c }) : null;
      if (rep != null) out += rep; else out += src.slice(i, j + 1);
      prevSig = c; prevWord = ''; i = j + 1; continue;
    }
    if (c === '`') {
      // template: tách phần tĩnh và ${...}
      const statics = [], exprs = [];
      let j = i + 1, cur = '';
      for (; j < n; j++) {
        const x = src[j];
        if (x === '\\') { cur += x + src[j + 1]; j++; continue; }
        if (x === '`') break;
        if (x === '$' && src[j + 1] === '{') {
          statics.push(cur); cur = '';
          let depth = 1, k = j + 2, q = null;
          for (; k < n && depth; k++) {
            const y = src[k];
            if (q) { if (y === '\\') { k++; continue; } if (y === q) q = null; else if (q === '`' && y === '$' && src[k + 1] === '{') { let dd = 1; k += 2; while (k < n && dd) { if (src[k] === '{') dd++; else if (src[k] === '}') dd--; k++; } k--; } continue; }
            if (y === '\'' || y === '"' || y === '`') q = y; else if (y === '{') depth++; else if (y === '}') depth--;
          }
          exprs.push(src.slice(j + 2, k - 1));
          j = k - 1; continue;
        }
        cur += x;
      }
      statics.push(cur);
      const value = statics.map((s, idx) => unescapeJs(s.replace(/\\`/g, '`').replace(/\\\$/g, '$')) + (idx < exprs.length ? `{${idx}}` : '')).join('');
      let rep = null;
      if (VN.test(statics.join(''))) rep = onString({ kind: 'tpl', value, exprs: exprs.map((e) => transformJs(e, onString)) });
      if (rep != null) out += rep;
      else { // vẫn xử lý chuỗi tiếng Việt lồng trong ${...}
        let rebuilt = '`';
        statics.forEach((s, idx) => { rebuilt += s; if (idx < exprs.length) rebuilt += '${' + transformJs(exprs[idx], onString) + '}'; });
        out += rebuilt + '`';
      }
      prevSig = '`'; prevWord = ''; i = j + 1; continue;
    }
    pushCode(c); i++;
  }
  return out;
}

// ---------- HTML ----------
const LEAF = /<(b|small|span|h1|h2|h3|p|button|label|option|summary|legend|a|th|td|li|title|strong|em|code)(\s[^<>]*)?>([^<>]*)<\/\1>/g;
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'');
function transformHtml(src, onString) {
  let out = src.replace(LEAF, (m, tag, attrs = '', text) => {
    const value = decode(text.replace(/\s+/g, ' ').trim());
    const existing = /data-i18n="([^"]+)"/.exec(attrs);
    if (existing) { onString({ kind: 'html', value, key: existing[1] }); return m; }   // khoá đặt tay: vẫn ghi vào từ điển
    if (!VN.test(text)) return m;
    const key = onString({ kind: 'html', value });
    return `<${tag}${attrs} data-i18n="${key}">${text}</${tag}>`;
  });
  for (const a of ATTRS) {
    out = out.replace(new RegExp(`\\s${a}="([^"]*)"( data-i18n-${a}="[^"]+")?`, 'g'), (m, v, has) => {
      if (!VN.test(v) || has) return m;   // đã có khoá → không thêm lại (chạy lại nhiều lần vẫn ổn)
      const key = onString({ kind: 'html', value: decode(v) });
      return `${m} data-i18n-${a}="${key}"`;
    });
  }
  return out;
}

module.exports = { transformJs, transformHtml, keyOf, VN, JS_FILES, HTML_FILES };
if (require.main === module) main();
function main() {
// ---------- chạy ----------
// tools/i18n/vi.json: nguồn gốc tiếng Việt của MỌI khoá (kể cả khoá đã thay trong mã) — không bao giờ bỏ khoá khi chạy lại
const VI_PATH = path.join(OUT, 'vi.json');
const viBase = fs.existsSync(VI_PATH) ? JSON.parse(fs.readFileSync(VI_PATH, 'utf8')) : {};
const mode = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const strings = new Map();   // key → { vi, where: Set }
const record = (value, where, forced) => { const key = forced || keyOf(value); const e = strings.get(key) || { vi: value, where: new Set() }; e.where.add(where); strings.set(key, e); viBase[key] = value; return key; };
const saveVi = () => fs.writeFileSync(VI_PATH, JSON.stringify(viBase, null, 1));

if (mode === 'extract') {
  const extra = [];
  for (const [f] of JS_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    transformJs(src, (s) => { record(s.value, f); return null; });
    // chuỗi không dấu nhưng có vẻ là tiếng Việt (liệt kê để soát tay)
    for (const m of src.matchAll(/'((?:Xong|Ghi|Tab|Thu|Dung|Luu|Tai|Mo|Dong|Chon|Huy|Lam|Xoa)(?:\s[^']*)?)'/g)) extra.push(`${f}: '${m[1]}'`);
  }
  for (const f of HTML_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    transformHtml(src, (s) => record(s.value, f, s.key));
    // dòng còn tiếng Việt mà công cụ không bắt (nội dung lẫn thẻ con) → soát tay
    const after = transformHtml(src, () => 'k');
    after.split('\n').forEach((line, i) => { if (VN.test(line) && !/data-i18n/.test(line)) extra.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  }
  saveVi();
  const list = [...strings.entries()].map(([key, e]) => ({ key, vi: e.vi, where: [...e.where] }));
  fs.writeFileSync(path.join(OUT, 'strings.json'), JSON.stringify(list, null, 1));
  fs.writeFileSync(path.join(OUT, 'extra.txt'), extra.join('\n'));
  // khung en.json: khoá → '' (giữ bản dịch đã có)
  const enPath = path.join(OUT, 'en.json');
  const en = fs.existsSync(enPath) ? JSON.parse(fs.readFileSync(enPath, 'utf8')) : {};
  for (const { key } of list) if (!(key in en)) en[key] = '';
  fs.writeFileSync(enPath, JSON.stringify(en, null, 1));
  console.log(`${list.length} chuỗi → ${path.relative(ROOT, path.join(OUT, 'strings.json'))}; ${Object.values(en).filter((v) => !v).length} chưa dịch; ${extra.length} dòng cần soát tay (extra.txt)`);
} else if (mode === 'apply') {
  const en = JSON.parse(fs.readFileSync(path.join(OUT, 'en.json'), 'utf8'));
  const vi = {};
  const missing = [];
  const useKey = (value, where, forced) => { const key = record(value, where, forced); vi[key] = value; if (!en[key]) missing.push(`${key} = ${value}`); return key; };
  const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\n/g, '\\n')}'`;
  const tplEn = (text, exprs) => '`' + text.replace(/[`\\]/g, '\\$&').replace(/\$\{/g, '\\${').replace(/\{(\d+)\}/g, (m, i) => '${' + exprs[Number(i)] + '}') + '`';
  for (const [f, m] of JS_FILES) {
    const file = path.join(ROOT, f);
    const src = fs.readFileSync(file, 'utf8');
    const fn = m === 'host' ? 't' : 'VCI18n.t';
    const out = transformJs(src, (s) => {
      const key = useKey(s.value, f);
      if (m === 'main') { const text = en[key] || s.value; return s.kind === 'tpl' ? tplEn(text, s.exprs) : JSON.stringify(text); }
      if (s.kind === 'tpl' && s.exprs.length) return `${fn}(${q(key)}, [${s.exprs.join(', ')}])`;
      return `${fn}(${q(key)})`;
    });
    fs.writeFileSync(file, out);
  }
  for (const f of HTML_FILES) {
    const file = path.join(ROOT, f);
    fs.writeFileSync(file, transformHtml(fs.readFileSync(file, 'utf8'), (s) => useKey(s.value, f, s.key)));
  }
  const dict = (lang, obj) => `// Từ điển giao diện (${lang}) — sinh bởi tools/i18n-tool.cjs; sửa bản dịch trong tools/i18n/en.json rồi chạy lại "apply".\n(function (root) {\n  const d = ${JSON.stringify(obj, null, 1).replace(/^ /gm, '    ').replace(/\n}$/, '\n  }')};\n  if (typeof module === 'object' && module.exports) module.exports = d;\n  else (root.VC_LOCALES = root.VC_LOCALES || {}).${lang} = d;\n})(globalThis);\n`;
  fs.mkdirSync(path.join(ROOT, 'lib', 'locales'), { recursive: true });
  saveVi();
  // từ điển gồm mọi khoá đã biết (vi.json), không chỉ khoá vừa thay trong lần chạy này
  for (const [k, v] of Object.entries(viBase)) if (!(k in vi)) vi[k] = v;
  const enOut = {}; for (const k of Object.keys(vi)) { enOut[k] = en[k] || vi[k]; if (!en[k] && !missing.some((x) => x.startsWith(k + ' '))) missing.push(`${k} = ${vi[k]}`); }
  fs.writeFileSync(path.join(ROOT, 'lib', 'locales', 'vi.js'), dict('vi', vi));
  fs.writeFileSync(path.join(ROOT, 'lib', 'locales', 'en.js'), dict('en', enOut));
  fs.writeFileSync(path.join(OUT, 'missing.txt'), missing.join('\n'));
  console.log(`đã thay ${Object.keys(vi).length} chuỗi; ${missing.length} khoá chưa có bản dịch tiếng Anh (missing.txt, tạm dùng tiếng Việt)`);
} else console.log('dùng: node tools/i18n-tool.cjs extract | apply');
}
