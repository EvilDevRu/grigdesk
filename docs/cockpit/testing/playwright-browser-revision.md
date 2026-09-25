# Playwright падает до первой спеки: в общем кэше нет ревизии chromium под версию проекта

Симптом: детерминированная проверка маршрута отдаёт «Playwright не прошёл», а в тексте —
`browserType.launch: Executable doesn't exist at ~/.cache/ms-playwright/chromium_headless_shell-<rev>/…`.
Ни одна спека при этом не выполнялась, `playwright-report/` пуст. В карточке узла это выглядит
как падение тестов задачи, хотя код задачи ни при чём — падает запуск браузера на setup-проекте.

Причина: кэш браузеров ОДИН на машину (`~/.cache/ms-playwright`), а ревизия сборки жёстко привязана
к версии `@playwright/test` в worktree. У fe <PROFILE> 1.59.1 → chromium **1217**. Рядом лежала только
**1234** — от более новой версии playwright из npx-кэша (её тянет MCP-браузер). Наличие «какого-то»
chromium в кэше не значит ничего: нужна ровно та ревизия, что просит версия проекта.

Как проверять, а не гадать:
- `npx playwright install --dry-run` из worktree печатает точные `Install location` для текущей версии —
  сверять построчно с содержимым кэша;
- сам бинарь проверяется прямым запуском `chrome-headless-shell --version` (каталог может существовать,
  а файл быть битым или отсутствовать);
- лечение — `npx playwright install chromium` из этого же worktree. Если в `playwright.config.ts`
  один проект chromium, firefox/webkit не нужны.

Воспроизводить проверку узла нужно профильным скриптом `profiles/<профиль>/e2e.sh <TASK> [спека]`:
он подставляет `E2E_BASE_URL`/`E2E_API_URL`/креды песочницы и запускает ровно то, что видит узел.
Голый `npx playwright test` поднимет свой `vite preview` на 4173 и проверит не тот фронт.

Вторая мина, найденная тем же заходом (fe <PROFILE>, 2026-09-10): `tests/e2e/auth.setup.ts` сохранял
storageState в `e2e/.auth/user.json`, а `playwright.config.ts` и `.gitignore` знали `tests/e2e/.auth/`.
Спеки молча шли со СТАРЫМ токеном — свежий setup до них не доезжал, — а в корне worktree заводился
untracked каталог `e2e/` с токеном мимо `.gitignore`. Протухни токен, и все chromium-спеки посыпались бы
на авторизации, что снова читалось бы как баг задачи. Исправлено приведением всех путей (setup, две
`test.use` в `positions-enrichment-pages.spec.ts`) к `tests/e2e/.auth/user.json`.
