import { projectIcon } from '../../../../shared/runtime/projectIcon.ts';

const svgType = 'image/svg+xml';
const iconFileTypes = ['image/png', 'image/jpeg', 'image/webp', svgType];

export const PROJECT_ICON_FILE_ACCEPT = [...iconFileTypes, '.svg'].join(',');

/**
 * PNG, JPEG, WebP и SVG декодируются как изображение и вписываются в PNG 64×64.
 * SVG загружается в Image, где сценарии и внешние ресурсы отключены браузером.
 */
export async function projectIconFile(file: File): Promise<string> {
  const unknownType = file.type === '' || file.type === 'application/octet-stream';
  const type = unknownType && /\.svg$/iu.test(file.name) ? svgType : file.type;

  if (!iconFileTypes.includes(type) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
    throw new Error();
  }

  const imageData = type === file.type ? file : file.slice(0, file.size, type);
  const url = URL.createObjectURL(imageData);

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
