import { pluginResourcePath, readPluginRaster } from '../pluginAssets.ts';
import { installError } from '../packageInstall/errors.ts';

/**
 * Логотип драйвера использует безопасное чтение ресурсов пакета, но только PNG.
 * Полный обход chunks отвергает анимацию и обрыв контейнера до импорта кода.
 */
export function readTrackerLogo(directory: string, raw: unknown) {
  const relative = pluginResourcePath(raw);
  const raster = readPluginRaster(directory, relative, 256 * 1024);
  const bytes = raster.bytes;
  let offset = 8;
  let header = false;
  let ended = false;

  if (raster.mediaType !== 'image/png') {
    throw installError('manifest_invalid', 'Логотип должен быть PNG');
  }

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);

    if (offset + length + 12 > bytes.length || ['acTL', 'fcTL', 'fdAT'].includes(type)) {
      throw installError('manifest_invalid', 'Нужен полный PNG без анимации');
    }

    if (!header) {
      if (type !== 'IHDR' || length !== 13) {
        throw installError('manifest_invalid', 'Нет заголовка PNG');
      }

      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);

      if (width < 1 || height < 1 || width > 512 || height > 512) {
        throw installError('manifest_invalid', 'Стороны логотипа должны быть от 1 до 512 пикселей');
      }

      header = true;
    } else if (type === 'IHDR') {
      throw installError('manifest_invalid', 'Повтор заголовка PNG');
    }

    offset += length + 12;

    if (type === 'IEND') {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }

  if (!header || !ended) {
    throw installError('manifest_invalid', 'PNG оборван или содержит лишние данные');
  }

  return raster;
}
