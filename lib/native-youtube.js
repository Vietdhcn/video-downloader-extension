(function (root) {
  function createClient(runtime) {
    function request(message, terminal, options = {}) {
      let port, timer, settled = false;
      let finish;
      const promise = new Promise((resolve, reject) => {
        finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (port) port.disconnect();
          error ? reject(error) : resolve(result);
        };
        try {
          port = runtime.connectNative('com.videocatcher.youtube');
          port.onMessage.addListener((data) => {
            if (settled) return;
            if (data.type === 'error') finish(new Error(data.error));
            else if (data.type === 'cancelled') {
              const error = new Error(VCI18n.t('da_huy_12ms'));
              error.name = 'AbortError';
              finish(error);
            } else if (data.type === terminal) finish(null, data);
            else if (data.type === 'progress' && options.onProgress) options.onProgress(data);
            else if (data.type === 'ready' && options.onReady) options.onReady(data);
          });
          port.onDisconnect.addListener(() => {
            const detail = runtime.lastError?.message;
            finish(new Error(VCI18n.t('khong_ket_noi_duoc_1etg', [detail ? ` (${detail})` : ''])));
          });
          if (options.timeout) timer = setTimeout(() => finish(new Error(VCI18n.t('bo_tai_youtube_phan_14ec'))), options.timeout);
          port.postMessage({ action: 'hello' });
          port.postMessage({ ...message, lang: typeof VCI18n !== 'undefined' ? VCI18n.lang : 'en' });
        } catch (error) { finish(error); }
      });
      return { promise, cancel() { if (!settled && port) port.postMessage({ action: 'cancel' }); } };
    }
    // Phiên gửi file phụ đề/thuyết minh cho bộ tải trên máy theo khúc base64: chunk(kind, b64) → end() → { files }
    function stage(jobId) {
      let port, waiting = null, failed = null;
      const fail = (error) => { failed = error; if (waiting) { waiting.reject(error); waiting = null; } };
      const next = (type) => new Promise((resolve, reject) => { if (failed) return reject(failed); waiting = { type, resolve, reject }; });
      try {
        port = runtime.connectNative('com.videocatcher.youtube');
        port.onMessage.addListener((data) => {
          if (data.type === 'error') return fail(new Error(data.error));
          if (waiting && data.type === waiting.type) { const w = waiting; waiting = null; w.resolve(data); }
        });
        port.onDisconnect.addListener(() => fail(new Error(VCI18n.t('mat_ket_noi_bo_4qpw', [runtime.lastError?.message ? ` (${runtime.lastError.message})` : '']))));
        port.postMessage({ action: 'hello' });
        port.postMessage({ action: 'stageBegin', jobId, lang: typeof VCI18n !== 'undefined' ? VCI18n.lang : 'en' });
      } catch (error) { fail(error); }
      return {
        ready: () => next('staging'),
        chunk(kind, data) { const p = next('chunk'); port.postMessage({ action: 'stageChunk', kind, data }); return p; },
        async end() { const p = next('staged'); port.postMessage({ action: 'stageEnd' }); const r = await p; try { port.disconnect(); } catch { /* đã đóng */ } return r.files; },
        abort() { try { port.disconnect(); } catch { /* đã đóng */ } },
      };
    }
    return {
      stage,
      ping: () => request({ action: 'hello' }, 'ready', { timeout: 8000 }).promise,
      inspect: (url) => request({ action: 'inspect', url }, 'info', { timeout: 100000 }).promise,
      download: (url, height, onProgress, onReady) => request({ action: 'download', url, height }, 'done', { onProgress, onReady }),
      // Ghép phụ đề/thuyết minh vào file đã tải (ffmpeg): opts = { video, ass, srt, voice, env, subMode, dubMode, lang3, deleteTemp }
      postprocess: (opts, onProgress) => request({ action: 'postprocess', ...opts }, 'done', { onProgress }),
      reveal: (folder, files, hints) => request({ action: 'reveal', folder, files, hints }, 'folderOpened', { timeout: 20000 }).promise,
      openFolder: (file) => request({ action: 'openFolder', ...(file ? { file } : {}) }, 'folderOpened', { timeout: 15000 }).promise,
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createClient };
  else root.VCNativeYouTube = createClient(chrome.runtime);
})(globalThis);
