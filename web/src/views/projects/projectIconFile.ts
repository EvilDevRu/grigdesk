import { projectIcon } from '../../../../shared/runtime/projectIcon.ts';

/**
 * Загруженный raster уменьшается до небольшой самостоятельной иконки.
 * Object URL освобождается при любом исходе, оригинал на сервер не отправляется.
 */
export async function projectIconFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
    || file.size <= 0 || file.size > 5 * 1024 * 1024) {
    throw new Error();
  }

  const url = URL.createObjectURL(file);

  try {
    const image = new Image();

    image.src = url;
    await image.decode();

    if (!image.naturalWidth || !image.naturalHeight
      || image.naturalWidth > 4096 || image.naturalHeight > 4096) {
      throw new Error();
    }

    const canvas = document.createElement('canvas');

    canvas.width = 64;
    canvas.height = 64;

    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error();
    }

    const scale = 64 / Math.max(image.naturalWidth, image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;

    context.drawImage(image, (64 - width) / 2, (64 - height) / 2, width, height);

    const result = projectIcon(canvas.toDataURL('image/png'));

    if (!result) {
      throw new Error();
    }

    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
