# Авторизация Kimi: официальный и scoped credential

Проверка «авторизован ли Kimi» и contained-песочница опираются на файл в
`<kimiHome>/credentials/`. Содержимое файла GrigDesk не читает, не копирует в лог и не
показывает; самой авторизацией владеет `kimi login`.

CLI пишет два вида слотов:

- `kimi-code.json` — официальный слот обычного `kimi login`;
- `kimi-code-env-<hex>.json` — scoped-слот входа через кастомное OAuth-окружение
  (свой `oauth_host` в `config.toml`, нестандартный регион). Имя суффикса — hex-хеш
  окружения.

Оба варианта означают «авторизован». Выбор файла — общий `findKimiCredentialFile`
(`server/src/lib/kimi/credentials.ts`): официальный слот важнее, несколько scoped
выбираются по имени; похожие имена (`.bak`, каталоги, не-hex суффикс) не подходят.

Карточка исполнителя (`server/src/lib/executors/kimi.ts`) по найденному файлу показывает
«CLI хоста (kimi login)», иначе «не авторизован (kimi login)». Contained-режим
(`server/src/lib/kimi/sandbox.ts`, `assertPrivateCredentialDir`) применяет к найденному
файлу прежние границы: не ссылка, владелец — процесс сервера, права 0600, внутри home;
каталог credentials целиком монтируется в sandbox, поэтому scoped-файл доступен процессу
чата без переименования.

Проверки: `tests/server/kimi-provider.test.js` (setup-карточка, scoped-слот, приоритет
официального), `tests/server/kimi-security.test.js` (границы песочницы).
