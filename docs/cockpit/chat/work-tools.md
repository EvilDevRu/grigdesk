# Рабочие инструменты Cockpit

`supervised_ssh` — первый рабочий tool самого Cockpit. Он доставляется Claude через MCP,
Codex как app-server dynamic tool, Kimi и DeepSeek через ACP/MCP, но
descriptor и dispatcher едины. Scope строится только из trusted attempt ledger и
authoritative project membership; UI-context, body и история его выбрать не могут.
Свободный чат получает null scope.

Агент видит у доступной живой сессии только `label`/`role`. Любой `exec`, независимо от
permission mode/auto/remember, создаёт `origin:'ssh'` в общей `pendingPerms`; ответ идёт
только через `/api/ssh/approvals/:pid`. Human shell отделён от exec-channel агента, SFTP
в tool отсутствует. Lifecycle, DTO и остаточный риск недоверенного вывода описаны в
[ssh.md](../plugins/ssh.md).

`supervised_db` использует тот же server-owned descriptor/dispatcher во всех исполнителях;
его рубеж решений описан в [дополнительных контрактах](../reference/runtime-contracts.md).
Прежний третий tool, `knowledge_search`, снят вместе с базой знаний — его устройство сохранено
в [истории базы](../overview/knowledge-base-history.md).

#### Что рисует всплывашка разрешения (контракт `input`)

`ChatPermission.vue` показывает не сырой запрос, а РАЗОБРАННЫЙ: `description` (что просят),
`details`/`plan` (шапка запроса), `command`, `file_path`, `diff` (две колонки, тем же
`shared/diff.js`, что и лента) и `choices` — специфические кнопки варианта. JSON остался
последним фоллбэком для незнакомой формы. Раньше фоллбэк был единственным путём: Kimi
приезжал объектом ACP, и человек читал `{"toolCall":{"toolCallId":…}}` вместо «правлю такой-то
файл» — решение принималось вслепую.

Собирает это сам адаптер (`permissionPresentation` в `lib/kimi/runtime.ts`), и там два
неочевидных места:

- **ACP-запрос разрешения не несёт ни `kind`, ни аргументов вызова** — только `title` и
  текстовые блоки. Тип действия и команду runtime помнит по `toolCallId` из notification
  `tool_call`/`tool_call_update`; без этого классификатор «Авто» спрашивал бы про каждое
  чтение файла (проверено тестом «тип и команда читаются из восстановленного input»).
- **Правку Kimi отдаёт структурными блоками** `{type:'diff', path, oldText, newText}`, а не
  текстом. В permission-запросе обычно один блок, но lifecycle одного tool call может нести
  несколько; normalizer сохраняет каждый файл отдельно. Пока читались только текстовые блоки,
  дифф во всплывашку и ленту не попадал вовсе.

Обратный ход — три поля ответа, и каждое чем-то оплачено:

| поле | что делает | почему не «политика кокпита» |
|---|---|---|
| `choice` | нажатая кнопка из `choices` едет обратно своим `optionId` | у плана ACP различает «доработать» и «отклонить и выйти»; общего allow/deny для них мало |
| `remember` | «разрешать до конца сессии» → ACP-вариант `allow_always` | галка жила только в памяти вкладки: агент спрашивал снова из каждого окна и после F5 |
| `comment` | пояснение к отказу | ACP-outcome текста не несёт → `commentDelivered: false`, фронт досылает сообщением |

Источник до переноса: docs/cockpit/chat-agents.md § Рабочие инструменты Cockpit
