/**
 * Запоминает первую видимую строку до изменения DOM и восстанавливает её положение.
 * Если строка исчезла, уже загруженная область сохраняет прежний scrollTop.
 */
export function captureChatScrollAnchor(root: HTMLElement, selector: string): () => void {
  const bounds = root.getBoundingClientRect();
  const rows = [...root.querySelectorAll<HTMLElement>(selector)];
  const anchor = rows.find((row) => {
    const box = row.getBoundingClientRect();

    return box.bottom > bounds.top && box.top < bounds.bottom;
  });
  const top = anchor?.getBoundingClientRect().top;
  const originalScroll = root.scrollTop;

  return () => {
    if (anchor?.isConnected && top !== undefined) {
      root.scrollTop += anchor.getBoundingClientRect().top - top;
    } else {
      root.scrollTop = originalScroll;
    }
  };
}
