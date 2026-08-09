// Один Escape — один верхний слой. Приоритеты соответствуют z-index; при равном
// приоритете побеждает зарегистрированный последним слой.
const layers = new Map();
let sequence = 0;
let listening = false;

function topLayer() {
  return [...layers.values()]
    .filter((layer) => layer.enabled?.() !== false)
    .sort((a, b) => b.priority - a.priority || b.sequence - a.sequence)[0] || null;
}

function onKey(event) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // xterm и Monaco используют Escape внутри себя. Доступная кнопка закрытия
  // остаётся в chrome слоя и потому не попадает под этот маркер.
  if (event.target?.closest?.('[data-escape-owner]')) return;
  const layer = topLayer();
  if (!layer || layer.close(event) === false) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function ensureListener() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('keydown', onKey, true);
}

export function registerLayer(id, { priority = 0, close, enabled = null }) {
  ensureListener();
  const token = Symbol(id);
  layers.set(token, { id, priority, close, enabled, sequence: ++sequence });
  return () => layers.delete(token);
}

export function activeLayerId() { return topLayer()?.id || null; }
