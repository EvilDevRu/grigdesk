# Состав host runtime DeepSeek

Выбранные исходники Harness `0.1.5-rc.2` закреплены commit
`c291e7961a515f6d7af9304e7fd1d257929aef26`. Сборка использует upstream host-проекты,
TypeScript 6.0.3, upstream Typert generator и отдельный npm lock. Проверены Linux x64
с glibc и Node 22.22.1. Остальные платформы не подтверждены этой проверкой.

Состав содержит 178 workspace-пакетов для компиляции; 177 входят в готовый runtime.
Compiler, bundler, их executable dependencies и Typert generator удаляются после
генерации reflection. Проверенный артефакт занимает около 200 MiB. Точное содержание
каждой сборки находится в `composition.json`, а лицензии 366 workspace/npm-пакетов —
в `licenses/index.json`. Исходный snapshot — 2490 файлов, 22 726 718 байт; в Git лежит только
его manifest, исходники подготавливаются в кэш ([снимок](deepseek-source-snapshot.md)).

## Композиция

| Часть | Сохранённое поведение |
|---|---|
| Base | Agent loop, session, persistence и миграции журналов, settings, credentials, tools |
| Web host | Loopback URL, штатный обмен process token на cookie, RPC envelopes, event transport |
| ACP | JSON-RPC stdio, initialize, session controls и MCP |
| Настройки | Settings service, private settings-file document, controller и приватный ACP мост |
| Инструменты | Filesystem, shell, sandbox, hooks, MCP и ресурсы shipped agent presets |
| Foundation | Cordis, Loader, Include, Schemastery и необходимые peer dependencies |

Browser roster и desktop application не компилируются. Root web-handler Cockpit
делегирует cookie authorization исходному Connection service и не требует frontend
dist. Directory picker использует host browse backend. Второй LLM-провайдер pi-ai
удалён из композиции; DeepSeek model routes сохраняются. Разные закреплённые версии
external dependency доступны владельцам через внутренние относительные ссылки.

Статические зависимости проверяются TypeScript-компилятором. YAML plugin names,
presets и host references входят в closure. Восемь известных dynamic references
имеют точные выражения и причины в `tools/deepseek-build/dynamic-imports.json`;
новая неизвестная ссылка запрещает сборку. После компиляции проверяются generated
exports, worker bundles и native addon. Workspace package boundary сохраняется:
bundler не встраивает один общий native module в несколько пакетов.
Host-owned overlays явно добавляют Claude-compatible hooks и MCP client с их
зависимостями; один upstream YAML без overlays не определяет полный состав Cockpit.

## Подготовка и проверка

```bash
npm --prefix server run deepseek:prepare
npm --prefix server run deepseek:build
npm --prefix server run deepseek:verify
```

`prepare` и `build` — общая подготовка: сверяют входы готовой generation по manifest (без
исходников и сети), при изменении входов под lock подготавливают кэш исходников,
устанавливают exact зависимости по lock, собирают и атомарно выбирают новое поколение.
Брошенный после kill или Ctrl-C lock с мёртвым владельцем снимается сам. `verify`
собирает отдельный candidate и выполняет compiled loopback проверки без переключения
`current`. Первая подготовка требует сети (npm-пакеты сборки и, без копии, исходники);
дальше сборки идут offline. В `bin/cockpit` и `deploy/install.sh` сбой подготовки DeepSeek
не останавливает Cockpit: выводится предупреждение, карточка DeepSeek показывает
причину недоступности и команду исправления; `bin/release` и `bin/release-check` подготовку требуют. Нужны C compiler, Node
headers выбранного runtime и native prerequisites npm-пакетов. Для Linux sandbox
сохраняется требование работоспособного bubblewrap. Native flock использует stable
Node-API; остальные native dependencies остаются привязаны к ABI Node сборки.

Общий test helper создаёт один candidate под writer lock в `.state/artifacts/`,
переиспользует его только при совпадении всех входов и проверяет весь payload.
Отсутствующие зависимости дают отказ с командой подготовки; скрытого download/skip
нет. Homes и порты проверок изолированы. Тесты не меняют production `current`.

Generation содержит `entry.mjs`, `runtime.json`, собственные dependencies,
resources и licenses. Внутренние ссылки сохраняют работоспособность при переносе;
ссылки на server node_modules или staging запрещены. BuildId учитывает входы,
payload bytes и modes, платформу, архитектуру, major и ABI Node и native toolchain.
Патч-версия Node в него не входит. Сборка воспроизводима: комментарии бандлов содержат
пути от корня поколения, поэтому те же входы в любом каталоге дают тот же payload и
buildId (проверено двумя сборками и тестом на отсутствие путей staging). Изменение
входов во время сборки запрещает готовый candidate.

Проверки настоящего артефакта подтверждают `-V`, перенос в путь с пробелами, web
startup/cookie/settings RPC без ключа и prompt, а также ACP initialize со stdout
только для protocol frames. [Приватный settings-мост](deepseek-private-settings-bridge.md)
проверяется отдельно по CAS, readback, restart owner и `max_tokens` HTTP payload
обоих транспортов на loopback mock API. Публикация source snapshot запускает эти gates.
Production default — embedded; отсутствующая generation даёт отказ до prompt.
Доставка runtime при обновлении описана в [контракте публикации](../server/deepseek-release-transition.md).

Исходные MIT copyright и licenses сохранены. Native BSD и npm notices учитываются
отдельно; для libvips сохраняется опубликованная таблица лицензий и тексты LGPL/GPL.
Отсутствующий в npm-пакете xterm MIT-файл взят из его закреплённого commit;
происхождение и SHA-256 supplement находятся в `tools/deepseek-build/licenses/sources.json`.
