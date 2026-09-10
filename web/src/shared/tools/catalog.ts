// Паспорт встроенного инструмента: где он живёт, как подписан, какой плагин им владеет
// и какой клавишей он открывается по умолчанию. Vue-компонентов здесь нет намеренно —
// список читают настройки и сторы, а тянуть ради подписи Monaco и терминал они не должны.
// Само сочетание человек меняет на своём устройстве; здесь только заводское значение.
//
// Заводская пара — Ctrl+Shift, а не Alt+Shift: на машине с двумя раскладками Alt+Shift
// занят системным переключателем групп XKB, и вторая нажатая клавиша пары приезжает в
// браузер как GroupNext — то есть страница видит либо Alt+цифру, либо Shift+цифру, но
// никогда обе. Такое сочетание не «конфликтует», а просто молча не существует.

// Паспорт встроенного инструмента. Компонента здесь нет намеренно — её добавляет
// реестр, и только он тянет за собой Monaco и терминал.
export interface ToolMeta {
  id: string;
  route: string;
  label: string;
  icon: string;
  order: number;
  hotkey: string;
  // Терминал не принадлежит плагину и включён всегда — отсюда необязательность.
  plugin?: string;
}

// Что раздел может сказать про инструмент: доступен, выключен плагином или
// ещё неизвестно — реестр плагинов не загружен.
export type ToolAvailability = 'enabled' | 'disabled' | 'pending';

// Реестр плагинов в объёме, который читает эта проверка.
interface PluginsPort {
  loaded: boolean;
  enabled: (id: string) => boolean;
}

export const TOOL_CATALOG: ToolMeta[] = [
  {
    id: 'code',
    route: '/code',
    label: 'Код',
    icon: 'code',
    order: 10,
    hotkey: 'Ctrl+Shift+Digit1',
    plugin: 'code',
  },
  {
    id: 'shelf',
    route: '/shelf',
    label: 'Полка',
    icon: 'shelf',
    order: 20,
    hotkey: 'Ctrl+Shift+Digit2',
    plugin: 'shelf',
  },
  {
    id: 'terminal',
    route: '/terminal',
    label: 'Терминал',
    icon: 'terminal',
    order: 30,
    hotkey: 'Ctrl+Shift+Digit3',
  },
  {
    id: 'ssh',
    route: '/ssh',
    label: 'SSH',
    icon: 'ssh',
    order: 40,
    hotkey: 'Ctrl+Shift+Digit4',
    plugin: 'ssh',
  },
  {
    id: 'db',
    route: '/db',
    label: 'Базы',
    icon: 'db',
    order: 50,
    hotkey: 'Ctrl+Shift+Digit5',
    plugin: 'db',
  },
  {
    id: 'docker',
    route: '/docker',
    label: 'Докер',
    icon: 'docker',
    order: 60,
    hotkey: 'Ctrl+Shift+Digit6',
    plugin: 'docker',
  },
];

export const TOOL_META_BY_ID = new Map(TOOL_CATALOG.map((item) => [item.id, item]));

/**
 * Доступен ли инструмент прямо сейчас. Три ответа, а не два: пока реестр плагинов
 * не загружен, «выключен» было бы враньём — рейка мигала бы недоступностью на каждой
 * загрузке страницы.
 */
export function toolAvailability(
  item: ToolMeta | null | undefined,
  plugins: PluginsPort,
): ToolAvailability {
  if (!item) {
    return 'disabled';
  }

  if (!item.plugin) {
    return 'enabled';
  }

  if (!plugins.loaded) {
    return 'pending';
  }

  return plugins.enabled(item.plugin) ? 'enabled' : 'disabled';
}
