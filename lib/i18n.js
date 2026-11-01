// Giao diện song ngữ: t(khoá, [tham số]) tra từ điển lib/locales/{en,vi}.js. Ngôn ngữ lưu ở chrome.storage.local.lang
// (mặc định 'en'), đổi là áp dụng ngay cho mọi cửa sổ qua storage.onChanged. Dùng được cả trong Node (bộ tải trên máy).
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const locales = isNode ? { en: require('./locales/en.js'), vi: require('./locales/vi.js') } : (root.VC_LOCALES || {});
  const LANGS = ['en', 'vi'];
  let lang = 'en';
  const listeners = new Set();
  const norm = (l) => (LANGS.includes(l) ? l : 'en');
  function t(key, vars) {
    const table = locales[lang] || {};
    let s = table[key] ?? (locales.en || {})[key] ?? (locales.vi || {})[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
    return s;
  }
  function setLang(l) {
    const next = norm(l);
    if (next === lang) return;
    lang = next;
    apply();
    listeners.forEach((fn) => { try { fn(lang); } catch { /* người nghe lỗi không chặn người khác */ } });
  }
  // Trang/khung: đọc ngôn ngữ đã lưu và theo dõi thay đổi. Trước khi xong, t() dùng tiếng Anh (mặc định).
  let initPromise = null;
  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (typeof chrome === 'undefined' || !chrome.storage) return lang;
      try {
        const r = await chrome.storage.local.get({ lang: 'en' });
        lang = norm(r.lang);
        chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.lang) setLang(ch.lang.newValue); });
      } catch { /* storage chưa sẵn sàng: giữ mặc định */ }
      apply();
      return lang;
    })();
    return initPromise;
  }
  // Áp từ điển lên HTML tĩnh: data-i18n (nội dung), data-i18n-title / -placeholder / -aria-label / -alt (thuộc tính)
  function apply(rootEl) {
    if (typeof document === 'undefined') return;
    const r = rootEl || document;
    r.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    for (const a of ['title', 'placeholder', 'aria-label', 'alt']) {
      r.querySelectorAll(`[data-i18n-${a}]`).forEach((el) => el.setAttribute(a, t(el.getAttribute(`data-i18n-${a}`))));
    }
    if (document.documentElement) document.documentElement.lang = lang;
  }
  const api = { t, init, apply, setLang, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, LANGS, get lang() { return lang; } };
  if (isNode) module.exports = api; else root.VCI18n = api;
})(globalThis);
