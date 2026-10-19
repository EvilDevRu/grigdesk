/**
 * Высота приложения следует видимой области при появлении экранной клавиатуры.
 * Сенсорный режим задаётся устройством, поэтому ширина окна не меняет размеры мышиных controls.
 */
export function installAppViewport(win: Window = window, doc: Document = document): () => void {
  const root = doc.documentElement;
  const coarse = win.matchMedia('(pointer: coarse)');
  const viewport = win.visualViewport;
  const previousTouch = root.hasAttribute('data-ui-touch');
  const previousHeight = root.style.getPropertyValue('--app-viewport-height');
  /**
   * Размер берётся из видимого viewport, включая клавиатуру и масштаб документа.
   * Общие CSS-токены получают одно согласованное значение до кадра приложения.
   */
  const update = () => {
    const height = viewport?.height || win.innerHeight;
    const zoom = Number.parseFloat(win.getComputedStyle(root).zoom) || 1;

    root.toggleAttribute('data-ui-touch', coarse.matches || previousTouch);
    root.style.setProperty('--app-viewport-height', `${Math.floor(height / zoom)}px`);
  };

  update();
  coarse.addEventListener('change', update);
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  win.addEventListener('resize', update);

  return () => {
    coarse.removeEventListener('change', update);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    win.removeEventListener('resize', update);
    root.toggleAttribute('data-ui-touch', previousTouch);

    if (previousHeight) {
      root.style.setProperty('--app-viewport-height', previousHeight);
    } else {
      root.style.removeProperty('--app-viewport-height');
    }
  };
}
