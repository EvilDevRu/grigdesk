import { translate } from '../../../shared/i18n/catalogs.ts';

export interface SectionCommand {
  id: string;
  label: string;
  to?: string;
}

/**
 * Палитра использует готовый список доступных разделов и одну общую команду.
 * Поиск не обращается к содержимому чатов, серверу или закрытым разделам.
 */
export function sectionCommands(
  sections: readonly SectionCommand[],
  query: string,
  locale = 'ru',
): SectionCommand[] {
  const commands = [
    ...sections,
    { id: 'settings', label: translate('core.openSettings', {}, locale) },
  ];
  const needle = query.trim().toLocaleLowerCase();

  return commands.filter((command) => command.label.toLocaleLowerCase().includes(needle));
}
