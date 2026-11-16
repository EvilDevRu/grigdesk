# CLI авторинга маршрутов

`bin/routes` — самостоятельный ELF Node SEA для Linux x64 с правами 0755.
Исходники находятся в `routes/src/app.ts` и `routes/src/main.ts`;
готовый ELF и `bin/.routes-*.tmp` игнорируются Git. До сборки команды в `bin/` нет.
Готовому файлу не нужны системный Node, node_modules и исходники. Он работает через тот же
авторизованный API, что редактор и панель проекта; JSON в stdout, диагностика в stderr.
Профиль уже должен существовать. Команда не создаёт profile.sh и не исполняет его.

## Сборка и установка

`npm --prefix routes run build` собирает `bin/routes` собственным входом сборки `routes/scripts/build.mts`:
общий протокол `shared/node/cliSeaBuild.ts`, Node 24.21.0 из закреплённого архива, сверка SHA256, esbuild, postject,
проверка версии с пустым окружением и атомарная публикация. Сборщик печатает размер и SHA256.
Пакет `routes/` владеет своим package.json, lock-файлом и build/node-runtime.json.
Поддерживаются `--out-dir` и `--cache-dir`; кэш по умолчанию — `routes/.cache/`.
Перед первой сборкой установите devDependencies пакета; системный Node нужен только для сборки.
`--help`, `--version` и `--license` доступны без сервера и токена. Лицензия Node включена
в SEA; `NODE_OPTIONS` не расширяет аргументы готового ELF.

Исходный вход до сборки: `node routes/src/main.ts …`.
`grigdesk-ctl build all` последовательно собирает tracker, pipeline и routes
в одной tasks-цепочке, каждый CLI из своего пакета. Исходный `deploy/install.sh` собирает CLI и создаёт ссылку
`~/.local/bin/routes`; отдельный повтор:
`bash deploy/lib/routes-cli.sh <корень-кода> <каталог-ссылок>`.
`--unit-only` и установка готового серверного ELF сборку не выполняют.
Обычный чужой файл вместо ссылки сохраняется. При окончательном отказе сборки прежняя ссылка
сохраняется, установщик печатает предупреждение и команду повтора.

Серверный компонент официальной поставки включает `bin/routes` с правами 0555,
размером и SHA256 в подписанной описи. Агенты получают bin текущего серверного поколения в PATH.
Исторический portable-комплект также включает ELF с правами 0755.
Новый файл в уже выбранную установку переносится вручную либо с новым проверенным выпуском.

## Подключение

Токен выбирается: `--token` → `GRIGDESK_CLI_TOKEN` → файл `--token-file` либо
`GRIGDESK_CLI_TOKEN_PATH` → `<GRIGDESK_HOME>/state/cli-token`; без GRIGDESK_HOME
папка данных — `~/.grigdesk`. Содержимое токена не включается в команды примеров.
Сервер получает `x-grigdesk-token`. Адрес: `--base` → непустой GRIGDESK_BASE_URL →
`http://127.0.0.1:$GRIGDESK_PORT`, порт по умолчанию 8140. `--timeout` задаёт мс,
по умолчанию 30000; таймаут распространяется на чтение тела ответа.

## Команды

| Команда после `bin/routes` | Действие |
|---|---|
| `list <профиль>` | Список черновиков |
| `show <профиль> --draft <id>` | Полный снимок черновика |
| `editor <профиль>` | Источник каталога и currentCatalogHash |
| `source <профиль> --mode editor --expected-source-revision <N> --expected-catalog-hash <hash\|none> --yes` | Явная смена владельца; второй режим profile-script |
| `new <профиль> --from empty --title <название>` | Пустой черновик; по умолчанию from=catalog копирует прочитанный current |
| `apply <профиль> --draft <id> --file <JSON> --expected-revision <N>` | Полная замена авторского контента одним PATCH |
| `validate <профиль> --draft <id> --expected-revision <N>` | Отчёт проверки; exit 0 ещё не разрешает публикацию |
| `publish <профиль> --draft <id> --expected-revision <N> --expected-source-revision <N> --expected-catalog-hash <hash\|none> --yes` | Публикация прочитанного снимка |
| `publications <профиль> <operationId>` | Сохранённый receipt публикации |
| `rollback <профиль> --hash <hash> --expected-source-revision <N> --expected-catalog-hash <hash\|none> --yes` | Копия сохранённого каталога и штатная публикация |
| `export <профиль> --draft <id>` | Версионированный transfer bundle |
| `import <профиль> --file <JSON> --title <название>` | Новый черновик из transfer bundle |
| `profile-config get <профиль>` | Литеральные metadata, runners и capabilities |
| `profile-config set <профиль> --file profile.sh --set NAME=VALUE` | CAS-пакет переменных; `--set` повторяется, dashboard.env также поддержан |

## Исходные ожидания и полный apply

Сначала `editor`; при необходимости отдельный `source --yes` с прочитанными source/current.
Затем `new`, `show` в файл, редактирование и `apply --expected-revision N` с ревизией этого
снимка. JSON содержит все пять полей: routes, bootstrap, bootstrapPrompts, presentation,
provenance. Допустим полный show; служебные id/revision/title/state не записываются.
Отсутствующие поля — ошибка использования, отсутствующие в routes маршруты удаляются.
Полная замена 64 непересекающихся маршрутов занимает 131 операцию и один CAS PATCH;
пределы размера запросов и количества маршрутов сохраняются.

После apply используйте фактически возвращённую ревизию в validate. Проверьте issues и
severity: HTTP-отчёт с exit 0 может содержать ошибки, coordinator не опубликует такой маршрут.
Заново прочитайте editor, сопоставьте source/current, затем publish --yes с ревизией
проверенного черновика. При 409 сопоставьте обе версии, не повышайте ожидания автоматически.

Пример (ID, ревизии и хеши подставляются только из прочитанных ответов):

```bash
bin/routes editor <профиль>
bin/routes new <профиль> --from empty --title "Новый каталог"
bin/routes show <профиль> --draft <id> > document.json
# Изменить document.json, сохранив все пять полей контента.
bin/routes apply <профиль> --draft <id> --file document.json --expected-revision <N>
bin/routes validate <профиль> --draft <id> --expected-revision <новая-ревизия>
bin/routes editor <профиль>
bin/routes publish <профиль> --draft <id> --expected-revision <новая-ревизия> \
  --expected-source-revision <source-revision> --expected-catalog-hash <hash-или-none> --yes
```

## Потерянный ответ и откат

До POST publish/rollback stderr получает JSON-hint с operationId/draftId/recovery.
При сетевом обрыве исход неизвестен: выполните publications из recovery с прежними
--base и токеном. Не повторяйте мутацию автоматически. Receipt.state=committed относится
к этой операции, даже если current впоследствии изменился. При потере ответа создания
rollback-копии проверьте list перед новым действием; копия могла сохраниться.
Откат создаёт и публикует отдельный черновик, не меняя пины текущих попыток.

## Конфигурация профиля

```bash
bin/routes profile-config get <профиль>
bin/routes profile-config set <профиль> --file profile.sh \
  --set PROFILE_LOOP_MAX_ROUNDS=40 --set PROFILE_TRIAGE_MARKERS="миграции, API"
```

set читает актуальный config и отправляет from каждой переменной, включая null для
разрешённого отсутствующего metadata. Readonly не трактуется как отсутствие. Динамические,
неоднозначные и неизвестные поля не записываются; Bash не редактируется произвольно.
[Границы профиля](project-profiles.md) описывают whitelist, recheck и частичные engine-операции.

| Exit | Значение |
|---|---|
| 0 | Получен успешный HTTP-ответ; у validate проверяйте issues/severity |
| 1 | Ошибка использования, файла или обязательного подтверждения |
| 2 | HTTP 404 |
| 3 | Сеть/таймаут; исход мутации может быть неизвестен |
| 4 | HTTP 409 либо устаревший снимок apply |
| 5 | Прочий отказ сервера или выполнения команды |

Проверки выполнялись на изолированных HTTP/engine-фикстурах. Живой цикл публикации и
запись профиля после ручного перезапуска сервера ещё требуют приёмки.
