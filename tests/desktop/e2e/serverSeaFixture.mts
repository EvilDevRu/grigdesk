/**
 * Общий argv фикстуры SEA используется GUI и проверкой выбора профиля без Electron.
 * Собственный профиль и сервер проверки не зависят от сохранённых настроек человека.
 */
export function seaDesktopArguments(desktop: string, port: number): string[] {
  return [desktop, `--grigdesk-url=http://127.0.0.1:${port}`, '--password-store=gnome-libsecret'];
}
