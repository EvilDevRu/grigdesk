# Проверки приложения и посредника

**Совместимость с прежним v1.** Этот документ относится к отдельному клиенту `:app`
и его инструментам. Полное приложение `:client` описано в [контракте клиента](client-app.md).

Базовый набор — contract/unit/UI/relay/server проверки общего `tests/run-all.sh`.
Отдельные мобильные тесты запускаются через memory guard:

```bash
NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh --test --test-concurrency=2 \
  tests/mobile/*.test.js tests/relay/*.test.js tests/server/mobile-*.test.js
npm --prefix mobile run visual -- --self-check
npm --prefix mobile run visual
node tools/mobile-phone/e2e-local.mts
node tools/mobile-phone/e2e-local.mts --browser
node tests/mobile/visual/settings.mjs
tools/mobile check
```

Visual/E2E требуют установленный полный Chromium. Его путь можно явно передать через
`GRIGDESK_CHROMIUM`; иначе проверка ищет собственный доступный кэш Playwright.
Стенды используют временные ключи и изолированный настоящий GrigDesk; LLM, портал и CLI —
синтетические внешние зависимости. Пользовательские процессы, переписка и VPN не трогаются.

## Матрица окна

| Имя | CSS px |
| --- | --- |
| phone-xs | 320×568 |
| phone-s | 360×640 |
| phone-m | 360×800 |
| phone-l | 390×844 |
| phone-xl | 412×915 |
| phone-xxl | 430×932 |
| phone-land | 800×360 |
| phone-land-l | 915×412 |
| tablet-port | 800×1280 |
| tablet-land | 1280×800 |
| pad-port | 853×1280 |
| pad-land | 1280×853 |
| pad7-port | 776×1163 |
| pad7-land | 1163×776 |

51 сценарий × 14 размеров × корневой шрифт 100/130% дают 1428 кадров. DPR 2,
touch/mobile context. Реальные размеры планшета сверяются на устройстве по строке
«Размер окна» блока «Настройки → Диагностика»; при расхождении матрица дополняется фактическим размером.
Строки `pad7-*` — так измеренное окно планшета с DPR 2.75 при системном шрифте 100%.

Правила кадра: нет горизонтальной прокрутки, controls минимум 44×44 CSS px и внутри
ширины окна, нет перекрытия controls и молчаливого обрезания текста, нижняя панель
не закрывает последнее содержимое, диалог целиком доступен, изображения помещаются
в контейнер, нет пустого экрана/pageerror/console.error. Длинный код прокручивается
в собственном контейнере. Self-check проверяет четыре нарочных нарушения и чистый кадр.
Для отмеченных `data-touch-density="compact"` controls планшетного чата минимум — 28 px.
Исключение не действует на телефоне или в общих диалогах: [плотность](chat-controls.md).

Колонки прокручиваются сами ([раскладка](layout.md)), поэтому дополнительные проходы
проверяют начало и конец каждого контейнера, включая тело диалога. Перекрытие считается по видимой части
контрола: строка, уехавшая под шапку, обрезана своим контейнером и пальцу недоступна.
При доводке экрана матрицу сужают: `--only chat-long,tasks --sizes phone-m,pad7-land`;
приёмка — прогон без фильтров.
Аргумент `--output ~/.grigdesk/artifacts/<каталог>` сохраняет отдельный отчёт доводки,
не перезаписывая результаты полной матрицы.

Отчёты и PNG — `~/.grigdesk/artifacts/mobile-remote/visual/`; настройки GrigDesk —
`~/.grigdesk/artifacts/mobile-remote/settings-visual/`. Сквозной отчёт —
`~/.grigdesk/artifacts/mobile-remote/e2e/report.md`; browser путь использует phone-m,
phone-xl, tablet-port со шрифтом 100/130% и кадры отдельных шагов.

## Предел автоматической приёмки

E2E проверяет два TLS, pair, историю, вопросы, SSE/media, idempotency и операции,
watchdog relay, аварийный перезапуск собственного GrigDesk, отзыв и неверный pin.
Docker-вариант касается только собственного compose project; отсутствие daemon или
недоступная загрузка официального образа отмечаются NOT RUN с причиной.
Реальные ошибки assertions/контейнера остаются FAIL.

Native JVM проверяет настоящий OkHttp/forwarder/relay/Node TLS, в том числе более 90 секунд
idle, оба неправильных pin, смену поколения и deadline. APK/lint выполняются отдельно от
общей регрессии. Физический Keystore/биометрия, фоновый lifecycle, установка, реальные
VPN-маршруты и крупный системный шрифт требуют проверки на устройстве.
