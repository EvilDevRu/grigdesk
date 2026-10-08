# Тесты и проверка

Веб-тесты на happy-dom, Playwright и ловушки, из-за которых тест врёт.

Читай перед правкой: `tests`.

## Грабли

- [Веб-тест монтирует SFC дважды — а работает со сторами первого теста](sfc-store-isolation.md)
- [Всплывашка открывается только в первом тесте файла = Vue запомнил document первого окна](vue-document-cache.md)
- [Модалка «не открылась» в веб-тесте = стаб Teleport работает только при NODE_ENV=test](teleport-test-environment.md)
- [Сторож, читающий текст задачи, ловит фикстуру, а не страницу](fixture-text-false-positives.md)
- [Тест прошёл по другой причине — правило не проверено вовсе](behavioral-test-coverage.md)
- [Новый импорт в экране валит весь его тест = подмена модуля не экспортирует это имя](view-stub-exports.md)
- [Однострочные пояснения функций прошли незамеченными = сторож читаемости видел только TS в web/](readability-guard-scope.md)
- [Упавший assert с узлом happy-dom съедает всю память — веб-тест запускай через сторож памяти](happy-dom-assert-memory.md)
- [Фоновый Bash может сделать проверку SIGINT ложно красной](background-sigint.md)
- [Playwright падает до первой спеки: в общем кэше нет ревизии chromium под версию проекта](playwright-browser-revision.md)
- [Перенаправленный XDG_CACHE_HOME прячет браузеры Playwright](playwright-xdg-cache.md)
- [Удалённый JS-файл валит снимок миграции, хотя код рабочий](migration-inventory-snapshot.md)
- [Настройки роняют вкладку headless-проверки = нужен полный Chromium](headless-shell-settings-crash.md)
