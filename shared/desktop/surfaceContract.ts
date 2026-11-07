import { isTaskSourceId, parseTaskReference } from '../tasks/taskReference.ts';
import type { TaskSourceId } from '../tasks/taskReference.ts';
import { isToolWindowId, isToolInstance } from './toolWindowContract.ts';

import { recordOrNull } from '../lib/objects.ts';

export type SurfaceKind = 'task' | 'tool';
export type SurfaceTarget = {
  kind: 'task';
  id: string;
  source?: TaskSourceId
} | {
  kind: 'tool';
  id: string
};
export type SurfaceDocument = SurfaceTarget & { instance?: string };
export type MainRequest = { destination: 'pipeline' }
  | { destination: 'task-dialog'; target: Extract<SurfaceTarget, { kind: 'task' }> };

/**
 * Единственный реестр входов поверхности не принимает произвольные адреса.
 * Канонический id ограничивает ключ экземпляра и размер сообщений между окнами.
 */
export function parseSurfaceTarget(value: unknown): SurfaceTarget | null {
  const item = recordOrNull(value);

  if (item && Object.keys(item).length === 2 && item.kind === 'tool' && isToolWindowId(item.id)) {
    return { kind: 'tool', id: item.id };
  }

  if (!item || Object.keys(item).some((key) => !['kind', 'id', 'source'].includes(key))
    || item.kind !== 'task'
    || typeof item.id !== 'string' || !/^[1-9][0-9]{0,14}$/.test(item.id)
    || (item.source !== undefined && (!isTaskSourceId(item.source)
      || !parseTaskReference(`${item.source}:${item.id}`)))) {
    return null;
  }

  return {
    kind: 'task',
    id: item.id,
    ...(isTaskSourceId(item.source) ? { source: item.source } : {})
  };
}
/**
 * Адрес поверхностей всегда принадлежит встроенному UI текущего origin.
 * Ни request body, ни реестр не подставляют удалённую страницу в BrowserWindow.
 */
export function surfaceUrl(origin: string, target: SurfaceTarget, instance?: string): string {
  const url = new URL('/', origin);

  url.searchParams.set('surface', target.kind);
  url.searchParams.set('id', target.id);

  if (target.kind === 'task' && target.source) {
    url.searchParams.set('source', target.source);
  }

  if (target.kind === 'tool' && isToolInstance(instance)) {
    url.searchParams.set('instance', instance);
  }

  url.hash = '/surface';

  return url.href;
}
/**
 * Только точный вход документа позволяет восстановить target из адреса.
 * Дубли полей, fragment и неизвестные параметры не меняют назначение окна.
 */
export function surfaceTargetFromUrl(value: string, origin: string): SurfaceDocument | null {
  try {
    const url = new URL(value);

    if (url.origin !== origin || url.protocol !== 'http:' || url.username || url.password
      || url.pathname !== '/' || url.hash !== '#/surface'
      || [...url.searchParams].length !== (url.searchParams.get('surface') === 'tool'
        || url.searchParams.has('source') ? 3 : 2)
      || new Set(url.searchParams.keys()).size !== [...url.searchParams].length) {
      return null;
    }

    const target = parseSurfaceTarget({
      kind: url.searchParams.get('surface'),
      id: url.searchParams.get('id'),
      ...(url.searchParams.has('source') ? { source: url.searchParams.get('source') } : {}),
    });

    if (target?.kind === 'tool') {
      const instance = url.searchParams.get('instance');

      return isToolInstance(instance) ? { ...target, instance } : null;
    }

    return target;
  }
  catch {
    return null;
  }
}

/**
 * Главное окно принимает только известный переход или цель прежнего диалога.
 * Дополнительные поля не расширяют полномочия вызывающего документа.
 */
export function parseMainRequest(value: unknown): MainRequest | null {
  const item = recordOrNull(value);

  if (!item) {
    return null;
  }

  if (Object.keys(item).length === 1 && item.destination === 'pipeline') {
    return { destination: 'pipeline' };
  }

  if (Object.keys(item).length === 2 && item.destination === 'task-dialog') {
    const target = parseSurfaceTarget(item.target);

    return target?.kind === 'task' ? { destination: 'task-dialog', target } : null;
  }

  return null;
}
