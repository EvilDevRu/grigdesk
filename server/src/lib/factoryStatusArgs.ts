/**
 * Дополнительные флаги границы стадии допускаются только вместе у ведущего цикла.
 * Обычные result без этих полей сохраняют прежний пустой набор аргументов.
 */
export function factoryStatusBoundaryArgs(value: Record<string, unknown>, loopRole: string): string[] {
  if (value.nextStage !== undefined && typeof value.nextStage !== 'boolean') {
    throw new TypeError('nextStage должен быть boolean');
  }

  const closed = value.stageClosed === undefined ? [] : value.stageClosed;
  const summary = value.stageSummary === undefined ? '' : value.stageSummary;

  if (!Array.isArray(closed) || closed.length > 128
    || closed.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(id))
    || typeof summary !== 'string' || summary.length > 2000 || /[\r\n\0]/u.test(summary)) {
    throw new TypeError('Граница стадии повреждена');
  }

  const boundary = value.nextStage === true || closed.length > 0 || summary.length > 0;

  if (!boundary) {
    return [];
  }

  if (loopRole !== 'lead' || value.nextStage !== true || value.result !== 'failed'
    || closed.length === 0 || summary.length === 0) {
    throw new TypeError('Граница следующей стадии требует ведущего и полного failed result');
  }

  return ['--next-stage', ...closed.flatMap((id) => ['--stage-closed', String(id)]),
    '--stage-summary', summary];
}
