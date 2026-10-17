// Изображения для листа/видов декодируются локально только после проверки сигнатуры.
// SVG, чужой MIME и слишком большой raster не получают object URL или canvas.
import { checkImageDimensions } from '../../shared/viewer3d/modelResources.ts';

export const STUDIO_IMAGE_LIMIT = 20 * 1024 * 1024;

/**
 * PNG/JPEG/WebP определяется по bytes и расширению, затем проверяется настоящим decode.
 * Caller владеет ImageBitmap и обязан close после crop, preview или проверки вида.
 */
export async function readStudioImage(input: File): Promise<{ file: File; bitmap: ImageBitmap }> {
  if (input.size > STUDIO_IMAGE_LIMIT) {
    throw new Error('Картинка должна быть до 20 МиБ.');
  }
  
  const header = new Uint8Array(await input.slice(0, 16).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp = new TextDecoder().decode(header.slice(0, 4)) === 'RIFF'
    && new TextDecoder().decode(header.slice(8, 12)) === 'WEBP';
  const mime = png ? 'image/png' : jpeg ? 'image/jpeg' : webp ? 'image/webp' : '';
  const ext = input.name.split('.').at(-1)?.toLowerCase();
  const matches = mime === 'image/png' ? ext === 'png' : mime === 'image/jpeg'
    ? ['jpg', 'jpeg'].includes(ext ?? '') : mime === 'image/webp' && ext === 'webp';
  
  if (!mime || !matches || (input.type && input.type !== mime)) {
    throw new Error('Поддержаны настоящие PNG, JPEG и WebP с соответствующим расширением.');
  }
  
  const file = input.type ? input : new File([input], input.name, { type: mime });

  checkImageDimensions(new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()));

  const bitmap = await createImageBitmap(file);
  
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 64 * 1024 * 1024) {
    bitmap.close();
    
    throw new Error('Картинка должна содержать не больше 64 мегапикселей.');
  }
  
  return { file, bitmap };
}

/**
 * Canvas возвращает настоящий PNG без ссылок на внешние ресурсы.
 * Null/ошибка encoder не заменяются пустым файлом для последующей оплаты.
 */
export function studioCanvasBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не удалось сохранить картинку.')), type);
  });
}
