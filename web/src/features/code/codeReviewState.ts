import { computed, ref } from 'vue';
import { codeApi, codeErrorMessage } from '../../shared/codeApi';
import { t } from '../../ui';
import type {
  CodeComparison,
  CodeFileDiffResponse,
  CodeRequestContext,
} from '../../../../shared/plugins/code/codeContracts';

type Snapshot = CodeRequestContext & { generation: number };
type Selection = {
  side: 'old' | 'new';
  from: number;
  to: number;
  content: string;
};
export type ReviewNote = Selection & {
  id: number;
  context: CodeRequestContext;
  comparison: CodeComparison;
  oldPath?: string;
  fingerprint: string;
  explain: boolean;
  text: string;
  stale: boolean;
};
type Options = {
  context(): Snapshot;
  current(): CodeComparison | null;
  comparisons(): CodeComparison[];
  content(): CodeFileDiffResponse | null;
  oldPath(): string | undefined;
  selection(): Selection | undefined;
  currentContext(snapshot: Snapshot): boolean;
  refresh(): Promise<void>;
  createDraft(draft: string): Promise<void>;
};

const STORAGE_KEY = 'grigdesk-code-review-v1';
const MAX_VIEWED = 4000;

/**
 * Ключ хранит точный контекст и исходные ревизии без содержимого файлов.
 * JSON-кортеж исключает коллизии путей и разделителей в именах репозиториев.
 */
export function reviewKey(context: CodeRequestContext, comparison: CodeComparison): string {
  return JSON.stringify([
    context.project, context.repoKey, context.treePath, comparison.group,
    comparison.base || '', comparison.to || '', !!comparison.work, comparison.path,
  ]);
}

/**
 * Повреждённое хранилище не влияет на сам просмотр исходников.
 * Отметки после загрузки ещё требуют серверного подтверждения fingerprint.
 */
function readViewed(): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');

    if (!Array.isArray(parsed)) {
      return new Map();
    }

    return new Map(parsed.filter((item): item is [string, string] => (
      Array.isArray(item) && item.length === 2 && typeof item[0] === 'string'
      && typeof item[1] === 'string' && /^[a-f0-9]{64}$/u.test(item[1])
    )).slice(-MAX_VIEWED));
  } catch {
    return new Map();
  }
}

/**
 * Формирует проверяемый человеком пакет с неизменяемыми исходными фрагментами.
 * Ограждение длиннее любой последовательности кавычек в самом фрагменте.
 */
export function buildReviewDraft(notes: ReviewNote[]): string {
  return notes.map((note) => {
    const lines = note.content.split('\n');
    const fragment = lines.slice(0, 200).join('\n');
    const runs = fragment.match(/`+/gu) || [];
    const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));

    return [
      `${note.context.treePath}/${note.comparison.path}`,
      JSON.stringify(note.comparison),
      ...(note.oldPath ? [`oldPath: ${note.oldPath}`] : []),
      `fingerprint: ${note.fingerprint}${note.stale ? ` ⚠ ${t('core.codeReviewStaleNote')}` : ''}`,
      `${note.side}: ${t('core.codeReviewLineRange', { from: note.from, to: note.to })}`,
      note.explain ? t('core.codeReviewExplainInstruction') : note.text,
      fence, fragment, fence,
      ...(lines.length > 200 ? [t('core.codeReviewTruncated')] : []),
    ].join('\n');
  }).join('\n\n');
}

/**
 * Отметки и корзина принадлежат точной рабочей копии, а не открытому пути.
 * Отказ записи не публикует новую отметку и сохраняет уже прочитанное состояние.
 */
export function useCodeReviewState(options: Options) {
  const viewed = ref(readViewed());
  const validated = ref(new Set<string>());
  const reviewNotes = ref<ReviewNote[]>([]);
  const noteText = ref('');
  const noteEditing = ref(false);
  const draftEditing = ref(false);
  const draftText = ref('');
  const reviewError = ref('');
  let pendingNote: ReviewNote | null = null;
  let editedIndex = -1;
  let sequence = 0;
  let validation = 0;

  const scopeNotes = computed(() => reviewNotes.value.filter((note) => (
    note.context.project === options.context().project
    && note.context.repoKey === options.context().repoKey
    && note.context.treePath === options.context().treePath
  )));
  const viewedCount = computed(() => options.comparisons().filter(isViewed).length);

  function isViewed(comparison: CodeComparison | null): boolean {
    return !!comparison && validated.value.has(reviewKey(options.context(), comparison));
  }

  /**
   * Записывает только подтверждённый hash текущего lazy-ответа.
   * Эффект в памяти наступает после успешной записи versioned storage.
   */
  function markViewed() {
    const comparison = options.current();
    const fingerprint = options.content()?.fingerprint;

    if (!comparison || !fingerprint) {
      return;
    }

    const key = reviewKey(options.context(), comparison);
    const next = new Map(viewed.value);
    const accepted = new Set(validated.value);

    if (accepted.has(key)) {
      next.delete(key);
      accepted.delete(key);
    } else {
      next.delete(key);
      next.set(key, fingerprint);
      accepted.add(key);
    }

    const bounded = new Map([...next].slice(-MAX_VIEWED));

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...bounded]));
      viewed.value = bounded;
      validated.value = new Set([...accepted].filter((entry) => bounded.has(entry)));
      reviewError.value = '';
    } catch {
      reviewError.value = t('core.codeReviewStorageError');
    }
  }

  /**
   * Перечитывает только hashes отмеченных сравнений порциями не больше 500.
   * Поздний ответ другого worktree не может подтвердить отметку текущего контекста.
   */
  async function revalidateViewed() {
    const snapshot = options.context();
    const own = ++validation;
    const comparisons = options.comparisons();
    const candidates = [
      ...comparisons.filter((item) => viewed.value.has(reviewKey(snapshot, item))),
      ...scopeNotes.value.map((note) => note.comparison),
    ];
    const marked = [...new Map(candidates.map((item) => [reviewKey(snapshot, item), item])).values()];
    const accepted = new Set(validated.value);

    for (const comparison of comparisons) {
      accepted.delete(reviewKey(snapshot, comparison));
    }

    validated.value = accepted;

    try {
      for (let offset = 0; offset < marked.length; offset += 500) {
        const response = await codeApi.reviewFingerprints(snapshot, {
          comparisons: marked.slice(offset, offset + 500),
        });

        if (!options.currentContext(snapshot) || own !== validation) {
          return;
        }

        const next = new Map(viewed.value);
        const confirmed = new Set(validated.value);

        for (const item of response.comparisons) {
          const descriptor: CodeComparison = {
            group: item.group,
            path: item.path,
            ...(item.base ? { base: item.base } : {}),
            ...(item.to ? { to: item.to } : {}),
            ...(item.work === null ? {} : { work: item.work }),
          };
          const key = reviewKey(snapshot, descriptor);

          if (item.fingerprint && next.get(key) === item.fingerprint) {
            confirmed.add(key);
          } else {
            next.delete(key);
          }

          for (const note of reviewNotes.value) {
            if (reviewKey(note.context, note.comparison) === key && note.fingerprint !== item.fingerprint) {
              note.stale = true;
            }
          }
        }

        viewed.value = next;
        validated.value = confirmed;

        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
        } catch {
          reviewError.value = t('core.codeReviewStorageError');
        }
      }
    } catch (error) {
      if (options.currentContext(snapshot) && own === validation) {
        reviewError.value = codeErrorMessage(error);
      }
    }
  }

  /**
   * Снимок заметки берётся из исходной стороны Monaco до любого обновления файла.
   * Объяснение сразу попадает в корзину, обычный комментарий сначала редактируется.
   */
  function addReviewNote(explain: boolean) {
    const comparison = options.current();
    const selection = options.selection();
    const content = options.content();

    if (!comparison || !selection || !content) {
      return;
    }

    pendingNote = {
      ...selection,
      id: ++sequence,
      context: { ...options.context() },
      comparison: { ...comparison },
      ...(options.oldPath() ? { oldPath: options.oldPath() } : {}),
      fingerprint: content.fingerprint || '',
      explain,
      text: '',
      stale: false,
    };
    editedIndex = -1;
    noteText.value = '';

    if (explain) {
      saveReviewNote();
    } else {
      noteEditing.value = true;
    }
  }

  /**
   * Сохраняет комментарий без изменения исходного фрагмента или координат.
   * Повторное редактирование заменяет только выбранную заметку корзины.
   */
  function saveReviewNote() {
    if (!pendingNote) {
      return;
    }

    const note = { ...pendingNote, text: noteText.value };

    if (editedIndex >= 0) {
      reviewNotes.value.splice(editedIndex, 1, note);
    } else {
      reviewNotes.value.push(note);
    }

    pendingNote = null;
    noteEditing.value = false;
  }

  /**
   * Открывает текст существующего замечания, сохраняя исходные строки и fingerprint.
   * Изменение комментария не переписывает снимок проверенного файла.
   */
  function editReviewNote(index: number) {
    pendingNote = scopeNotes.value[index] || null;
    editedIndex = reviewNotes.value.findIndex((note) => note.id === pendingNote?.id);
    noteText.value = pendingNote?.text || '';
    noteEditing.value = !!pendingNote;
  }

  function removeReviewNote(index: number) {
    const id = scopeNotes.value[index]?.id;

    reviewNotes.value = reviewNotes.value.filter((note) => note.id !== id);
    draftText.value = buildReviewDraft(scopeNotes.value);
  }

  function previewReviewNotes() {
    draftText.value = buildReviewDraft(scopeNotes.value);
    draftEditing.value = true;
  }

  /**
   * Создаёт редактируемый чат-черновик только после просмотра пакета человеком.
   * При отказе передачи корзина и отредактированный текст остаются на экране.
   */
  async function sendReviewNotes() {
    try {
      await options.createDraft(draftText.value);
      draftEditing.value = false;
    } catch (error) {
      reviewError.value = codeErrorMessage(error);
    }
  }

  return {
    viewedCount,
    isViewed,
    markViewed,
    revalidateViewed,
    reviewNotes: scopeNotes,
    noteText,
    noteEditing,
    draftEditing,
    draftText,
    addReviewNote,
    saveReviewNote,
    previewReviewNotes,
    sendReviewNotes,
    removeReviewNote,
    editReviewNote,
    reviewError,
  };
}
