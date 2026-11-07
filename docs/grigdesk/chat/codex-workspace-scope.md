# Переезд Codex на app-server молча сузил рабочую область агента до cwd

Симптом со стороны человека: после перехода чата Codex с `codex exec --json` на
`codex app-server` агент «отупел» — работы делает много, а отчитывается коротко и
норовит бросить задачу на середине. Тянет проверять модель, эффорт и промпт; там всё
цело.

Сравнение rollout-файлов `~/.codex/sessions` до и после переезда (один и тот же CLI
0.149.0, одна машина) показывает ровно три расхождения:

| | `codex exec` | `app-server` |
|---|---|---|
| `workspace_roots` | `[cwd, доверенный каталог]` | **`[cwd]`** |
| `history_mode` | `paginated` | `legacy` |
| `originator` / `source` | `codex_exec` / `exec` | `grigdesk` / `vscode` |

Системный промпт при этом побайтово тот же (17 730 символов, совпадающий sha), модель,
`effort`, `personality`, `collaboration_mode`, песочница и набор инструментов — тоже.
То есть «подменили модель» и «потерялся эффорт» проверяются за минуту и отпадают.

**Рабочие корни — отдельное поле, а не следствие writableRoots.** `codex exec --add-dir`
делал доверенный каталог частью рабочей области; у app-server за это отвечает
`runtimeWorkspaceRoots`, и схема прямо говорит: «Omitted defaults to `cwd`». GrigDesk
передавал доверенные каталоги только в `turn/start.sandboxPolicy.writableRoots` — это
право ПИСАТЬ, и агент, работая с соседним репозиторием, не считал его своим.

Поле экспериментальное, поэтому одного его добавления мало: `initialize` обязан объявить
capability, иначе app-server отвечает
`thread/start.runtimeWorkspaceRoots requires experimentalApi capability`. Рядом в
`InitializeCapabilities` лежит `requestAttestation`, и он обязан остаться **false**:
`attestation/generate` по-прежнему не поддержан и завершается fail-closed. Это не
относится к exact server request `mcpServer/elicitation/request`: GrigDesk объявляет
`mcpServerOpenaiFormElicitation`, показывает стандартные `form`/`url` и ограниченный
`openai/form`, возвращает typed `accept`/`decline`/`cancel`, а
`serverRequest/resolved` снимает уже неактуальный UI. Неизвестные server requests
по-прежнему запрещены. Оба поля рабочих корней принимает и `thread/start`, и
`thread/resume`, так что правка чинит и уже начатые чаты, а не только новые.

**`history_mode` вернуть нельзя, и это не баг.** `paginated` включается тем же
`experimentalApi` (`thread/start.historyMode`), но в бинаре CLI лежит прямой запрет
`cannot resume paginated thread`, а GrigDesk на каждый ход делает `thread/resume`. Legacy —
цена интерактивного режима, а не недосмотр.

**Проверять замером, а не схемой:** `codex app-server generate-ts` экспериментальные поля
НЕ печатает — `runtimeWorkspaceRoots` есть только в `TurnEnvironmentParams`, и схемный
сторож его исчезновение не поймает. Поэтому в `codex-installed-app-server-contract.test.js`
живой handshake с `ephemeral: true` (тред не сохраняется, модель не зовётся) плюс негатив
без capability. Убедиться, что правка доехала, можно так: сделать ход и посмотреть
`workspace_roots` в первом `turn_context` свежего rollout — там должны быть оба каталога.

Отдельно рядом лежала вторая мина того же переезда: ответом хода считалось ТОЛЬКО
сообщение с `phase: "final_answer"`, а `codex exec` брал `turn.completed.last_agent_message`,
то есть любое последнее. Ход, закрытый одним `commentary` (обычный исход, когда работа
ушла суб-агентам), давал отказ «codex не вернул ответ» на штатно завершённом turn.
Теперь при пустом final берётся последний commentary — дубль в ленте дешевле потерянного
итога.

**И честная оговорка про диагноз.** Замер по 104 ходам `chats/` показал, что медиана
tool-вызовов на ход выросла (20 → 55), а медиана длины ответа упала (745 → 608), причём
тренд начался ДО переезда: 21.08.2026 CLI обновился с 0.145.0 до 0.149.0. Сужение рабочих
корней — доказанный регресс подачи контекста, но единственной причиной «отупения» его
объявлять нельзя, пока не сделан A/B на одной задаче.

С появлением выбора папки общий список доверенных каталогов удалён. Тот же контракт
`runtimeWorkspaceRoots` теперь получает cwd и дополнительные репозитории проекта/копии
задачи. Проверки realpath и [перехода памяти](workdir-transition-preconditions.md) выполняет чат.
