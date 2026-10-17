# Ключевой принцип: пульт — ещё одно «окно» кокпита

Каждое нажатие транслируется через `fastify.inject` (заголовок `X-Cockpit-Internal`)
в ту же HTTP-ручку, что жмёт браузер: ворота — `/api/tasks/:id/gate/:key/:decision`
(CAS по курсору trusted ledger уже внутри), ответы агенту — `/api/chat/permission/:pid`,
мутации — существующие resume/sandbox-retry/launch/B24/chat-stop. Второй копии
валидации, CAS-семантики или текстов отказов нет; ошибки ручек переводятся в
человеческий текст в одном месте (`pult/actions.js`). «Что требует человека» сервер
считает ТЕМИ ЖЕ модулями, что чип навигации и вотчер браузера, — импортом
`shared/pipeline/pipelineWait.ts` и `shared/pipeline/agentActivity.ts` (оба — чистые
ESM без Vue): правило остаётся в одном файле.

Источник до переноса: docs/cockpit/telegram-pult.md § Ключевой принцип: пульт — ещё одно «окно» кокпита
