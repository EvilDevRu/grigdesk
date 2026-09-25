# Чат (modules/chat)

- Сервер определяет executor по выбранной модели из `/api/providers`. Claude запускается как
  `claude -p … --output-format stream-json --verbose [--model][--effort][--resume]`;
  Codex поднимает `codex app-server` на один ход: `initialize`/`initialized` →
  `thread/start` для нового разговора либо `thread/resume` по сохранённому thread id →
  `turn/start`. Следующий ход запускает новый app-server process и возобновляет тот же thread.
  По задаче cwd = первый worktree из exact-списка `REPO_COUNT`/`REPO_<i>_*`, остальные
  передаются executor-у как `extraDirs`.
  Для старых песочниц без `REPO_*` совместимо читаются `BE_WT` и `FE_WT`.
  Без задачи cwd = `config.rootDir` (корень репозитория кокпита — исполнитель сразу видит
  корневые AGENTS.md/CLAUDE.md); страница «Агенты» переопределяет его на `agents/`.
  Отдельный trusted-run триажа использует тот же adapter-контракт, но только у исполнителей
  с `scopedWorkspace`: readable roots профиля отделены от единственного writable output,
  сеть и общий Bash закрыты. Claude получает private MCP только с `repo_history`, Codex —
  тот же server-owned descriptor как dynamic tool; остальные внешние MCP в этот ход не едут.
  У Codex capability публикуется только когда живая схема CLI содержит
  `workspaceWrite.readOnlyAccess`; старые версии с чтением всего хоста fail-closed не
  предлагаются для триажа.
  Codex работает с `approvalPolicy: "never"` и sandbox `workspaceWrite`: cwd и `extraDirs`
  перечисляются в `turn/start.sandboxPolicy.writableRoots`, полный доступ к хосту не выдаётся,
  сеть включена для `gh`, `git` и пакетных менеджеров. **Те же пути идут вторым, независимым
  полем `runtimeWorkspaceRoots` в `thread/start`/`thread/resume`**: writableRoots — это только
  право писать, а рабочей ОБЛАСТЬЮ агента без этого поля остаётся один cwd («Omitted defaults
  to cwd» в схеме app-server). Поле экспериментальное, поэтому `initialize` объявляет
  `capabilities: {experimentalApi: true, requestAttestation: false}`; почему второй флаг
  обязан быть выключен и как это отличалось у `codex exec` — [грабли](codex-workspace-scope.md).
- **Доверенные каталоги** задаются один раз в «Настройки → Исполнители» и хранятся в
  `prefs.trustedDirectories`. Сервер проверяет realpath каждого существующего абсолютного
  каталога, не разрешает `/`, убирает дубли и перед каждым новым ходом добавляет список в
  `extraDirs`. Claude превращает его в `--add-dir`, Codex — в
  `turn/start.sandboxPolicy.writableRoots` **и** `thread/*.runtimeWorkspaceRoots` (право
  писать и рабочая область — два разных поля, см. выше). У `kimi acp` такого флага нет.
  Запуск Kimi имеет два режима (`config.kimiLaunchMode`, умолчание `host`): в host-режиме
  Kimi — прямой хост-процесс (parity с claude: host fs/config/credentials, permission-система
  самого CLI), и `extraDirs` ему недоступны — доступ за пределами cwd идёт через
  permission-промпты. В contained-режиме sandbox монтирует каталоги writable bind-ом и
  объявляет их сессии через server-owned
  `local.toml` (`[workspace] additional_dir`) в per-run каталоге-маске, заменяющем
  `<projectRoot>/.kimi-code` целиком (kimi-runtime-security.md). Доверенный каталог может
  содержать сам репозиторий cockpit: в contained-режиме server-owned control state внутри
  него (`chats/`, `server/.state`, `.env`, runtime/factory state) прячется пустым read-only
  mount-ом; в host-режиме этой маски нет — как у claude.
  Глобальные `~/.claude` и
  `~/.codex` Cockpit не переписывает, активный ход не меняется — следующий подхватывает
  настройку без рестарта. Поддержку списка объявляет сам адаптер полем
  `trustedDirectories: true | (config) => boolean`; реестр отдаёт вычисленный boolean в
  `/api/providers`, а UI перечисляет имена поддерживающих исполнителей из этого ответа.
  Поэтому новый исполнитель появляется в подписи без ветки по его id во Vue, а Kimi
  автоматически появляется/исчезает при смене contained/host-профиля.
- **Метрики кольца описаны в продуктовом контракте**
  `docs/cockpit/guide/chat-context.md`. Claude и Codex измеряют вход последнего
  основного model request; Ollama — вход и вывод последнего раунда; Kimi — статус
  открытой ACP-сессии после хода. Накопительный расход не становится контекстом.
  Полный снимок (`contextTokens`, `contextWindow`, `contextMetric`,
  `contextIsEstimate`) проходит через `onProgress`, SSE, `/api/chat/active`,
  остановку и runtime `liveContextUsage` в браузере без записи истории на каждый запрос.
  Codex отправляет собственные `thread/tokenUsage/updated` сразу, а fallback берёт
  из последнего `token_count` точного rollout-файла. Claude не принимает
  `result.usage` и события субагента за основной контекст, после `compact_boundary`
  ждёт новый замер. Ollama не прибавляет старый вывод повторно к следующему входу.
  Kimi добирает `/usage`, когда `/status` не содержит размера (`kimi/runtime.ts`).
  Ноль — измерение; `unavailable` и `legacy-unavailable` — отсутствие точной цифры.
  Неизвестное окно не заменяется видимыми 200k. Пока свежего замера нет, подсказка
  называет показанную цифру замером прошлого хода.
  Настройка автосжатия учитывается лишь при `capabilities.chatAutoCompact`:
  её применяют Claude и Codex, а Kimi/Ollama используют шкалу 80% окна.
- **Prompt cache — отдельная provider-neutral метрика ПОСЛЕДНЕГО model request**, а не часть
  шкалы кольца и не накопительный расход сессии. Executor отдаёт
  `contextCache: { scope: 'request', status, readTokens?, writeTokens?, uncachedTokens? }`,
  где `status` — `reported`, `unavailable` или `not-applicable`. Claude сообщает чтение,
  запись и некэшированный вход; Codex — чтение и некэшированный вход, но не выдумывает
  отсутствующую у CLI запись; Kimi явно отдаёт `unavailable`; у локального Ollama статус
  `not-applicable`, потому что его KV-кэш нельзя приравнивать к тарифицируемому prompt cache.
  Отсутствующее числовое поле означает «provider не сообщил», а не ноль. По одному размеру
  контекста кокпит не делает вывод ни о cache hit, ни о цене: подсказка показывает только
  фактические read/write/uncached, которые пришли в `contextCache`.
- Память агента — в сессиях выбранного CLI. Для Claude/Codex Cockpit хранит `sessionId`
  в записи чата; у Kimi resume id принадлежит отдельному server-owned CAS sidecar-у
  (`ChatSessionBindingStore`), поэтому stale/поддельный PUT браузера не может назначить session.
- **Пустой ответ Claude («пусто»):** `claude -p` может вернуть result без текста — агент завершил ход
  tool-call'ом, который plan-режим запретил (Bash/Write и т.п.), или упёрся в лимит шагов.
  Сервер маппит это в понятное «⚠ …»-сообщение (по `subtype` и `permission_denials`) и пишет
  warn в лог. Типичный триггер: просьба «сделай/запусти/разбери файл» — чат только читает.
- Один Pinia-стор `chat` остаётся владельцем всех разговоров, pending и SSE. Полный
  `ChatSession` монтируется только на странице `/chats`; глобальный `CompanionHost`
  показывает компактный avatar/bubble поверх той же истории и не создаёт второй transport.
- **Плашки над композером — отдельные компоненты** рядом с `ChatSession.vue`: `StepList.vue` (лента шагов
  хода), `ChatQuestion.vue` (вопрос агента), `ChatPermission.vue` (запрос разрешения / план на
  утверждение). Каждая держит свою разметку, стили и мелкое состояние; ChatSession только решает,
  какую показать, и передаёт ответ в стор. Разрешение и вопрос приходят по SSE в стор глобально —
  компонент показывается, если `chatKey` совпал с открытым чатом (`forThisChat`).

Источник до переноса: docs/cockpit/chat-agents.md § Чат (modules/chat)
