import { isRecord } from '../lib/objects.ts';

export interface ProviderResourceText {
  label?: string;
  summary?: string;
  note?: string;
}

export interface ProviderPluginResource {
  key: string;
  kind: 'plugin';
  label: string;
  summary: string;
  note: string;
  tone: string;
  translations: { ru?: ProviderResourceText; en?: ProviderResourceText };
  controls: Array<{
    id: string;
    kind: 'link';
    scope: 'live';
    label: string;
    href: string;
  }>;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\x00-\x08\x0b-\x1f\x7f]/u.test(value)) {
    throw new TypeError('Некорректный текст ресурса плагина.');
  }

  return value;
}

/**
 * Переводы содержат только три текстовых поля, без разметки и новых действий.
 * Неизвестные поля и языки не становятся свойствами визуального ресурса.
 */
function translationsOf(raw: unknown): ProviderPluginResource['translations'] {
  if (raw === undefined) {
    return {};
  }

  if (!isRecord(raw)) {
    throw new TypeError('Некорректные переводы ресурса плагина.');
  }

  const result: ProviderPluginResource['translations'] = {};

  for (const locale of ['ru', 'en'] as const) {
    const entry = raw[locale];

    if (entry === undefined) {
      continue;
    }
    if (!isRecord(entry)) {
      throw new TypeError('Некорректный перевод ресурса плагина.');
    }

    const text: ProviderResourceText = {};

    for (const field of ['label', 'summary', 'note'] as const) {
      if (entry[field] !== undefined) {
        text[field] = boundedText(entry[field], field === 'note' ? 800 : 200);
      }
    }

    result[locale] = text;
  }

  return result;
}

/**
 * Фоновый плагин отдаёт данные для общего блока исполнителя, а не Vue-код.
 * Ресурс допускает лишь HTTPS-ссылки: произвольные команды и настройки отбрасываются.
 */
export function parseProviderPluginUsage(pluginId: string, value: unknown): ProviderPluginResource[] {
  if (!isRecord(value) || !Array.isArray(value.resources) || value.resources.length > 4) {
    throw new TypeError('Некорректный список ресурсов плагина.');
  }

  const keys = new Set<string>();

  return value.resources.map((raw) => {
    if (!isRecord(raw) || typeof raw.key !== 'string' || !/^[a-z0-9_-]{1,64}$/u.test(raw.key)
      || keys.has(raw.key) || !['ok', 'muted', 'warn', 'bad'].includes(String(raw.tone ?? 'muted'))
      || raw.controls !== undefined && (!Array.isArray(raw.controls) || raw.controls.length > 3)) {
      throw new TypeError('Некорректный ресурс плагина.');
    }

    keys.add(raw.key);

    const controls = (raw.controls ?? []).map((control: unknown) => {
      if (!isRecord(control) || control.kind !== 'link') {
        throw new TypeError('Ресурс плагина допускает только ссылку.');
      }

      const href = boundedText(control.href, 2048);
      const url = new URL(href);

      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new TypeError('Недопустимая ссылка ресурса плагина.');
      }

      return {
        id: boundedText(control.id, 64),
        kind: 'link' as const,
        scope: 'live' as const,
        label: boundedText(control.label, 200),
        href: url.href,
      };
    });

    return {
      key: `plugin:${pluginId}:${raw.key}`,
      kind: 'plugin' as const,
      label: boundedText(raw.label, 200),
      summary: boundedText(raw.summary, 200),
      note: boundedText(raw.note ?? '', 800),
      tone: String(raw.tone ?? 'muted'),
      translations: translationsOf(raw.translations),
      controls,
    };
  });
}

/**
 * Смена языка выбирает только проверенные текстовые поля самого ресурса.
 * Данные, ссылка и состояние не зависят от языка окна и не мутируются.
 */
export function localizeProviderPluginResource<Resource extends {
  kind?: string;
  translations?: unknown;
}>(resource: Resource, locale: string): Resource {
  const translations = resource.translations;
  const text = isRecord(translations) ? translations[locale] ?? translations.ru : undefined;

  if (!isRecord(text)) {
    return resource;
  }

  const fields = Object.fromEntries(['label', 'summary', 'note']
    .filter((key) => typeof text[key] === 'string')
    .map((key) => [key, text[key]]));

  return { ...resource, ...fields };
}
