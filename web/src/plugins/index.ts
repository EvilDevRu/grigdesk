// Загрузчик системных плагинов веба: каждый живёт в своей папке `web/src/plugins/<id>/`
// и регистрирует размещения в своём `index.ts`. Импорт этого файла из точки входа —
// единственная связь ядра с набором плагинов; добавить плагин = добавить папку.
const modules = import.meta.glob('./*/index.ts', { eager: true });

export const SYSTEM_WEB_PLUGINS = Object.keys(modules).length;
