# Просмотр документов

В Cockpit есть встроенный read-only предпросмотрщик текстовых документов. Он открывает
`.md`, `.markdown` и `.txt` с сервера Cockpit в браузере, в том числе на планшете.

Это **core-модуль, не плагин**:

- сервер явно регистрирует `modules/documents` в `app.js`;
- модуль не входит в реестр плагинов, не имеет manifest/toggle и не добавляет пункт навигации;
- web-ядро `features/documents/DocumentPanel.vue` можно встроить в другую оболочку;
- `/documents` — скрытый lazy route для открытия ссылок;
- содержимое не копируется в историю чатов, prefs, localStorage или отдельную базу.

## Ссылка и источники

Постоянный адрес использует не абсолютный путь хоста, а `DocumentRef`:

```text
{ source: "cockpit", path: "docs/cockpit/kimi-integration-plan.md" }
```

Ему соответствует route:

```text
#/documents?source=cockpit&path=docs%2Fcockpit%2Fkimi-integration-plan.md
```

Старые ответы агентов уже содержат ссылки вида `/home/.../file.md`. Chat renderer превращает
такую ссылку во временный route с параметром `open`. Fragment не отправляется HTTP-серверу,
а `POST /api/documents/resolve` проверяет путь без записи его в access-log query и возвращает
`DocumentRef`. Затем браузер делает `router.replace()` и убирает абсолютный путь из адреса.
Сам `GET /api/documents/file` принимает только `source + относительный path`.

Ссылка с суффиксом `:42` открывает точную строку в нумерованном исходнике. Для Markdown
можно переключаться между исходником и отрендеренным предпросмотром.

Первый источник `cockpit` подключён в `server/src/app.js` и указывает на `config.rootDir`.
Следующие источники добавляются через `DocumentReader.addRootProvider()` либо массив
`rootProviders` при сборке приложения. Сам reader не импортирует проекты, чаты или Factory.

## Граница безопасности

API находится за общим auth-гардом и дополнительно применяет файловые ограничения:

- источник обязан быть зарегистрирован сервером;
- разрешены только относительные пути внутри источника;
- root и целевой путь проверяются через realpath, на Linux происхождение открытого file
  descriptor повторно сверяется через `/proc/self/fd`;
- выход через `..` или symlink за пределы root запрещён, конфликтующие source id закрываются отказом;
- читаются только обычные `.md`/`.markdown`/`.txt` файлы;
- максимум — 1,5 МБ, только валидный UTF-8 без NUL;
- ответ помечен `Cache-Control: private, no-store`;
- raw HTML в Markdown экранирует общий `shared/md.js`.

Относительные ссылки на другие текстовые документы остаются внутри того же source. HTTP(S) и
mailto-ссылки продолжают открываться как внешние. Предпросмотрщик ничего не редактирует,
не перечисляет каталоги и не индексирует содержимое.

## Проверка

- `tests/server/documents-reader.test.js` — providers, конфликты roots, realpath/symlink,
  тип/размер/UTF-8 и HTTP;
- `tests/web/documents-links.test.js` — абсолютный bridge, стабильные refs, относительные ссылки
  и повторная проверка URL Markdown-рендерером;
- `npm --prefix web run build` — компиляция lazy route и Vue-компонента.
