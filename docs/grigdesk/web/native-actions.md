# Сохранение файлов и системная кнопка «Назад»

`web/src/shared/saveFile.ts` выбирает способ сохранения по capability `save` оболочки. POST
`/__shell/save?name=&type=` передаёт Blob без прикладного журнала. В браузере временная ссылка
освобождается в finally. Экспорт маршрутов, расшифровки, журнала, env посредника и ссылки
`UiActionLink` с download используют общий helper.

`window.grigdeskBack()` сначала обращается к верхнему typed layer через `closeTopLayer`,
как Escape. Постоянный диалог удерживает навигацию. Затем вызывается router.back, если
hash-history содержит предыдущий маршрут; на корне возвращается false. Функция устанавливается
в main до mount и снимается при hot dispose.

Проверки: `save-file.test.js`, `back-action.test.js`, `layer-stack.test.js`.

Примитив UiActionLink обращается к UI-owned сервису downloads. Product связывает его с
saveFile через setUiDownloadAdapter из публичного ui.ts в main. UI-kit не импортирует
сторы или shared/saveFile. Системный Назад также получает closeTopLayer через ui.ts.
