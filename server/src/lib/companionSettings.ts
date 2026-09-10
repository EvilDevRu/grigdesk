// Настройки голосового компаньона, общие для всех окон.
//
// Здесь живёт только то, что обязано совпадать на компьютере и планшете: чем уходит
// быстрый ход. История компаньона server-owned и одна на все устройства, поэтому и
// модель у неё должна быть одна — иначе один разговор шёл бы разными моделями.
// Локальные (device) настройки компаньона — показывать ли аватар и озвучку — остаются
// в браузере (`web/src/features/companion/device-prefs.js`) и сюда не переезжают.
//
// Режим хода в настройку не входит: быстрый ход компаньона всегда `plan` (см.
// docs/cockpit/chat-agents.md), это свойство поверхности, а не выбор человека.

// id исполнителя двоеточий не содержит — на этом стоит разбор пары в UI. id модели,
// наоборот, бывает и со слэшами, и с двоеточиями (`hf.co/user/repo:tag`, `qwen3.6:latest`).
const PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MODEL_MAX = 200;
// Лестницу уровней объявляет сама модель, поэтому список здесь не зашит: проверяется
// только форма. Актуальность уровня сверяет реестр перед ходом — настройка живёт долго,
// а `--effort xhigh` у модели без такой ступени роняет запуск CLI.
const EFFORT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Ссылка на модель: обе половины обязательны вместе. Половинка бессмысленна —
// ход всё равно уйдёт умолчанием реестра, а показанный огрызок обещал бы выбор.
export interface CompanionModelRef {
  provider: string;
  model: string;
}

export interface CompanionSettings {
  modelRef: CompanionModelRef | null;
  effort: string;
}

export const COMPANION_DEFAULTS: Readonly<CompanionSettings> = Object.freeze({
  // null = «модель по умолчанию из реестра исполнителей», как у нового чата.
  modelRef: null,
  // '' = «умолчание исполнителя»: уровень не передаётся вовсе.
  effort: '',
});

/** Управляющие символы уехали бы в аргументы CLI — такая строка отвергается целиком. */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    // Итерация по строке даёт непустые символы, но кодовая точка объявлена
    // необязательной: подстановка нуля здесь безопаснее приведения типа.
    const code = char.codePointAt(0) ?? 0;

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Строка в границах: пустая и слишком длинная одинаково означают «не задано». */
function cleanString(value: unknown, max: number): string {
  if (typeof value !== 'string' || hasControlChars(value)) return '';
  const trimmed = value.trim();
  return trimmed.length && trimmed.length <= max ? trimmed : '';
}

/**
 * Мягкая нормализация: испорченный prefs.json не должен ронять старт кокпита.
 * Наличие модели в живом реестре здесь НЕ проверяется — CLI мог отвалиться или
 * обновиться, а выбор человека остаётся его выбором (UI покажет «нет в реестре»).
 */
export function normalizeCompanionSettings(value: unknown): CompanionSettings {
  const raw = (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}) as { modelRef?: unknown; effort?: unknown };
  const ref = (raw.modelRef && typeof raw.modelRef === 'object' && !Array.isArray(raw.modelRef)
    ? raw.modelRef
    : {}) as { provider?: unknown; model?: unknown };
  const provider = cleanString(ref.provider, 64).toLowerCase();
  const model = cleanString(ref.model, MODEL_MAX);
  // Полупустая ссылка бессмысленна: без обеих половин ход всё равно уйдёт дефолтом
  // реестра, а показанный в настройках огрызок обещал бы выбор, которого нет.
  const modelRef = PROVIDER_RE.test(provider) && model ? { provider, model } : null;
  const effort = cleanString(raw.effort, 32).toLowerCase();
  return {
    modelRef,
    // Уровень без модели не к чему применять: лестница принадлежит конкретной модели.
    effort: modelRef && EFFORT_RE.test(effort) ? effort : '',
  };
}
