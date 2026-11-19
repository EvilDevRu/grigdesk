import { projectIcon } from '../../../../shared/runtime/projectIcon.ts';

const mimeByExtension = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
]);
const iconFileTypes = new Set(mimeByExtension.values());
const iconSize = 64;
const analysisSize = 256;
const transparentInset = 6;

const extensions = Array.from(mimeByExtension.keys(), (extension) => `.${extension}`);

export const PROJECT_ICON_FILE_ACCEPT = [...iconFileTypes, ...extensions].join(',');

interface IconBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  inset: number;
}

/**
 * Находит границы видимого знака в ограниченной по размеру копии.
 * Непрозрачная композиция сохраняется целиком, у прозрачного знака убираются пустые поля.
 */
function iconBounds(image: HTMLImageElement): IconBounds {
  const { naturalWidth, naturalHeight } = image;
  const analysis = document.createElement('canvas');
  const scale = Math.min(1, analysisSize / Math.max(naturalWidth, naturalHeight));

  analysis.width = Math.max(1, Math.round(naturalWidth * scale));
  analysis.height = Math.max(1, Math.round(naturalHeight * scale));

  const { width, height } = analysis;
  const context = analysis.getContext('2d');

  if (!context) {
    throw new Error();
  }

  context.drawImage(image, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);
  const corners = [0, width - 1, width * (height - 1), width * height - 1];

  if (corners.every((index) => data[index * 4 + 3] === 255)) {
    return {
      x: 0,
      y: 0,
      width: naturalWidth,
      height: naturalHeight,
      inset: 0,
    };
  }

  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + 1);
        bottom = Math.max(bottom, y + 1);
      }
    }
  }

  if (left >= right || top >= bottom) {
    throw new Error();
  }

  // Уменьшенная копия округляет край. Здесь оставляем один её пиксель на сглаживание.
  if (scale < 1) {
    left = Math.max(0, left - 1);
    top = Math.max(0, top - 1);
    right = Math.min(width, right + 1);
    bottom = Math.min(height, bottom + 1);
  }

  return {
    x: left * naturalWidth / width,
    y: top * naturalHeight / height,
    width: (right - left) * naturalWidth / width,
    height: (bottom - top) * naturalHeight / height,
    inset: transparentInset,
  };
}

/**
 * PNG, JPEG, WebP и SVG декодируются как изображение. Знак вписывается
 * пропорционально в PNG 64×64 без добавления непрозрачной подложки.
 * SVG загружается в Image, где сценарии и внешние ресурсы отключены браузером.
 */
export async function projectIconFile(file: File): Promise<string> {
  const unknownType = file.type === '' || file.type === 'application/octet-stream';
  const extension = /\.([a-z]+)$/iu.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const type = (unknownType ? mimeByExtension.get(extension) : file.type) ?? '';

  if (!iconFileTypes.has(type) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
    throw new Error();
  }

  const imageData = type === file.type ? file : file.slice(0, file.size, type);
  const url = URL.createObjectURL(imageData);

  try {
    const image = new Image();

    // Canvas читает пиксели после load. Не ждём отрисовки отдельного Image:
    // в фоновой вкладке она может откладываться и блокировать сохранение формы.
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error());
      image.src = url;
    });

    if (!image.naturalWidth || !image.naturalHeight
      || image.naturalWidth > 4096 || image.naturalHeight > 4096) {
      throw new Error();
    }

    const canvas = document.createElement('canvas');

    canvas.width = iconSize;
    canvas.height = iconSize;

    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error();
    }

    const bounds = iconBounds(image);
    const scale = (iconSize - 2 * bounds.inset) / Math.max(bounds.width, bounds.height);
    const width = bounds.width * scale;
    const height = bounds.height * scale;

    context.imageSmoothingQuality = 'high';
    context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height,
      (iconSize - width) / 2, (iconSize - height) / 2, width, height);

    const result = projectIcon(canvas.toDataURL('image/png'));

    if (!result) {
      throw new Error();
    }

    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
