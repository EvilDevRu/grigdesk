// Глобальный каталог стадий конвейера (enum). Единый источник правды: тип узла и подпись
// по умолчанию. Профили (<config.profilesDir>/<name>/graph.json) ССЫЛАЮТСЯ на эти id и могут
// переопределить подпись/сноску/тип. Задел под будущий редактор профилей: там стадии
// выбираются из этого каталога, а не описываются с нуля.

// Тип стадии (кто исполняет).
export const StageKind = Object.freeze({ AGENT: 'agent', HUMAN: 'human', CODE: 'code' });

// Канонические стадии всех маршрутов. gate: true — человеческие ворота.
export const STAGES = Object.freeze({
  // общий костяк / feature
  scout: { kind: 'agent', label: 'Scout' },
  plan: { kind: 'agent', label: 'План' },
  skeptic: { kind: 'agent', label: 'Скептик' },
  validate: { kind: 'code', label: 'Валидация' },
  translator: { kind: 'agent', label: 'Переводчик' },
  gate_plan: { kind: 'human', label: 'План: утвердить', gate: true },
  sandbox: { kind: 'code', label: 'Песочница' },
  tests: { kind: 'agent', label: 'Тесты' },
  tcritic: { kind: 'agent', label: 'Тест-критик' },
  build: { kind: 'agent', label: 'Build' },
  simplify: { kind: 'agent', label: 'Симплифаер' },
  review: { kind: 'agent', label: 'Ревью' },
  trace: { kind: 'agent', label: 'Trace-verify' },
  php: { kind: 'code', label: 'PHP-чек' },
  lint: { kind: 'code', label: 'Линт' },
  browser: { kind: 'agent', label: 'Браузер' },
  gate_accept: { kind: 'human', label: 'Приёмка', gate: true },
  ship: { kind: 'human', label: 'Merge / Ship' },
  // Демо-стадий в каталоге нет: съёмка демо удалена целиком (2026-08-01, видео — в
  // отдельном сервисе), а до того этапом конвейера не была. Вернёшь их сюда — редактор
  // маршрутов предложит поставить в цепочку то, чего движок не ведёт, и конвейер встанет.
  retro: { kind: 'agent', label: 'Ретро' },
  // debug-маршрут
  repro: { kind: 'agent', label: 'Воспроизвести' },
  instrument: { kind: 'agent', label: 'Логи/таймеры' },
  diagnose: { kind: 'agent', label: 'Диагноз' },
  hyposkeptic: { kind: 'agent', label: 'Скептик гипотезы' },
  proof: { kind: 'agent', label: 'Доказательство' },
  gate_cause: { kind: 'human', label: 'Причина: принять', gate: true },
  measure: { kind: 'agent', label: 'Замер ПОСЛЕ' },
});

/**
 * Определение узла из каталога с оверрайдом профиля.
 * Профиль в graph.json задаёт [kind, label, sub]; отсутствующее берётся из STAGES.
 * @returns {[string, string, string]} [kind, label, sub]
 */
export function resolveNode(id, profileNode) {
  const cat = STAGES[id] || { kind: 'agent', label: id };
  const [pKind, pLabel, pSub] = profileNode || [];
  return [pKind || cat.kind, pLabel || cat.label, pSub || ''];
}
