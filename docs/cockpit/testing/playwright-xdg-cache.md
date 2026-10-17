# Перенаправленный XDG_CACHE_HOME прячет браузеры Playwright

Если `XDG_CACHE_HOME` указывает на другой каталог (так делают для песочницы, где `$HOME`
только для чтения), Playwright ищет браузеры и ffmpeg не в `~/.cache/ms-playwright`, а в
`$XDG_CACHE_HOME/ms-playwright`. Тесты записи плагина «Презентации» (`tests/server/showcase-*`)
падают в `run-all` на `browserContext.newPage: Executable doesn't exist at
…/ms-playwright/ffmpeg-<rev>/ffmpeg-linux`, хотя код и установка в порядке.

Проверено: с одним перенаправленным `XDG_CACHE_HOME` `showcase-record-smoke.test.js` падает,
а с добавленным `PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright` проходит. Без
перенаправления все четыре файла `showcase-record-*`/`showcase-rehearsal` зелёные.

Что делать: если перенаправляешь `XDG_CACHE_HOME`, задавай рядом `PLAYWRIGHT_BROWSERS_PATH`
на общий кэш браузеров (читать его можно и при `$HOME` только для чтения). Отказ с этим
текстом — окружение, не регрессия; браузеры ради него не доустанавливай.

Обёртка Electron-проверок `tests/desktop/e2e/isolated-session.sh` подменяет HOME и XDG и
поэтому задаёт `PLAYWRIGHT_BROWSERS_PATH` сама; это держит `tests/desktop/e2e/isolation.test.mjs`.
