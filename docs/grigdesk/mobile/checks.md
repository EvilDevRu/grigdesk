# Проверки приложения и посредника

Профильные тесты Android, посредника и серверных настроек запускаются через сторож
памяти. Общая регрессия проекта выполняется командой `tests/run-all.sh`.

```bash
NODE_TEST_MAX_RSS_MB=4096 bash tests/run-node-tests-safe.sh --test --test-concurrency=2 \
  tests/mobile/*.test.js tests/relay/*.test.js tests/server/mobile-*.test.js
tools/mobile check
```

`tools/mobile check` проверяет SDK и JDK, запускает мобильные Node-тесты и задачи Gradle
`:client:testDebugUnitTest` / `:client:lintDebug`. Подготовка среды описана в
[сборке Android](android-build.md). JVM-проверки проходят на заявленных JDK и SDK,
отсутствие которых может приводить к пропуску соответствующего теста.

Для ручной сверки карточек и диалога добавления используется
`node tests/mobile/visual/settings.mjs`. Нужны зависимости сервера, веба и desktop.
Путь к полному Chromium задаётся через `GRIGDESK_CHROMIUM`. Без него помощник ищет
доступный браузер Playwright. Сценарий запускает изолированный стенд с временными
ключами и сохраняет кадры и отчёт в `artifacts/mobile-remote/settings-visual/`
папки данных. Проверяются состояния связи, формы и геометрия в пяти размерах окна.

Сценарий V07 в `tests/web/e2e/settings-visual.e2e.mjs` открывает настройки
ретранслятора на странице «Доступ к серверу». Он проверяет пустые состояния
ретрансляторов и общего списка устройств.

Физическая установка, Keystore, биометрия, фоновый цикл, VPN-маршруты и крупный
системный шрифт требуют отдельной проверки на реальном устройстве.
