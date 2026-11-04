import { translator } from '../../shared/i18n/catalogs.ts';

import type { ContextMenuParams, MenuItemConstructorOptions, Input } from 'electron';

export const SETTINGS_ACCELERATOR = 'CommandOrControl+Alt+S';

export const HELP_ACCELERATOR = 'F1';
/**
 * Нативная F1 не зависит от того, остановил ли терминал DOM-событие.
 * Один keyDown без модификаторов открывает справку текущего документа.
 */
export function isHelpShortcut(input: Pick<
  Input, 'type' | 'code' | 'control' | 'alt' | 'shift' | 'meta' | 'isAutoRepeat'
>): boolean {
  return input.type === 'keyDown' && input.code === 'F1' && !input.isAutoRepeat
    && !input.control && !input.alt && !input.shift && !input.meta;
}

/**
 * Перезагрузка документа не является пользовательской командой приложения.
 * Проверяется физическая клавиша, включая другой язык раскладки и вариант с Shift.
 */
export function isReloadShortcut(input: Pick<Input, 'code' | 'control' | 'meta' | 'alt'>): boolean {
  return input.code === 'F5' || (input.code === 'KeyR' && !input.alt && (input.control || input.meta));
}

/**
 * Физическая клавиша работает в любой раскладке и поверх терминала.
 * Лишние модификаторы и keyUp не должны повторно открывать окно.
 */
export function isSettingsShortcut(
  input: Pick<Input, 'type' | 'code' | 'control' | 'alt' | 'shift' | 'meta' | 'isAutoRepeat'>,
): boolean {
  return input.type === 'keyDown' && !input.isAutoRepeat && input.code === 'KeyS'
    && input.control && input.alt && !input.shift && !input.meta;
}

export type ContextMenuInput = Pick<ContextMenuParams, 'editFlags' | 'isEditable' | 'linkURL'>;

type EditAction = {
  flag: keyof ContextMenuParams['editFlags'];
  role: MenuItemConstructorOptions['role'];
  label: string;
};

const EDIT_ACTIONS = [
  {
    flag: 'canCut',
    role: 'cut',
    label: 'desktop.cut',
  },
  {
    flag: 'canCopy',
    role: 'copy',
    label: 'desktop.copy',
  },
  {
    flag: 'canPaste',
    role: 'paste',
    label: 'desktop.paste',
  },
  {
    flag: 'canSelectAll',
    role: 'selectAll',
    label: 'desktop.selectAll',
  },
] satisfies EditAction[];

/**
 * Роли Electron сохраняют системные действия и горячие клавиши правки и вида.
 * Подписи вычисляются по локали установки, роли и горячие клавиши сохраняются.
 */
export function applicationMenuTemplate(
  actions: { openSettings: () => void; openHelp?: () => void },
  locale = 'ru',
): MenuItemConstructorOptions[] {
  return [
    {
      label: translator.t(locale, 'desktop.file'),
      submenu: [{
        label: translator.t(locale, 'desktop.settings'),
        accelerator: SETTINGS_ACCELERATOR,
        registerAccelerator: false,
        click: () => actions.openSettings(),
      }],
    },
    {
      label: translator.t(locale, 'desktop.edit'),
      submenu: [
        {
          role: 'undo',
          label: translator.t(locale, 'desktop.undo'),
        },
        {
          role: 'redo',
          label: translator.t(locale, 'desktop.redo'),
        },
        { type: 'separator' },
        ...EDIT_ACTIONS.map((action) => ({
          role: action.role,
          label: translator.t(locale, action.label),
        })),
      ],
    },
    {
      label: translator.t(locale, 'desktop.view'),
      submenu: [
        {
          role: 'zoomIn',
          label: translator.t(locale, 'desktop.zoomIn'),
        },
        {
          role: 'zoomOut',
          label: translator.t(locale, 'desktop.zoomOut'),
        },
        {
          role: 'resetZoom',
          label: translator.t(locale, 'desktop.resetZoom'),
        },
        { type: 'separator' },
        {
          role: 'togglefullscreen',
          label: translator.t(locale, 'desktop.fullscreen'),
        },
      ],
    },
{
  label: translator.t(locale, 'core.helpTitle'),
  submenu: [{
    label: translator.t(locale, 'core.helpTitle'),
    accelerator: HELP_ACCELERATOR,
    registerAccelerator: false,
    click: () => actions.openHelp?.(),
  }],
},
  ];
}

/**
 * Контекстное меню содержит только действия, разрешённые editFlags текущего события.
 * Копирование ссылки добавляет отдельную непустую группу без лишних разделителей.
 */
export function contextMenuTemplate(
  params: ContextMenuInput,
  copyLink: (url: string) => void,
  locale = 'ru',
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = EDIT_ACTIONS
    .filter((action) => params.editFlags[action.flag])
    .map((action) => ({
      role: action.role,
      label: translator.t(locale, action.label),
    }));

  if (params.linkURL) {
    if (items.length > 0) {
      items.push({ type: 'separator' });
    }

    const url = params.linkURL;

    items.push({
      label: translator.t(locale, 'desktop.copyLink'),
      click: () => copyLink(url),
    });
  }

  return items;
}
