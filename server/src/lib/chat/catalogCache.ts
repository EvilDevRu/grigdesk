import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { WebChatHead } from '../../../../shared/chat/chatListProjection.ts';
import { sha256 } from '../../../../shared/node/hash.ts';
import type { ChatHead } from './historyStore.ts';

interface FileStat {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface CatalogHead extends FileStat {
  head: ChatHead | null;
  web: WebChatHead | null;
  needsWorkdirRecovery: boolean;
  migrationChecked: boolean;
}

export interface SearchText extends FileStat {
  chat: {
    title: unknown;
    taskId: unknown;
    messages: Array<{ text: string }>;
  };
  lowercase: string[];
}

type CacheLog = {
  warn?: (fields: Record<string, unknown>, message: string) => void;
};

const CACHE_FORMAT = 1;
const FILE_PATTERN = /^\d{4}-\d{2}\/[A-Za-z0-9_-]{1,64}\.json$/;
const HEAD_KEYS = new Set([
  'id', 'title', 'purpose', 'taskId', 'logicalIdentity', 'model', 'modelRef', 'unread',
  'archived', 'createdAt', 'updatedAt', 'preview',
]);
const WEB_KEYS = new Set([
  ...HEAD_KEYS, 'version', 'previewSource', 'hasDraft', 'hasContent', 'pendingDelivery',
  'lastReply', 'closedAt', 'revision', 'effort', 'mode', 'modeSelection',
]);
const ENTRY_KEYS = new Set([
  'file', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'head', 'web',
  'needsWorkdirRecovery', 'migrationChecked',
]);

/**
 * Замена файла через rename меняет inode/ctime даже при прежнем размере и mtime.
 * Эти же признаки связывают текст поиска и короткие шапки с одним файлом.
 */
export function sameFileStat(left: FileStat, right: FileStat): boolean {
  return left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/**
 * Кэш содержит только проекции, а не произвольные поля исходной истории.
 * Повреждение записи отвергает весь кэш: файлы чатов остаются источником истины.
 */
function validEntry(value: CatalogHead, id: string): boolean {
  const head = value?.head;
  const web = value?.web;
  const lastReply = web?.lastReply;

  return !!head && !!web && head.id === id && web.id === id
    && ['ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) =>
      Number.isFinite(value[key as keyof FileStat]))
    && typeof value.needsWorkdirRecovery === 'boolean'
    && typeof value.migrationChecked === 'boolean'
    && typeof head.preview === 'string' && typeof web.previewSource === 'string'
    && typeof web.version === 'string' && /^[a-f0-9]{64}$/.test(web.version)
    && ['hasDraft', 'hasContent', 'pendingDelivery'].every((key) => typeof web[key] === 'boolean')
    && (lastReply === null || !!lastReply && typeof lastReply.key === 'string'
      && typeof lastReply.text === 'string')
    && Object.keys(value).every((key) => ENTRY_KEYS.has(key))
    && Object.keys(head).every((key) => HEAD_KEYS.has(key))
    && Object.keys(web).every((key) => WEB_KEYS.has(key));
}

/**
 * Производный приватный файл ускоряет рестарт, но не заменяет проверку stat.
 * Другой каталог, версия мигратора или реестр моделей требуют нового прохода.
 */
export class ChatCatalogCache {
  private readonly dir: string;

  private readonly log: CacheLog | null;

  private readonly file: string;

  private migration = '';

  private root = '';

  private saved = new Map<string, CatalogHead>();

  private current = false;

  constructor(dir: string, log: CacheLog | null) {
    this.dir = dir;
    this.log = log;
    this.file = path.join(dir, '.web-heads.json');
  }

  /**
   * Загрузка принимает только целый кэш текущей папки и текущего мигратора.
   * Ошибка чтения, JSON, checksum или структуры равнозначна отсутствию кэша.
   */
  async load(migration: string): Promise<Map<string, CatalogHead>> {
    this.current = false;
    this.migration = migration;
    this.root = await fs.realpath(this.dir);

    const entries = new Map<string, CatalogHead>();

    try {
      const cache = JSON.parse(await fs.readFile(this.file, 'utf8'));

      if (cache.format !== CACHE_FORMAT || cache.root !== this.root || cache.migration !== migration
        || typeof cache.entries !== 'string' || cache.digest !== sha256(cache.entries)) {
        return entries;
      }

      for (const [id, entry] of Object.entries(JSON.parse(cache.entries))) {
        const value = entry as CatalogHead & { file: string };

        if (!FILE_PATTERN.test(value.file) || path.basename(value.file, '.json') !== id
          || !validEntry(value, id)) {
          return new Map();
        }

        const { file, ...head } = value;

        entries.set(path.join(this.dir, file), head);
      }

      this.saved = new Map(entries);
      this.current = true;
    } catch {
      // Кэш восстанавливается из файлов; его отказ не препятствует загрузке истории.
      entries.clear();
    }

    return entries;
  }

  /**
   * Неизменная сверка ничего не пишет; новый снимок публикуется через tmp+rename.
   * Отказ производного кэша не превращается в отказ списка или миграции истории.
   */
  async save(heads: Map<string, CatalogHead>): Promise<void> {
    if (!this.migration || this.current && heads.size === this.saved.size
      && [...heads].every(([file, head]) => this.saved.get(file) === head)) {
      return;
    }

    const entries = JSON.stringify(Object.fromEntries([...heads].flatMap(([file, value]) => {
      const relative = path.relative(this.dir, file);

      return value.web && FILE_PATTERN.test(relative)
        ? [[value.web.id, { file: relative, ...value }]] : [];
    })));
    const json = JSON.stringify({
      format: CACHE_FORMAT,
      root: this.root,
      migration: this.migration,
      entries,
      digest: sha256(entries),
    });
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await fs.writeFile(temp, json, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, this.file);
      this.saved = new Map(heads);
      this.current = true;
    } catch (error) {
      this.log?.warn?.({ err: (error as Error).message }, 'кэш шапок не сохранён');
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
}
