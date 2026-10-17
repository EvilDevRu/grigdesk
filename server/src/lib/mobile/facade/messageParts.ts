import { recordOrEmpty } from '../../../../../shared/lib/objects.ts';

import { STEP_IMAGE_TEXT } from '../../../../../shared/chat/chatSteps.ts';
import type { Media, MessagePart } from '../contract.ts';
import { text } from './common.ts';

const RASTER = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Разбирает только fenced code и картинки, оставляя прочий Markdown обычным текстом.
 * Внешняя картинка становится подписью: WebView не обращается к её адресу.
 */
export function splitMessageParts(source: string): MessagePart[] {
  const truncated = source.length > 32768;

  source = text(source);

  const parts: MessagePart[] = [];

  /**
   * Склеивает соседний обычный текст, не меняя содержимое fenced code.
   * Ограничение части всегда сопровождается явным truncated для интерфейса.
   */
  function append(value: string) {
    if (!value) {
      return;
    }

    const last = parts.at(-1);

    if (last?.type === 'text') {
      const combined = last.text + value;

      last.text = text(combined);
      last.truncated = last.truncated || last.text.length < combined.length;
    } else {
      const bounded = text(value);

      parts.push({
        type: 'text',
        text: bounded,
        ...(bounded.length < value.length ? { truncated: true } : {}),
      });
    }
  }

  const expression = /```([^\n`]*)\n([\s\S]*?)(?:```|$)|!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\n]+)\)/g;
  let offset = 0;

  for (const match of source.matchAll(expression)) {
    if (parts.length >= 198) {
      append(source.slice(offset));
      offset = source.length;

      break;
    }

    append(source.slice(offset, match.index));
    offset = match.index! + match[0].length;

    if (match[2] !== undefined) {
      const bounded = text(match[2]);

      parts.push({
        type: 'code',
        lang: text(match[1]?.trim().split(/\s+/)[0], 100),
        text: bounded,
        ...(bounded.length < match[2].length ? { truncated: true } : {}),
      });

      continue;
    }

    const alt = text(match[3], 800);
    let target = String(match[4] || '')
      .replace(/^<|>$/g, '')
      .trim();

    if (/^https?:\/\//i.test(target)) {
      append(`[картинка: ${alt}] <${target}>`);

      continue;
    }
    if (target.startsWith('file://')) {
      try {
        const url = new URL(target);

        if (url.host) {
          throw new Error('remote_file');
        }

        target = decodeURIComponent(url.pathname);
      } catch {
        append(`[картинка: ${alt}]`);

        continue;
      }
    }
    if (
      !target ||
      /[\x00-\x1f]/.test(target) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ||
      Buffer.byteLength(target) > 2048
    ) {
      append(`[картинка: ${alt}]`);

      continue;
    }

    parts.push({
      type: 'image',
      ref: `w:${Buffer.from(target).toString('base64url')}`,
      alt,
    });
  }

  append(source.slice(offset));

  if (truncated) {
    const last = parts.at(-1);

    if (last?.type === 'text' || last?.type === 'code') {
      last.truncated = true;
    } else {
      parts.push({
        type: 'text',
        text: 'Сообщение сокращено.',
        truncated: true,
      });
    }
  }

  return parts;
}

/**
 * Media выдаётся только по сохранённым raster ссылкам этого сообщения и успешным шагам.
 * MIME вложения может отсутствовать в slim истории, поэтому расширение служит предварительным фильтром.
 */
export function collectMedia(message: Record<string, unknown>): Media[] {
  const result: Media[] = [];

  if (message.role === 'user') {
    for (const value of Array.isArray(message.attachments) ? message.attachments : []) {
      const attachment = recordOrEmpty(value);
      const file = text(attachment.file, 200);

      if (RASTER.test(file) && /^[A-Za-z0-9_.-]+$/.test(file)) {
        result.push({
          ref: `u:${file}`,
          alt: text(attachment.name || file, 800),
          from: 'upload',
        });
      }
    }
  } else {
    const steps = (Array.isArray(message.steps) ? message.steps : []).map(recordOrEmpty);
    const results = new Map<string, Record<string, unknown>>();

    for (const step of steps) {
      if (step.k === 'res' && typeof step.id === 'string') {
        results.set(step.id, step);
      }
    }

    for (const step of steps) {
      const sub = text(step.sub, 2048);
      const outcome = typeof step.id === 'string' ? results.get(step.id) : undefined;
      // Исполнители пишут вызов и итог отдельными записями с общим id, как их видит лента окна.
      // Склеенная запись без пары остаётся признаком старой формы и требует заглушку картинки.
      const shown = outcome ? outcome.ok === true : step.text === STEP_IMAGE_TEXT;

      if (
        step.k !== 'res' &&
        ['Read', 'GenerateImage'].includes(String(step.name)) &&
        shown &&
        RASTER.test(sub)
      ) {
        result.push({
          ref: `w:${Buffer.from(sub).toString('base64url')}`,
          alt: text(`${step.name}: ${sub.split('/').at(-1)}`, 800),
          from: 'step',
        });
      }
    }
  }

  return result.slice(0, 100);
}
