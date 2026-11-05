# Подтверждения инструментов DeepSeek

Проверено unit-тестами и настоящим ELF с production overlay и loopback-ответами модели.
Режимы относятся только к чатам DeepSeek; GLM и Factory используют свои политики общего ELF.

## Три режима

| Режим | Правки обычных файлов в cwd | Shell | Проектные MCP |
|---|---|---|---|
| Спрашивать / `default` | Решение человека | Решение человека | Решение человека перед вызовом tool |
| Авто / `auto` | Самостоятельно | Штатная песочница workspace-write; расширение доступа решает человек | Решение человека перед вызовом tool |
| Только чтение / `read-only` | Отказ | Отказ до запуска | Не включаются в launch snapshot |

Чтение, файловый и веб-поиск, чтение веб-страниц и загрузка текста навыка доступны без
подтверждения во всех режимах. Для `web_search` и `web_fetch` проверяются точные имена и
доверенная регистрация; сетевые ограничения Harness сохраняются.
[Контракт веб-инструментов](deepseek-web-tools.md). Native todo/goal и вопросы
человеку сохраняют собственные проверки владельца и свой UI. Разрешение задать вопрос
не дублируется внешней permission-карточкой. Служебные журналы пишутся в runtime home.

В auto `.git`, `.env`/`.env.*`, `.mcp.json`, `.agents`, `.claude`, `.codex` требуют
подтверждения. Symlink, hardlink, внешний и непроверяемый путь тоже требуют человека.
Path resolver использует компонентную канонизацию через `realpathSync.native` и `lstat`;
это дополнительная policy, не обещание устранить гонки любых внешних процессов.
Фактическую границу наружу по-прежнему обеспечивает sandbox DSH.

Обычный native bash в auto не создаёт внешний approval-запрос. `tool-bash` передаёт
команду в `bash-sandbox`; при явном `sandbox_permissions` вопрос до запуска задаёт
штатный `approveEscalation`. Отказ или ask другого native `tools/pre-execute` сохраняется.
Режим `approval: ask` не означает «спрашивать перед каждой командой».

Как и workspace-write у Codex, файловая песочница не является классификатором команд.
В Harness нет аналога native Auto-review Codex: удаление внутри разрешённой папки
не получает обязательного вопроса, сетевые и процессные эффекты не ограничены файловой
политикой. Собственный классификатор GrigDesk к shell не подключается.
[Проверенные штатные механизмы и ограничения](deepseek-native-sandbox.md).

У `grigdesk-work` доверие задаёт только server-owned инвентарь текущего запуска:

- `supervised_ssh/list`, `supervised_db/list` и `schema` идут к действующему брокеру.
- `supervised_ssh/exec` и `supervised_db/query` решает только их брокер; в read-only
  они запрещены до MCP dispatch, включая SQL, выглядящий как SELECT.
- Неизвестные action запрещены. Похожий MCP-префикс не даёт разрешения.

В default/auto инициализация настроенного проектного MCP сохраняет прежний контракт:
он запускается до вызова tool и вне его sandbox. Новая карточка регулирует вызовы инструментов,
а не все startup-эффекты такого процесса. В read-only проектный процесс вообще не создаётся.

## Native enforcement

`deepseek/src/host/toolPermissionGate.mjs` подключается обязательным host-флагом
`--grigdesk-tool-policy` с приватным JSON policy. В нём режим, realpath cwd, ревизия и
точная action-матрица рабочих MCP. `toolPermissionPolicy.mjs` принимает готовые path facts;
отдельный `toolPermissionPaths.mjs` делает файловые проверки. Все модули входят в payload,
input hashes и buildId. Игнорируемый upstream и распакованное поколение не меняются.
Если launch не создал путь обязательной policy, сервер отказывает до native preparation
и рабочего процесса. Неверный файл останавливает host до создания чата.

Асинхронный `tools/pre-execute` ждёт `ctx.approval.request`; только `allowed-once` даёт
допуск конкретному native execution. Финальный `ctx.tools.guard()` проверяет этот допуск
после остальных listeners. Ранний чужой allow не обходит gate. Отказ/abort/ошибка не
исполняют тело; после ожидания проверяются путь, definition, owner и standing policy.
Native registry создаёт замороженную копию аргументов: попытка изменить её во время
ожидания не подменяет одобренный вызов. Сам execution до результата остаётся mutable,
поэтому gate до первого await фиксирует token, владельца, имя/callId, аргументы и функцию.
Замена объекта args, агента или execute во время ответа даёт отказ финального guard.

Для валидного `sandbox_permissions` у штатных bash/write/edit используется один native
`approveEscalation` перед эффектом, без внешнего дублирующего вопроса. Поле неизвестного
инструмента и malformed-пара не дают обхода. Разовый grant не переносится на другой вызов
и не меняет standing sandbox. В read-only расширение запрещено.

Синхронный `agent/session-start` применяет ожидаемый preset до первой сборки system prompt.
`agent/pre-step` и каждый tool guard повторно проверяют фактическую политику. Сохранённые
`sandbox/mode=danger-full-access` и `approval/policy=never` не переопределяют режим чата.
Один лишь launch default этого не гарантирует: overrides живут в native журнале.

## Доставка в окно

`toolPermissionContext.ts` сопоставляет события текущего root follow с approval waterfall.
Оба порядка доставки поддержаны; старые snapshot-вызовы не становятся активными. До пяти
секунд ждём только недоставленный контекст, после появления карточки этот таймер снят.
Conflicting args/name, чужой agent, завершённый или повторный callId дают отказ.

Общий `scopedRemote.ts` владеет connection generation, eventId и отдельным AbortController.
Remote cancel снимает свой waiter; поздний allow не отправляется native. Соседние вопросы
сохраняют свои lifetime. Для всех запросов gate `requiresExplicitUser=true`,
`canRemember=false`; общий autoDecision не заменяет решение человека.
Write показывает предлагаемое содержимое, edit — дифф, shell — полную команду, MCP — параметры.

## Совместимость и проверка

Optional boolean `toolPermissions` проходит runtime-info decoder и descriptor. Metadata
старой поставки читается без изменения формы; DeepSeek-specific preflight требует true
до изменения binding и запуска рабочего процесса. Missing/false требуют обновить ELF;
неверный тип metadata отвергается. GLM, Factory и metadata не получают этот глобальный gate.

ID режимов сохранены. Прежний default теперь спрашивает. Неизвестный ID даёт
`invalid_permission_mode`, пустое значение — default. Общий web-helper выбирает один mode
для меню и запроса, включая смену провайдера. Mode меняется со следующего запуска;
pending остаётся привязан к своему вызову. Ревизия `deepseek-host-sandbox-v6` может один раз пересоздать
native session через общий binding, сохранив отображаемую ленту и заметку о смене профиля.

Основные проверки: `toolPermissionPolicy.test.mts`, `toolPermissionPaths.test.mts`,
`toolPermissionGate.test.mts`, `deepseek-tool-permission-context.test.js`,
`deepseek-tool-permission-parity.test.js`, `deepseek-chat.test.js` и
`chat-model-switch-revert.test.js`. Приёмочные тесты считают реальные эффекты и запросы,
а не только текст «отказано» в UI; настоящее API модели заменяется loopback fixture.
