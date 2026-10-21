import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);
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
    get label() {
      return t('core.code');
    },
    icon: 'code',
    order: 10,
    hotkey: 'Ctrl+Shift+Digit1',
    plugin: 'code',
  },
  {
    id: 'shelf',
    route: '/shelf',
    get label() {
      return t('core.shelf');
    },
    icon: 'shelf',
    order: 20,
    hotkey: 'Ctrl+Shift+Digit2',
    plugin: 'shelf',
  },
  {
    id: 'studio3d',
    route: '/3d',
    label: '3D',
    icon: 'cube',
    order: 30,
    hotkey: 'Ctrl+Shift+Digit7',
    plugin: 'studio3d',
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
    get label() {
      return t('core.databases');
    },
    icon: 'db',
    order: 50,
    hotkey: 'Ctrl+Shift+Digit5',
    plugin: 'db',
  },
  {
    id: 'docker',
    route: '/docker',
    get label() {
      return t('core.docker');
    },
    icon: 'docker',
    order: 60,
    hotkey: 'Ctrl+Shift+Digit6',
    plugin: 'docker',
  },
  {
    id: 'terminal',
    route: '/terminal',
    get label() {
      return t('core.terminal');
    },
    icon: 'terminal',
    order: 70,
    hotkey: 'Ctrl+Shift+Digit3',
  },
];

export const TOOL_META_BY_ID = new Map(TOOL_CATALOG.map((item) => [item.id, item]));

/**
 * Адрес страницы пользовательского плагина. У него нет Vue-кода в бандле: ядро
 * показывает его страницу по одному общему роуту, а nav.path манифеста здесь не
 * участвует — иначе ссылка вела бы туда, где у роутера ничего нет.
 */
export function pluginPageRoute(id: string): string {
  return `/ext/${id}`;
}

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
