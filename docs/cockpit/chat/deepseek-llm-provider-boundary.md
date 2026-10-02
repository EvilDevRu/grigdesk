# Граница LLM-провайдеров встроенного DSH

Проверено по исходникам 2 октября 2026 года. Встроенный source snapshot закрепляет
DSH `0.1.5-rc.2`, commit `c291e7961a515f6d7af9304e7fd1d257929aef26`.
`tools/runtimeComposition.ts` исключает `@deepseek-ai/dsh-llm-pi-ai` через
`OMITTED_BUNDLE_PACKAGES`; его source root не входит в выбранный snapshot.
Нынешний runtime поэтому нельзя перевести на этот adapter одной настройкой.

В полном upstream того же commit пакет существует и принадлежит проекту DeepSeek Harness.
Он использует модельную библиотеку Pi, без обязательного отдельного агента Pi.
Manifest задаёт MIT и зависимость `@earendil-works/pi-ai: ^0.85.1`; сохранённый
upstream pnpm lock разрешает exact `0.85.1` с integrity. Наличие записи в полном lock
не означает включения package в сокращённую runtime closure.
[Upstream manifest](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-pi-ai/package.json),
[Upstream lock](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/pnpm-lock.yaml).

Upstream plugin имеет provider profiles, credential references, catalog/custom routes
и wire compatibility. Default provider retry допускает пять повторов; без явного
apiKeyEnv catalog route может использовать ambient discovery. Installed catalog и
endpoint discovery — разные источники. Это свойства upstream package, а не включённые
возможности нынешнего Cockpit.
[README exact commit](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/llm/llm-pi-ai/README.md).

Закреплённый `@earendil-works/pi-ai` 0.85.1 уже содержит провайдер `zai`. Его встроенный
адрес — `https://api.z.ai/api/coding/paas/v4`, то есть эндпоинт Coding Plan, а не обычного API
`https://api.z.ai/api/paas/v4`; авторизация по умолчанию читает `ZAI_API_KEY`. Каталог
содержит glm-4.7, glm-5-turbo, glm-5.2, glm-5.2-highspeed, glm-5.3, glm-5.3-flash и
glm-5.3-highspeed с compat `thinkingFormat: zai`, `zaiToolStream` и уровнями рассуждения
по модели. Без заданного effort библиотека отправляет `thinking: { type: disabled }`.
Проверено чтением собранного пакета (`dist/providers/zai.js`, `dist/providers/data/zai.json`,
`dist/api/openai-completions.js`), без сетевых запросов.

Текущий Cockpit adapter отдельно связан с DeepSeek: `buildDeepSeekChildEnv()` требует
`DEEPSEEK_API_KEY`, модельные seeds и профиль принадлежат этому исполнителю. Чат использует
web RPC/events, каталог — ACP. `DISABLED_ROWS` в `profile.ts` применяется только вне web;
список пакетов composition не является списком активных tools или capabilities.

Source/manifest чтение не подтверждает работу GLM, tool calls, thinking/replay,
permissions, cancel/resume или совместимость аккаунта Z.ai. Проверки нынешней DeepSeek
сборки описаны отдельно в [compiled chat parity](deepseek-compiled-chat-parity.md).
