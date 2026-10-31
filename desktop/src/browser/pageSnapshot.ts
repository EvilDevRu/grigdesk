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
