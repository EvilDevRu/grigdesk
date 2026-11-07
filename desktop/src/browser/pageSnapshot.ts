export const SNAPSHOT_SOURCE = String.raw`(() => {
  const nodes = new Map();
  const elements = [];
  const candidates = document.querySelectorAll(
    'a,button,input,textarea,select,[role="button"],[contenteditable="true"]'
  );
  for (const node of candidates) {
    if (elements.length >= 200) break;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (elements.length + 1);
    nodes.set(ref, node);
    const label = node.getAttribute('aria-label') || node.labels?.[0]?.innerText
      || node.innerText || node.getAttribute('placeholder') || '';
    elements.push({
      ref, tag: node.tagName.toLowerCase(),
      role: node.getAttribute('role') || '', name: label.slice(0, 300),
      disabled: Boolean(node.disabled), password: node.type === 'password'
    });
  }
  globalThis.__grigdeskBrowserNodes = nodes;
  const text = document.body?.innerText || '';
  return { text: text.slice(0, 24000), truncated: text.length > 24000, elements };
})()`;

export const RESOLVE_SOURCE = String.raw`function(ref) {
  const node = globalThis.__grigdeskBrowserNodes?.get(ref);
  if (!node || !node.isConnected || node.disabled) return null;
  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = node.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!rect.width || !rect.height || !(hit === node || node.contains(hit))) return null;
  const editable = (node.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'submit', 'button']
    .includes(node.type) && !node.readOnly)
    || (node.tagName === 'TEXTAREA' && !node.readOnly) || node.isContentEditable;
  return { x, y, editable: Boolean(editable) };
}`;

/**
 * DOM-исполнение команды агента в изолированном мире: клик, заполнение и прокрутка
 * работают на невидимой вкладке без синтетических событий ввода окна. Действие
 * видно обработчикам главной страницы: DOM-события пересекают миры, а execCommand
 * порождает настоящие input-события для реактивных форм.
 */
export const DOM_ACT_SOURCE = String.raw`function(payload) {
  const node = globalThis.__grigdeskBrowserNodes?.get(payload.ref);
  if (!node || !node.isConnected || node.disabled) return { ok: false, code: 'stale_element' };

  if (payload.action === 'scroll') {
    window.scrollBy(0, Math.max(-2000, Math.min(2000, payload.deltaY || 0)));
    return { ok: true };
  }

  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

  if (payload.action === 'fill') {
    const editable = (node.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'submit', 'button']
      .includes(node.type) && !node.readOnly)
      || (node.tagName === 'TEXTAREA' && !node.readOnly) || node.isContentEditable;

    if (!editable) return { ok: false, code: 'invalid_fill' };

    if (node.tagName === 'SELECT') {
      const option = Array.from(node.options)
        .find((item) => item.value === payload.text || item.text === payload.text);

      if (!option) return { ok: false, code: 'invalid_fill' };

      node.value = option.value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }

    node.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, payload.text);
    return { ok: true };
  }

  node.click();
  return { ok: true };
}`;
