// Набор для скриптов публикации профилей: схема и хранилище маршрутов тем же кодом,
// которым публикует сервер. В комплекте из бинарника исходников нет, поэтому скрипт
// получает путь к этому модулю от сервера (GRIGDESK_ROUTES_KIT), а не ищет его сам.

export {
  validateBootstrap,
  validateCatalog,
  validatePromptFiles,
  validateRoute,
} from './schema.ts';
export { RoutesStore } from './store.ts';
