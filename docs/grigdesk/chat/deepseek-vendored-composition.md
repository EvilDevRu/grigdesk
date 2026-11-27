# Состав host runtime DeepSeek


Выбранные исходники Harness `0.2.3-alpha.2` закреплены commit
`4b399c39a6d1479cd84ca591b4d7c88e24d38a96`. Сборка использует upstream host-проекты,
закреплённый TypeScript, Typert generator и отдельный npm lock. Проверен Linux x64
с glibc и worker Node 24.22.3. Нативная приёмка остальных платформ выполняется отдельно.

Состав записан в `composition.json`, а лицензии 577 workspace/npm-позиций
проверенной поставки в `licenses/index.json`. Патчи включают GLM-5.4 и
совместимость чата и настроек с GrigDesk. Office использует fontkitten,
HTTP(S) proxy работает через закреплённые proxy agents. В Git лежат manifest,
патчи и лицензии. [Подготовка исходного снимка](deepseek-source-snapshot.md)

## Композиция

| Часть | Сохранённое поведение |
|---|---|
| Base | Agent loop, session, persistence и миграции журналов, settings, credentials, tools |
| Web host | Loopback URL, штатный обмен process token на cookie, RPC envelopes, event transport |
| ACP | JSON-RPC stdio, initialize, session controls и MCP |
| Настройки | Settings service, private settings-file document, controller и приватный ACP мост |
| Инструменты | Filesystem, shell, sandbox, hooks, MCP и ресурсы shipped agent presets |
| Foundation | Cordis, Loader, Include, Schemastery и необходимые peer dependencies |

Browser roster и desktop application не компилируются. Root web-handler GrigDesk
делегирует cookie authorization исходному Connection service и не требует frontend
dist. Directory picker использует host browse backend. Плагин `llm-pi-ai` с
библиотекой pi-ai входит в generation как host overlay, но его строка исключена из
base YAML: процесс DeepSeek pi-ai не загружает (проверено регистратором загрузок
настоящего процесса), монтирует его только GLM-overlay. DeepSeek model routes сохраняются. Разные закреплённые версии
external dependency доступны владельцам через внутренние относительные ссылки.

Статические зависимости проверяются TypeScript-компилятором. YAML plugin names,
presets и host references входят в closure. Разрешённые dynamic references имеют точные выражения и причины в
`deepseek/build/dynamic-imports.json`;
новая неизвестная ссылка запрещает сборку. После компиляции проверяются generated
exports, worker bundles и native addon. Workspace package boundary сохраняется:
bundler не встраивает один общий native module в несколько пакетов.
Host-owned overlays явно добавляют Claude-compatible hooks и MCP client с их
зависимостями; один upstream YAML без overlays не определяет полный состав GrigDesk.

Worker bundles включают code-runtime, workflow и JSONL migration verifier
`session-persistence-jsonl/lib/worker.cjs`. Последний нужен при чтении исторических журналов;
его отсутствие не обнаруживается одним запуском новой сессии.

## Подготовка и проверка

Владелец source/build цепочки — пакет `deepseek/`. Чистый checkout требует явной
подготовки pinned Node dependencies и snapshot, затем сборки ELF:
[README пакета](../../../deepseek/README.md). Production default — `bin/deepseek`;
обычная подготовка и обновление GrigDesk только проверяют metadata установленного ELF.
Они не устанавливают npm dependencies Harness и не переключают legacy current.

Generation собирается закреплённым worker Node из `deepseek/build/node-runtime.json`.
ABI сверяется с worker, а не с Node сервера. Нужны C compiler и системные native prerequisites;
инструменты по-прежнему требуют работоспособного bubblewrap и shell. Source closure,
dynamic imports, worker bundles, native modules и лицензии проверяются до упаковки.
[Общие и SEA гейты](../testing/deepseek-test-gates.md) используют настоящий ELF.

Test helper держит проверенный candidate и A/B варианты в артефактах, готовит их
последовательно перед parallel группами. Отсутствующие pinned dependencies дают команду
подготовки; скрытого download/skip нет. Homes и порты изолированы, production current не меняется.

Generation содержит `entry.mjs`, `runtime.json`, собственные dependencies,
resources и licenses. При наличии исходников `llm-pi-ai` контракт `runtime.json`
получает поле `llmPiAi`: версия и integrity pi-ai из lock сборки, хэш исходников
плагина (файлы manifest без `tsconfig*.json`, которые сборка переписывает) и патчи
GrigDesk. Поле входит в `inputIdentity.contract`, поэтому защищено buildId; поколение
без плагина поля не имеет. Внутренние ссылки сохраняют работоспособность при переносе;
ссылки на server node_modules или staging запрещены. BuildId учитывает входы,
payload bytes и modes, платформу, архитектуру, major и ABI Node и native toolchain.
Патч-версия Node в него не входит. Комментарии бандлов содержат пути от корня поколения. Служебные `.tsbuildinfo`
могут учитывать пути компилятора и менять buildId при переносе; их hashes остаются
частью полного integrity manifest. Защищённые lock, патчи и GLM compatibility от этого
не меняются: [identity сборки](deepseek-build-identity.md). Изменение
входов во время сборки запрещает готовый candidate.

Проверки настоящего артефакта подтверждают `-V`, перенос в путь с пробелами, web
startup/cookie/settings RPC без ключа и prompt, а также ACP initialize со stdout
только для protocol frames. [Приватный settings-мост](deepseek-private-settings-bridge.md)
проверяется отдельно по CAS, readback, restart owner и `max_tokens` HTTP payload
обоих транспортов на loopback mock API. Публикация source snapshot запускает эти gates.
Отсутствующий ELF даёт отказ до prompt. Независимые установка и откат описаны
в [контракте поставки](deepseek-binary.md).

Исходные MIT copyright и licenses сохранены. Native BSD и npm notices учитываются
отдельно; для libvips сохраняется опубликованная таблица лицензий и тексты LGPL/GPL.
Отсутствующий в npm-пакете xterm MIT-файл взят из его закреплённого commit;
происхождение и SHA-256 supplement находятся в `deepseek/build/licenses/sources.json`.
