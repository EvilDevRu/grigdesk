import { createHash } from 'node:crypto';

import type { MobileApp } from '../mobileServer.ts';
import { MobileInputError } from '../errors.ts';
import { record, resourceId } from './common.ts';
import type { FacadeDeps } from './common.ts';

/**
 * Допускает только каноническую ссылку: decode/encode не меняет путь и не маскирует другой ресурс.
 * Внутренний image owner дополнительно проверяет realpath и каталоги текущего чата.
 */
function imagePath(ref: string): string {
  const encoded = ref.slice(2);

  if (!/^[A-Za-z0-9_-]{1,2731}$/.test(encoded)) {
    throw new MobileInputError('bad_request', 'Неверная ссылка на картинку.');
  }

  const raw = Buffer.from(encoded, 'base64url');
  const path = new TextDecoder('utf-8', { fatal: true }).decode(raw);

  if (raw.toString('base64url') !== encoded || !path || /[\x00-\x1f]/.test(path)) {
    throw new MobileInputError('bad_request', 'Неверная ссылка на картинку.');
  }

  return path;
}

/**
 * Вложения доступны только при сохранённой ссылке в выбранном чате.
 * Байты допускаются по raster MIME и signature, SVG и внешний URL не попадают в WebView.
 */
export function registerMediaRoutes(app: MobileApp, deps: Pick<FacadeDeps, 'chat' | 'callRaw'>) {
  const inFlight = new Map<string, number>();

  app.get<{
    Params: {
      id: string;
      ref: string;
    };
  }>('/api/mobile/v1/chats/:id/media/:ref', async (request, reply) => {
    const device = request.mobileDevice!.id;
    const active = inFlight.get(device) ?? 0;

    if (active >= 2) {
      throw new MobileInputError('media_busy', 'Дождитесь загрузки открытых картинок.', 503);
    }

    inFlight.set(device, active + 1);

    try {
      const id = resourceId(request.params.id);
      const ref = request.params.ref;
      const chat = await deps.chat.read(id);

      if (!chat) {
        throw new MobileInputError('chat_not_found', 'Чат не найден.', 404);
      }

      let url: string;

      if (ref.startsWith('w:')) {
        try {
          url = `/api/chat/${id}/image?path=${encodeURIComponent(imagePath(ref))}`;
        } catch {
          throw new MobileInputError('bad_request', 'Неверная ссылка на картинку.');
        }
      } else if (ref.startsWith('u:') && /^[A-Za-z0-9_.-]{1,200}$/.test(ref.slice(2))) {
        const file = ref.slice(2);
        const owned = (chat.messages || []).some((message) =>
          (Array.isArray(message.attachments) ? message.attachments : []).some(
            (item) => record(item).file === file,
          ),
        );

        if (!owned) {
          throw new MobileInputError('media_not_found', 'Картинка не найдена в этом чате.', 404);
        }

        url = `/api/chat/attachment/${encodeURIComponent(file)}`;
      } else {
        throw new MobileInputError('bad_request', 'Неверная ссылка на картинку.');
      }

      if (!deps.callRaw) {
        throw new MobileInputError('media_not_found', 'Картинка недоступна.', 404);
      }

      const result = await deps.callRaw('GET', url);
      const type = (String(result.headers['content-type'] || '').split(';')[0] ?? '').toLowerCase();
      const bytes = result.payload;
      const signature =
        type === 'image/png'
          ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          : type === 'image/jpeg'
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : type === 'image/gif'
              ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))
              : type === 'image/webp'
                ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
                  bytes.subarray(8, 12).toString('ascii') === 'WEBP'
                : false;

      if (result.statusCode === 404) {
        throw new MobileInputError('media_not_found', 'Картинка не найдена.', 404);
      }
      if ([413, 415].includes(result.statusCode)) {
        throw new MobileInputError('media_type', 'Недопустимый формат или размер картинки.', 415);
      }
      if (result.statusCode >= 400) {
        const auth = [401, 403].includes(result.statusCode);

        throw new MobileInputError(
          auth ? 'upstream_auth' : `upstream_${result.statusCode}`,
          'Запрос картинки внутри Кокпита не выполнен.',
          auth ? 502 : result.statusCode,
        );
      }
      if (!signature || bytes.length > 10000000) {
        throw new MobileInputError('media_type', 'Недопустимый формат или размер картинки.', 415);
      }

      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;

      reply.header('ETag', etag).header('Cache-Control', 'private, no-store');

      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      return reply.type(type).send(bytes);
    } finally {
      const left = (inFlight.get(device) ?? 1) - 1;

      if (left) {
        inFlight.set(device, left);
      } else {
        inFlight.delete(device);
      }
    }
  });
}
