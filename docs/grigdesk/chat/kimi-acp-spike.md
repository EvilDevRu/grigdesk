# Kimi ACP: результаты contract spike

## Зафиксированная совместимость

| Компонент | Точная версия | Основание |
|---|---:|---|
| Kimi Code | `0.31.1` | системный binary и живой `agentInfo` |
| ACP protocol | `1` | живой `initialize` |
| ACP spec | `v0.10.x` | version table adapter-а |
| GrigDesk transport | встроенный NDJSON JSON-RPC | без runtime-зависимости от ACP SDK |

GrigDesk отказывается запускать другую CLI version до повторной проверки compatibility profile.
Исторический unauthenticated transcript сохранён как
[обезличенный fixture](../../../tests/fixtures/kimi-acp/unauthenticated-0.31.1.json), а production
lifecycle покрывает [offline contract test](../../../tests/server/kimi-runtime.test.js).

Исследовательский harness удалён: рабочий Kimi устанавливается как обычный системный CLI и
находится через `PATH`/`GRIGDESK_KIMI_BIN`.

## Что доказано живым процессом

Unauthenticated probe ранее подтвердил:

- `initialize` возвращает protocol `1`, `loadSession: true`, image/embedded context, MCP HTTP/SSE,
  `session/list` и `session/resume` capabilities;
- auth рекламируется как terminal method `login`;
- `session/new` без login возвращает `Authentication required`;
- при `KIMI_DISABLE_TELEMETRY=1` до session creation лишних сетевых socket calls нет.

После системной установки и login новый contained probe подтвердил без model prompt:

- authenticated `session/new` и раннее получение ACP session ID;
- model options для `kimi-code/k3`, `kimi-code/k3-256k`,
  `kimi-code/kimi-for-coding-highspeed` и `kimi-code/kimi-for-coding`;
- thinking effort и ручные modes `default`/`plan`;
- успешное применение config options до prompt;
- штатное завершение процесса с code `0`.

Первый живой ход с prompt (2026-08-02) дополнительно зафиксировал streaming chunks, tool calls и
permission approve/reject, а также несовместимость Kimi `0.31.1` с credential barrier: CLI
перечитывает OAuth-файл на каждый model request, поэтому unmount barrier снят — см.
[kimi-runtime-security.md](kimi-runtime-security.md#credential-barrier-снят).

Содержимое credentials не читалось, не копировалось и не логировалось.

Статистика подписки подключена отдельно от ACP turn: GrigDesk кратковременно запускает официальный
loopback-only `kimi web`, читает его типизированный read-only `/api/v1/oauth/usage` и штатно
завершает именно этот child. Так в UI попадают недельная квота, скользящее окно 5 часов и Extra
Usage; model session/turn не создаётся, а OAuth credential file остаётся во владении Kimi CLI.

## Результат source audit точного тега

Проверен точный tag `@moonshot-ai/kimi-code@0.31.1`, а не плавающая ветка:

- новый session ID создаётся adapter-ом до вызова kernel `createSession`;
- `session/resume` не replay-ит историю, `session/load` replay-ит её до ответа;
- переданный в resume `cwd` сам Kimi сейчас не проверяет против сохранённой сессии, поэтому эту
  ownership-проверку выполняет GrigDesk binding store;
- ACP server автоматически вызывает `session.listSkills()` после new/load/resume;
- ACP-supplied MCP servers передаются в session setup, а core умеет подключать config/plugins/MCP;
- auth gate поддерживает несколько provider credential sources, поэтому наследование host env
  запрещено;
- документированного общего ACP-флага, надёжно отключающего project/user config, hooks, plugins,
  skills и MCP, не найдено.

Следствие реализовано в [contained runtime](kimi-runtime-security.md): host sources скрыты mount и
чистым environment, а пустая `mcpServers` сама по себе границей безопасности не считается.

## Mode/tool matrix MVP

| Mode | Permission policy | Product status | Live model/tool measurement |
|---|---|---|---|
| `default` | manual | enabled | ожидает квотный smoke |
| `plan` | manual | enabled | ожидает квотный smoke |
| `auto` | auto | blocked | post-MVP |
| `yolo` | yolo | blocked | post-MVP |

Runtime переводит ACP permission requests в существующий GrigDesk approval UI и fail-closed
отклоняет неизвестные interaction forms. Корректность lifecycle проверена fake ACP; фактические
формы событий Kimi во время model/tool turn ещё не зафиксированы живым smoke.

### режим GrigDesk «Авто» (2026-08-02)

Поверх ACP `default` добавлен режим GrigDesk `auto`: Kimi продолжает слать
`session/request_permission`, а на запросы отвечает классификатор
[`auto-approve.js`](../../../server/src/lib/chat/autoApprove.ts). Молча разрешаются read/search/
think/fetch/edit/move и shell-команды вне деструктивного списка; `delete`, деструктивные паттерны
(`rm -r`, git `push --force`/`reset --hard`/`clean`/`rebase`, `sudo`, `dd`, запись в системные
каталоги и т.п.), вопросы агента и неизвестные формы уходят человеку во всплывашку. Это UX-политика,
а не security boundary: реальная граница — contained runtime (только workspace rw, без сети и
credentials). ACP-режимы `auto`/`yolo` по-прежнему заблокированы; классификатор не снимает пункт
«фактические формы tool calls» из квотного smoke ниже.

## Что осталось проверить с расходом квоты

- ~~первый authenticated prompt: ordering chunks/tool calls~~ — зафиксировано 2026-08-02; terminal
  result успешного многошагового хода проверяется повторно после снятия credential barrier;
- ~~permission approve~~ — зафиксировано; question approve/reject ещё нет;
- cancel во время model, tool и interaction wait, включая смерть дочернего дерева;
- resume новым процессом и отсутствие replay;
- usage/context, typed network/rate-limit errors и `/compact`;
- фактическое поведение `default` и `plan` с read/write/shell/network attempts.

Эти проверки требуют отдельного явного разрешения. До него Kimi можно выбрать в чате, но первый
реальный ответ нельзя считать live-smoke-проверенным.

## Первичные источники

- [Kimi ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
- [Kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
- [Kimi Code 0.31.1](https://github.com/MoonshotAI/kimi-code/tree/%40moonshot-ai%2Fkimi-code%400.31.1)
- [ACP server lifecycle](https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai%2Fkimi-code%400.31.1/packages/acp-adapter/src/server.ts)
- [Квоты Kimi Code и команда `/usage`](https://www.kimi.com/code/docs/en/kimi-code/membership.html)
