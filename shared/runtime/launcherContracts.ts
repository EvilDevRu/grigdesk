// Общая публичная форма состояния автозапуска и ярлыка.
// Node и браузер используют одну схему без импорта механизма systemd.
// Что systemctl знает о юните: нет файла → ставить нечего, переключатель бессмыслен.
export type AutostartUnitState = 'enabled' | 'disabled' | 'missing';

export interface AutostartState {
  unit: AutostartUnitState;
  active: boolean;
  // null — logind не ответил (нет loginctl или пользователь ему неизвестен).
  linger: boolean | null;
  // Итог для интерфейса: при включении машины, при входе в систему или никогда.
  mode: 'boot' | 'login' | 'off' | 'unavailable';
}

export interface ShortcutState {
  desktopDir: string | null;
  desktop: boolean;
  menu: boolean;
}

export interface LauncherState {
  autostart: AutostartState;
  shortcut: ShortcutState;
}

