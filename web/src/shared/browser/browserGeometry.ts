/**
 * Native-поверхность видима только в своей странице без открытого UI-слоя.
 * Клиппинг не даёт сайту перехватывать topbar и соседнюю колонку приложения.
 */
export function browserRect(
  rect: {
    left: number;
    top: number;
    right: number;
    bottom: number
  },
  viewport: { width: number; height: number },
  active: boolean,
  layers: number,
) {
  if (!active || layers > 0 || !Object.values(rect).every(Number.isFinite)) {
    return null;
  }

  const x = Math.max(0, Math.ceil(rect.left));
  const y = Math.max(0, Math.ceil(rect.top));
  const width = Math.max(0, Math.min(viewport.width, Math.floor(rect.right)) - x);
  const height = Math.max(0, Math.min(viewport.height, Math.floor(rect.bottom)) - y);

  return width && height ? {
    x,
    y,
    width,
    height
  } : null;
}
