const packageCodeWarnings = new Set([
  'Код плагина выполняется с правами GrigDesk.',
  'Код драйвера выполняется с правами GrigDesk.',
  'Модуль интерфейса исполняется в главном окне GrigDesk '
    + 'с вашей сессией и может обращаться к любому API GrigDesk.',
]);

/**
 * Общие пояснения о правах кода можно скрыть для официального источника.
 * Остальные предупреждения относятся к конкретной операции и остаются видимыми.
 */
export function isPackageCodeWarning(warning: string): boolean {
  return packageCodeWarnings.has(warning);
}
