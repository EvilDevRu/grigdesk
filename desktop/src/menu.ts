import type { ContextMenuParams, MenuItemConstructorOptions, Input } from 'electron';

export const SETTINGS_ACCELERATOR = 'CommandOrControl+Alt+S';

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
    label: 'Вырезать',
  },
  {
    flag: 'canCopy',
    role: 'copy',
    label: 'Копировать',
  },
  {
    flag: 'canPaste',
    role: 'paste',
    label: 'Вставить',
  },
  {
    flag: 'canSelectAll',
    role: 'selectAll',
    label: 'Выделить всё',
  },
] satisfies EditAction[];

/**
 * Роли Electron сохраняют системные действия и горячие клавиши правки и вида.
 * Все видимые подписи русские независимо от языка окружения рабочего стола.
 */
export function applicationMenuTemplate(
  actions: { openSettings: () => void },
): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Файл',
      submenu: [{
        label: 'Настройки…',
        accelerator: SETTINGS_ACCELERATOR,
        registerAccelerator: false,
        click: () => actions.openSettings(),
      }],
    },
    {
      label: 'Правка',
      submenu: [
        {
          role: 'undo',
          label: 'Отменить',
        },
        {
          role: 'redo',
          label: 'Повторить',
        },
        { type: 'separator' },
        ...EDIT_ACTIONS.map((action) => ({
          role: action.role,
          label: action.label,
        })),
      ],
    },
    {
      label: 'Вид',
      submenu: [
        {
          role: 'zoomIn',
          label: 'Увеличить',
        },
        {
          role: 'zoomOut',
          label: 'Уменьшить',
        },
        {
          role: 'resetZoom',
          label: 'Сбросить масштаб',
        },
        { type: 'separator' },
        {
          role: 'togglefullscreen',
          label: 'Полный экран',
        },
      ],
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
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = EDIT_ACTIONS
    .filter((action) => params.editFlags[action.flag])
    .map((action) => ({
      role: action.role,
      label: action.label,
    }));

  if (params.linkURL) {
    if (items.length > 0) {
      items.push({ type: 'separator' });
    }

    const url = params.linkURL;

    items.push({
      label: 'Копировать адрес ссылки',
      click: () => copyLink(url),
    });
  }

  return items;
}
