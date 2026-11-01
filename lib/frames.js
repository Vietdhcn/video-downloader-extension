(function (root) {
  function isPlayerFrame(node) {
    if (!node || !['iframe', 'frame'].includes(node.localName)) return false;
    if (/camera|microphone/i.test(node.getAttribute('allow') || '')) return false;
    return !!node.allowFullscreen || node.hasAttribute('allowfullscreen') ||
      /fullscreen/i.test(node.getAttribute('allow') || '') ||
      /(?:player|embed|\/watch|\/xem)/i.test(`${node.src || ''} ${node.title || ''}`);
  }
  const api = { isPlayerFrame };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VCFrames = api;
})(globalThis);
