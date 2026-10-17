import {
  parseRouteDraftContent, RoutesEditorContractError,
} from '../../../../shared/pipeline/routesEditorContracts.ts';
import type { RouteDraft, RouteDraftContent } from '../../../../shared/pipeline/routesEditorContracts.ts';

export interface RouteJsonAuthoringDocument extends RouteDraftContent {
  title: string;
}

export interface RouteJsonBuffer {
  draftId: string;
  baselineRevision: number;
  generation: number;
  baselineRaw: string;
  raw: string;
  dirty: boolean;
  error: string;
}

/** JSON-режим содержит только авторские поля и не сериализует server metadata. */
/**
 * Выделяет авторское содержание черновика для JSON-режима.
 * Служебные поля черновика не становятся частью редактируемого JSON.
 */
export function authoringDocumentOf(draft: RouteDraft): RouteJsonAuthoringDocument {
  return {
    title: draft.title,
    routes: JSON.parse(JSON.stringify(draft.routes)) as RouteDraft['routes'],
    bootstrap: JSON.parse(JSON.stringify(draft.bootstrap)) as RouteDraft['bootstrap'],
    bootstrapPrompts: JSON.parse(JSON.stringify(draft.bootstrapPrompts)) as Record<string, string>,
    presentation: JSON.parse(JSON.stringify(draft.presentation)) as Record<string, unknown>,
    provenance: JSON.parse(JSON.stringify(draft.provenance)) as Record<string, unknown>,
  };
}

/**
 * Сериализует авторский документ в читаемый JSON с завершающим переводом строки.
 * Служебные поля черновика не становятся частью редактируемого JSON.
 */
export function formatJsonDraft(value: RouteJsonAuthoringDocument): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Неизвестные поля отвергаются до применения, поэтому raw не теряет данные. */
/**
 * Разбирает и проверяет JSON перед применением к черновику.
 * Служебные поля черновика не становятся частью редактируемого JSON.
 */
export function parseJsonDraft(raw: string): RouteJsonAuthoringDocument {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    throw new RoutesEditorContractError('синтаксис JSON');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RoutesEditorContractError('корневой объект');
  }

  const record = value as Record<string, unknown>;
  const required = [
    'title', 'routes', 'bootstrap', 'bootstrapPrompts', 'presentation', 'provenance',
  ];

  for (const key of Object.keys(record)) {
    if (!required.includes(key)) {
      throw new RoutesEditorContractError(key);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      throw new RoutesEditorContractError(key);
    }
  }

  if (typeof record.title !== 'string') {
    throw new RoutesEditorContractError('title');
  }

  const content = parseRouteDraftContent({
    routes: record.routes,
    bootstrap: record.bootstrap,
    bootstrapPrompts: record.bootstrapPrompts,
    presentation: record.presentation,
    provenance: record.provenance,
  });

  return { title: record.title, ...content };
}

/**
 * Создаёт буфер JSON для конкретного черновика и поколения правок.
 * Служебные поля черновика не становятся частью редактируемого JSON.
 */
export function newJsonDraftBuffer(draft: RouteDraft, generation: number): RouteJsonBuffer {
  const raw = formatJsonDraft(authoringDocumentOf(draft));

  return {
    draftId: draft.id,
    baselineRevision: draft.revision,
    generation,
    baselineRaw: raw,
    raw,
    dirty: false,
    error: '',
  };
}
