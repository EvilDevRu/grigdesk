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
// объявлен в `lib/nodeVersion.ts` и `bin/lib/runtime-env.sh`; все три пинует
// `tests/docs/entrypoint-launch.test.mts`, чтобы предела правды не стало два.
const MIN_NODE_VERSION = '22.18.0';

const parts = (value) => value.replace(/^v/, '').split('-')[0].split('.').map(Number);

const [major, minor, patch] = parts(process.versions.node);
const [needMajor, needMinor, needPatch] = parts(MIN_NODE_VERSION);

if (major < needMajor
  || (major === needMajor && minor < needMinor)
  || (major === needMajor && minor === needMinor && patch < needPatch)) {
  process.stderr.write(
    `Cockpit требует Node ${MIN_NODE_VERSION} или новее, запущен ${process.versions.node}. `
    + 'С 22.18 Node исполняет TypeScript сам, без флагов; на более старой версии сервер '
    + 'не стартует. Обнови Node (nvm install 22.18.0) и повтори запуск.\n',
  );
  process.exit(1);
}

await import('./app.ts');
