import { IN_TURN_ATTACHMENT_LIMIT } from '../../../../shared/chat/chatInTurnContracts.ts';
import { readChatImage } from '../chat/chatImages.ts';

export interface QwenImageContent {
  type: 'image';
  mimeType: string;
  data: string;
}

export type QwenPromptContent = QwenImageContent | { type: 'text'; text: string };

const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Обычный prompt и уточнение используют одинаковые структурированные части ACP.
 * Подсказка направляет модель к уже вложенным байтам вместо чтения host-пути из текста.
 */
export function qwenPromptContent(text: string, images: readonly QwenImageContent[]): QwenPromptContent[] {
  return [{
    type: 'text',
    text: images.length
      ? `${text}\n\nАнализируй изображения из вложений непосредственно в этом сообщении.` : text,
  }, ...images];
}

/**
 * Картинки передаются в ACP байтами, без монтирования каталога вложений в CLI.
 * Общий reader проверяет корень, открытый файл, сигнатуру формата и предел 10 МБ.
 */
export async function readQwenImages(
  paths: readonly string[],
  root: string | undefined,
  signal?: AbortSignal,
): Promise<QwenImageContent[]> {
  if (paths.length > IN_TURN_ATTACHMENT_LIMIT) {
    throw new Error(`Qwen: можно приложить не больше ${IN_TURN_ATTACHMENT_LIMIT} изображений.`);
  }

  if (paths.length && !root) {
    throw new Error('Qwen: каталог вложений недоступен. Повторно приложите изображения.');
  }

  const content: QwenImageContent[] = [];
  let totalBytes = 0;

  for (const requested of paths) {
    signal?.throwIfAborted();

    const image = await readChatImage({ cwd: root!, requested });

    if ('error' in image) {
      if (image.status === 413) {
        throw new Error('Qwen: размер изображения превышает 10 МБ.');
      }

      throw new Error('Qwen: изображение недоступно или имеет неподдерживаемый формат. '
        + 'Повторно приложите PNG, JPEG, GIF или WebP.');
    }

    totalBytes += image.bytes.length;

    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Qwen: общий размер изображений превышает 32 МиБ.');
    }

    content.push({
      type: 'image',
      mimeType: image.type,
      data: image.bytes.toString('base64'),
    });
  }

  signal?.throwIfAborted();

  return content;
}
