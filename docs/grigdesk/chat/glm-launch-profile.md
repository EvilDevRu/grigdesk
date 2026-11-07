# Профиль запуска GLM на общей сборке DSH

Процесс GLM — штатный web- (ход) или ACP-профиль (каталог) общей generation DSH с
server-owned overlay. Overlay и hooks строит общий `buildLaunchFiles` с вариантом GLM;
без варианта вывод DeepSeek не меняется (сверено с эталоном байт в байт).

## Overlay

- `settings` — server-owned документ `settings.yaml` в home чата. Перед каждым запуском он
  перезаписывается `{}`: секция `llm-pi-ai` из него переопределила бы маршрут на следующий
  запрос. DSH сам сохраняет туда выбор модели (`agent-default-model`) — это не влияет на маршрут.
- `sandbox-policy` (`workspace-write`, граница — рабочая папка), `approval: ask`, `permission`
  и `agent-instructions` — как у DeepSeek.
- `llm-deepseek` и `session-title-llm` — `disabled`; модель по умолчанию — строка
  `agent-default-model` (web) или `acp` (ACP) с `{ provider: zai, model }`. Строки `web`,
  `web-search-deepseek`, `web-fetch-http` остаются: без них штатный preset не монтируется.
- `insert`: `llm-pi-ai` с единственным маршрутом `providers.zai` режима доступа,
  мост `hooks-claude-code` (`stderrSummaryMaxChars: 4000`) и только служебный MCP
  `grigdesk-work` с `failOnStartupError: true`. Проектные MCP из `.mcp.json` не подключаются:
  каждый даёт предупреждение, запуск продолжается.

Тесты подменяют только адрес модели и добавляют строку сторожа внешнего fetch через
зависимости запуска; production-overlay отличается этими подменами; у каждого запуска также свой случайный launchId gate.

## Hooks и native gate

- Web chat v3 монтирует [native gate](glm-native-gate.md) и preset `grigdesk-glm`;
  `PreToolUse` и прежний policy-маркер `UserPromptSubmit` в этом варианте удалены.
- Factory и ACP сохраняют `PreToolUse` с matcher `*` — `server/scripts/glmToolPolicyHook.mts`, таймаут 30 с. Hook
  исполняется в песочнице процесса и наружу сообщает только stderr (событие `hook/result`);
  любая ошибка внутри hook — exit 2. Ключа маршрута в его окружении нет.
- `UserPromptSubmit` — hook импортов инструкций, общий с DeepSeek. AGENTS.md, CLAUDE.md и
  импорт `@CLAUDE.local.md` попадают в запрос по одному разу и по порядку.

## Homes и запуск

- Binary home чата — `<корень homes GLM>/chats/<sha256(chatKey)>`, marker принадлежит GLM,
  каталог запуска — `turns/<uuid>` внутри home. Обновление/откат совместимого ELF сохраняет
  память. Переходная embedded-ветка использует прежний compatibility prefix:
  `<корень homes>/<compatibility[:16]>/<sha256(chatKey)>` и
  `<корень homes>/<compatibility[:16]>/turns/<uuid>`. Каталоги 0700, файлы 0600.
- Окружение процесса — общий allowlist и `GRIGDESK_GLM_ROUTE_KEY`; `.env` проекта и home ключ
  маршрута не меняют (окружение процесса приоритетнее).
- Отпечаток запуска — sha256 версии DSH, `GLM_PROFILE_REVISION`, overlay и hooks.
- Остановка завершает только свой процесс (порт закрывается) и удаляет каталог запуска;
  home с журналом сессии сохраняется. Простой ход делает ровно один модельный запрос.

Настоящий binary-путь проверяет [общий набор GLM parity](glm-binary-parity.md).
