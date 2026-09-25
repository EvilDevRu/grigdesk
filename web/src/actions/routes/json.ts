import { useRoutesStore } from '../../stores/routes.ts';
import {
  authoringDocumentOf, formatJsonDraft, newJsonDraftBuffer, parseJsonDraft,
} from './jsonDraftBuffer.ts';
import { applyLocalChange } from './save.ts';

/** Открывает JSON-представление без перезаписи несохранённого raw-текста. */
/**
 * Открывает JSON-представление текущего авторского документа.
 * JSON-буфер привязан к ревизии открытого черновика и не теряет ошибочный ввод.
 */
export function openJsonDraftBuffer(): void {
  const store = useRoutesStore();
  const document = store.localDocument;

  if (!document || !store.opened?.draftId) {
    return;
  }

  const buffer = store.jsonBuffer;

  if (buffer?.draftId === document.id && buffer.dirty) {
    return;
  }
  if (buffer?.draftId === document.id && buffer.generation === store.editGeneration) {
    return;
  }

  store.jsonBuffer = newJsonDraftBuffer(document, store.editGeneration);
}

/** Сохраняет побайтовый ввод независимо от разобранного документа. */
/**
 * Сохраняет введённый JSON-текст отдельно от структурного редактора.
 * JSON-буфер привязан к ревизии открытого черновика и не теряет ошибочный ввод.
 */
export function updateJsonDraftBuffer(raw: string): void {
  const store = useRoutesStore();

  openJsonDraftBuffer();

  if (!store.jsonBuffer) {
    return;
  }

  store.jsonBuffer.raw = raw;
  store.jsonBuffer.dirty = raw !== store.jsonBuffer.baselineRaw;
  store.jsonBuffer.error = '';
}

/** Форматирует только валидный авторский JSON; ошибка оставляет raw неизменным. */
/**
 * Форматирует корректный JSON, сохраняя ошибку разбора при отказе.
 * JSON-буфер привязан к ревизии открытого черновика и не теряет ошибочный ввод.
 */
export function formatJsonDraftBuffer(): void {
  const store = useRoutesStore();
  const buffer = store.jsonBuffer;

  if (!buffer) {
    return;
  }

  try {
    const formatted = formatJsonDraft(parseJsonDraft(buffer.raw));

    buffer.raw = formatted;
    buffer.dirty = formatted !== buffer.baselineRaw;
    buffer.error = '';
  } catch (error) {
    buffer.error = error instanceof Error ? error.message : 'Неверный JSON-документ.';
  }
}

/** Один «Применить» даёт одну историю и обычное автосохранение полного черновика. */
/**
 * Применяет разобранный JSON к черновику как одну локальную правку.
 * JSON-буфер привязан к ревизии открытого черновика и не теряет ошибочный ввод.
 */
export function applyJsonDraftBuffer(): void {
  const store = useRoutesStore();
  const buffer = store.jsonBuffer;
  const document = store.localDocument;

  if (!buffer || !document || store.opened?.readOnly || store.conflict) {
    return;
  }

  const baselineStillMatches = formatJsonDraft(authoringDocumentOf(document))
    === buffer.baselineRaw;
  const serverStillMatches = store.serverSnapshot
    && formatJsonDraft(authoringDocumentOf(store.serverSnapshot)) === buffer.baselineRaw;

  if (buffer.generation !== store.editGeneration || !baselineStillMatches
    || !store.serverSnapshot
    || (buffer.baselineRevision !== store.serverSnapshot.revision && !serverStillMatches)) {
    buffer.error = 'Черновик изменился после открытия JSON. Сохраните текст отдельно и перечитайте.';

    return;
  }

  try {
    const parsed = parseJsonDraft(buffer.raw);

    applyLocalChange((draft) => {
      draft.title = parsed.title;
      draft.routes = parsed.routes;
      draft.bootstrap = parsed.bootstrap;
      draft.bootstrapPrompts = parsed.bootstrapPrompts;
      draft.presentation = parsed.presentation;
      draft.provenance = parsed.provenance;
    });

    const next = store.localDocument;

    if (!next) {
      return;
    }

    const canonical = formatJsonDraft(authoringDocumentOf(next));

    buffer.raw = canonical;
    buffer.baselineRaw = canonical;
    buffer.baselineRevision = store.serverSnapshot?.revision ?? next.revision;
    buffer.generation = store.editGeneration;
    buffer.dirty = false;
    buffer.error = '';
  } catch (error) {
    buffer.error = error instanceof Error ? error.message : 'Неверный JSON-документ.';
  }
}
