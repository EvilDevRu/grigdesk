// Лаунчер установленного юнита. Настоящая сборка сервера живёт в `app.ts`.
//
// Файл существует ровно потому, что `ExecStart` уже установленного на машине юнита
// называет это имя, а перерисовать юнит может только человек (`deploy/install.sh`).
// Пока этого не произошло, переименование `app.ts` оборвало бы запуск сервиса.
// Снимается вместе с остальными shim-ами после подтверждённого перезапуска.
//
// Проверка версии стоит ЗДЕСЬ и написана на голом JavaScript намеренно. Импорт `.ts`
// на Node ниже 22.18 падает на разрешении модуля — до первой строки кода, — и человек
// получил бы «unknown file extension» вместо ответа «нужен Node новее». Тот же минимум
// объявлен в `lib/nodeVersion.ts` и `deploy/lib/runtime-env.sh`; все три пинует
// `tests/docs/entrypoint-launch.test.mts`, чтобы предела правды не стало два.
const MIN_NODE_VERSION = '22.19.0';

const parts = (value) => value.replace(/^v/, '').split('-')[0].split('.').map(Number);

const [major, minor, patch] = parts(process.versions.node);
const [needMajor, needMinor, needPatch] = parts(MIN_NODE_VERSION);

if (major === 23 || major < needMajor
  || (major === needMajor && minor < needMinor)
  || (major === needMajor && minor === needMinor && patch < needPatch)) {
  process.stderr.write(
    `GrigDesk требует Node ^${MIN_NODE_VERSION} || >=24.0.0, запущен ${process.versions.node}. `
    + `Обнови Node (nvm install ${MIN_NODE_VERSION}) и повтори запуск.\n`,
  );
  process.exit(1);
}

await import('./app.ts');
