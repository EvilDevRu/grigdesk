import { createWebLog } from '../../web/src/shared/webLog.ts';

declare const log: ReturnType<typeof createWebLog>;

log.record('app.pagehide', { persisted: true });
log.record('mark', { text: 'Комментарий' });

// @ts-expect-error Неизвестное событие не часть каталога.
log.record('made.up', {});
// @ts-expect-error Поле persisted должно быть boolean.
log.record('app.pagehide', { persisted: 'yes' });
// @ts-expect-error Вложенный dump запрещён даже типизированному вызову.
log.record('mark', { text: 'X', dump: { entries: [{ dump: {} }] } });
// @ts-expect-error События сторожа оболочки больше нет в каталоге.
log.record('shell.anomaly', { kind: 'topbar-missing' });
