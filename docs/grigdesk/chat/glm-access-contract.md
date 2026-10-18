# Контракт доступа и допуска GLM

Чистый модуль контракта GLM задаёт два режима доступа Z.ai: `api` и `coding-plan`.
Неизвестные значения отвергаются; неявного выбора режима нет. Ключ обычного API
выбирается только из `ZAI_API_KEY`, ключ Coding Plan — только из
`ZAI_CODING_API_KEY`. Ключ другого режима и ключ DeepSeek не подставляются.
Режим и оба ключа задаются окном «Ключи доступа» в карточке GLM: они пишутся в `.env`
папки данных и применяются без перезапуска ([контракт окна](executor-credentials.md)).

Маршрут обычного API задаёт `baseURL` равным `https://api.z.ai/api/paas/v4`.
Для Coding Plan поле `baseURL` отсутствует: используется встроенный адрес маршрута
`zai` библиотеки pi-ai. Оба маршрута задают `apiKeyEnv: GRIGDESK_GLM_ROUTE_KEY`
и `retryPolicy: { mode: normal, maxRetries: 10 }`: сеть до Z.ai нестабильна, транзиентные сбои
запроса повторяются ([ход GLM](glm-turn-runtime.md)). Константа усилия без выбора — `high`.

Список `GLM_ADMISSION` заморожен и допускает только режим `api`. Отпечаток совместимости — SHA-256
канонического JSON, ключи объектов сортируются рекурсивно. Входы: commit Harness,
пути и хеши его патчей, ревизия композиции, хеш lock сборки, версия и integrity pi-ai,
хеш исходников llm-pi-ai, ревизии профиля и политики GLM, адрес выбранного режима.
BuildId, платформа и путь generation в отпечаток не входят.

## Карточка исполнителя

Адаптер `glm` («GLM (Z.ai)») зарегистрирован как setup-only: карточка видна в настройках
исполнителей, а `run` у него нет, поэтому выбрать GLM в чате нельзя. Доставка — только
встроенная generation DSH (та же, что у DeepSeek). Отказы карточки:

| Код | Когда |
| --- | --- |
| `glm_access_mode_missing`, `glm_access_mode_invalid` | `GRIGDESK_GLM_API_MODE` не задан или не `api`/`coding-plan` |
| `glm_key_missing` | нет ключа своего режима (`ZAI_API_KEY` или `ZAI_CODING_API_KEY`) |
| `glm_mode_not_admitted` | режим с ключом не входит в список допуска |
| `glm_runtime_home_invalid` | `GRIGDESK_GLM_RUNTIME_HOME` не абсолютный |
| `glm_runtime_external` | задан внешний `GRIGDESK_DEEPSEEK_BIN`: GLM его не использует |
| `glm_runtime_missing` | встроенной generation нет |
| `glm_plugin_missing` | в `runtime.json` нет поля `llmPiAi` (или нет кода плагина и pi-ai в поколении) |

Корень private homes — `GRIGDESK_GLM_RUNTIME_HOME` или `<stateDir>/grigdesk-glm`. Окружение
процесса GLM строится тем же allowlist, что у DeepSeek (системные имена, `DSH_HOME`, флаги),
и получает ключ выбранного режима под именем `GRIGDESK_GLM_ROUTE_KEY`; `ZAI_*`,
`DEEPSEEK_API_KEY` и прочие модельные ключи в него не попадают, а в окружение DeepSeek не
попадают ключи Z.ai. Отпечаток учётной записи — `glm-env-key:<16 hex>` от режима и ключа.

Статус MCP карточки честно говорит, что GLM подключает только служебный `grigdesk-work`:
проектные MCP-серверы из `.mcp.json` в этой поставке не запускаются (DSH не спрашивает
approval для MCP-инструментов). Карточка, причины и ключ кэша каталога ключа не содержат;
каталог без допущенного режима — `null` без запуска процесса.
