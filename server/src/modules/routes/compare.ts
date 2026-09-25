import { isDeepStrictEqual } from 'node:util';

import type { RouteCompareChange, RouteDraftContent } from '../../../../shared/routesEditorContracts.ts';

type FieldChange = RouteCompareChange['fields'][number];

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function fieldChanges(before: unknown, after: unknown, path = ''): FieldChange[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (before !== null && after !== null && typeof before === 'object'
    && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    const keys = Array.isArray(before) && Array.isArray(after)
      ? Array.from({ length: Math.max(before.length, after.length) }, (_, index) => String(index))
      : [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const oldRecord = before as Record<string, unknown>;
    const newRecord = after as Record<string, unknown>;
    return keys.flatMap((key) => {
      const oldExists = Object.hasOwn(oldRecord, key);
      const newExists = Object.hasOwn(newRecord, key);
      const childPath = `${path}/${pointerPart(key)}`;
      if (!oldExists || !newExists) {
        return [{ path: childPath, kind: oldExists ? 'removed' : 'added',
          before: oldExists ? structuredClone(oldRecord[key]) : null,
          after: newExists ? structuredClone(newRecord[key]) : null } satisfies FieldChange];
      }
      return fieldChanges(oldRecord[key], newRecord[key], childPath);
    });
  }
  return [{ path: path || '/', kind: before === undefined ? 'added'
    : after === undefined ? 'removed' : 'changed',
  before: before === undefined ? null : structuredClone(before),
  after: after === undefined ? null : structuredClone(after) }];
}

/** Визуальные координаты не участвуют в исполняемом хеше и выводятся отдельно. */
export function comparePresentation(before: RouteDraftContent | null,
  after: RouteDraftContent): FieldChange[] {
  return fieldChanges(before?.presentation ?? {}, after.presentation);
}

/** Сравнивает только исполняемые документы; координаты и provenance не меняют каталог. */
export function compareCatalogDocuments(before: RouteDraftContent | null,
  after: RouteDraftContent): RouteCompareChange[] {
  const changes: RouteCompareChange[] = [];
  const oldBootstrap = before
    ? { bootstrap: before.bootstrap, prompts: before.bootstrapPrompts } : null;
  const newBootstrap = { bootstrap: after.bootstrap, prompts: after.bootstrapPrompts };
  if (!isDeepStrictEqual(oldBootstrap, newBootstrap)) {
    changes.push({ scope: 'bootstrap', routeId: null,
      kind: oldBootstrap ? 'changed' : 'added',
      before: oldBootstrap ? structuredClone(oldBootstrap) : null,
      after: structuredClone(newBootstrap),
      fields: fieldChanges(oldBootstrap, newBootstrap) });
  }
  const ids = new Set([...Object.keys(before?.routes ?? {}), ...Object.keys(after.routes)]);
  for (const routeId of [...ids].sort()) {
    const previous = before?.routes[routeId] ?? null;
    const next = after.routes[routeId] ?? null;
    if (isDeepStrictEqual(previous, next)) continue;
    changes.push({ scope: 'route', routeId,
      kind: !previous ? 'added' : !next ? 'removed' : 'changed',
      before: previous ? structuredClone(previous) : null,
      after: next ? structuredClone(next) : null,
      fields: fieldChanges(previous, next) });
  }
  return changes;
}
