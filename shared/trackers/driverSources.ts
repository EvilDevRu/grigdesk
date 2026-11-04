// Встроенные репозитории общие для каталога сервера и подписи источника в окне.
// Локальные ярлыки не добавляют пакет в официальный список.
// Id и совместимость объявляет сам пакет; существование ярлыка не гарантирует,
// что репозиторий уже опубликован и доступен установщику.
export const BUILTIN_DRIVER_SOURCES = [
  { title: 'Битрикс24', url: 'https://github.com/EvilDevRu/grigdesk-b24' },
  { title: 'Jira', url: 'https://github.com/EvilDevRu/grigdesk-jira' },
] as const;
