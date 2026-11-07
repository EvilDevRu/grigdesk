// Настройки запуска принадлежат компьютеру с окном приложения, независимо от выбранного сервера.
// Путь сообщает native-оболочка; renderer не задаёт исполняемый файл или аргументы запуска.
export interface ApplicationLauncherState {
  executablePath: string;
  autostart: boolean;
  shortcut: {
    desktop: boolean;
    menu: boolean;
  };
}
