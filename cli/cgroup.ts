// Cgroup-принадлежность текущего процесса: сторож команд, прерывающих ход агента
// или окно. Модуль не тянет зависимости: его использует и лёгкий helper
// установленного ctl, и полный source-CLI.

// Electron сам переносит окно в scope app-<build.executableName>-<pid>.scope
// (desktop/package.json); сервер окна и ходы его агентов наследуют этот scope.
const WINDOW_SCOPE = /^app-grigdesk-\d+\.scope$/u;

/**
 * Сегменты путей cgroup из всех строк: v2 даёт одну строку, v1 — по строке на контроллер.
 * Строка без двух двоеточий не разбирается и сегментов не добавляет.
 */
function cgroupSegments(cgroupText: string): string[] {
  return cgroupText.split('\n').flatMap((line) => {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);

    return first >= 0 && second >= 0 ? line.slice(second + 1).split('/') : [];
  });
}

/**
 * Принадлежность службе определяется только точным сегментом пути cgroup.
 * Несколько контроллеров v1 проверяются независимо, сходное имя не подходит.
 */
export function insideUnit(cgroupText: string, unit: string): boolean {
  return cgroupSegments(cgroupText).includes(unit);
}

/**
 * Сервер, поднятый окном, работает не в службе systemd, а в scope окна; агенты — там же.
 * Терминал человека живёт в своём scope, поэтому сторож его не задевает.
 */
export function insideWindowScope(cgroupText: string): boolean {
  return cgroupSegments(cgroupText).some((segment) => WINDOW_SCOPE.test(segment));
}
