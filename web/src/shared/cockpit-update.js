export const ACTIVE_UPDATE_STATES = new Set([
  'queued', 'preparing', 'installing', 'building', 'testing', 'applying', 'restarting',
]);

export const UPDATE_STAGE_LABELS = {
  queued: 'Задание поставлено в очередь',
  preparing: 'Проверяю условия и готовлю снимок',
  installing: 'Устанавливаю зависимости',
  building: 'Собираю web',
  testing: 'Запускаю smoke-тест',
  applying: 'Публикую подготовленную сборку',
  restarting: 'Перезапускаю Cockpit',
  done: 'Обновление применено',
  failed: 'Обновление завершилось ошибкой',
};

// Те же стадии одним-двумя словами — для плитки версии в конце рейки, где полная фраза
// не помещается. Полная остаётся во всплывашке и в настройках.
export const UPDATE_STAGE_SHORT_LABELS = {
  queued: 'В очереди',
  preparing: 'Готовлю снимок',
  installing: 'Зависимости',
  building: 'Собираю web',
  testing: 'Smoke-тест',
  applying: 'Публикую сборку',
  restarting: 'Перезапуск',
};

export const BLOCK_REASON_LABELS = {
  no_release_checked: 'Сначала выполните проверку опубликованных релизов.',
  branch_not_main: 'Релиз устанавливается только на ветку main.',
  detached_head: 'Checkout находится в detached HEAD.',
  working_tree_dirty: 'В checkout есть незакоммиченные или untracked-файлы.',
  checkout_ahead: 'Локальная main опережает выбранный релиз.',
  checkout_diverged: 'История checkout расходится с выбранным релизом.',
  checkout_at_release: 'Выбранный релиз уже находится в checkout; примените локальный checkout.',
  release_not_newer: 'Опубликованный релиз не новее запущенной версии.',
  update_in_progress: 'Уже выполняется другое задание обновления.',
  version_tag_mismatch: 'VERSION не совпадает с exact-тегом checkout.',
  dirty_apply_not_supported: 'Dirty checkout пока нельзя применить автоматически; сначала зафиксируйте изменения.',
};

export function cockpitUpdateTone(status) {
  if (status?.job?.status === 'failed') return 'error';
  if (status?.checkoutChanged) return 'checkout';
  if (status?.updateAvailable) return 'release';
  return '';
}

export function blockReasonLabel(code) {
  return BLOCK_REASON_LABELS[code] || `Обновление заблокировано: ${code}`;
}
