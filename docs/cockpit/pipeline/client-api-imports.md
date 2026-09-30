# Вложенные компоненты используют общий API

Компонент `web/src/views/pipeline/DeferredFindings.vue` импортирует `api` из
`../../shared/apiClient.ts`. Старого `web/src/api` нет: путь `../../api` останавливает
сборку страницы конвейера с ошибкой `Could not resolve`.

`tests/web/helpers/pipeline-view.js` подменяет оба относительных пути к одному клиенту:
`../shared/apiClient.ts` из страницы и `../../shared/apiClient.ts` из её вложенных
компонентов. Оба получают API одной фикстуры; вложенный компонент не обращается к
настоящему серверу во время проверки.
