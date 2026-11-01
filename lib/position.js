(function (root) {
  function outside(rect, width, height, viewportWidth, viewportHeight) {
    const gap = 8, margin = 4;
    const clamp = (n, max) => Math.max(margin, Math.min(n, max));
    if (viewportWidth < width + margin * 2 || viewportHeight < height + margin * 2) return null;
    const x = clamp(rect.right - width, viewportWidth - width - margin);
    const y = clamp(rect.top, viewportHeight - height - margin);
    if (rect.right + gap + width <= viewportWidth - margin) return { left: rect.right + gap, top: y };
    if (rect.top - gap - height >= margin) return { left: x, top: rect.top - gap - height };
    if (rect.bottom + gap + height <= viewportHeight - margin) return { left: x, top: rect.bottom + gap };
    if (rect.left - gap - width >= margin) return { left: rect.left - gap - width, top: y };
    return null; // Fullscreen: use the extension popup after leaving fullscreen.
  }
  // Menu của nút: ưu tiên bên dưới, thiếu chỗ thì lên trên, nếu cả hai đều thiếu thì chọn phía rộng hơn
  // và giới hạn chiều cao (menu tự cuộn). Luôn nằm trong viewport kể cả khi nút sát mép màn hình.
  function menu(button, width, height, viewportWidth, viewportHeight) {
    const gap = 6, margin = 8;
    const w = Math.min(width, Math.max(0, viewportWidth - margin * 2));
    const left = Math.max(margin, Math.min(button.right - w, viewportWidth - w - margin));
    const below = Math.max(0, viewportHeight - margin - (button.bottom + gap));
    const above = Math.max(0, button.top - gap - margin);
    if (height <= below) return { left, top: button.bottom + gap, maxHeight: below };
    if (height <= above) return { left, top: button.top - gap - height, maxHeight: above };
    const room = Math.max(below, above);
    if (room < 120) return { left, top: margin, maxHeight: Math.max(0, viewportHeight - margin * 2) }; // màn hình quá thấp
    if (below >= above) return { left, top: button.bottom + gap, maxHeight: below };
    return { left, top: button.top - gap - Math.min(height, above), maxHeight: above };
  }
  const api = { outside, menu };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VCPosition = api;
})(globalThis);
