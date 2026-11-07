// Минимальная SEA-фикстура механизма: внешний Fastify, файловый require,
// внешний ESM bridge с относительным импортом и top-level await, вложенный Node.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as sea from 'node:sea';
import fastify from 'fastify';

const out = process.env.PROBE_OUT;
const R = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
const report = {
  execPath: process.execPath,
  argv: process.argv,
  cwd: process.cwd(),
  R,
  isSea: sea.isSea(),
};

// Поднимает настоящий Fastify из SEA и проверяет внешний bridge и вложенный Node.
// Результат пишет в отдельный каталог пробы; SIGTERM дожидается закрытия HTTP.
async function main() {
  const fileRequire = createRequire(path.join(R, 'server', 'package.json'));

  report.packageJson = fs.existsSync(path.join(R, 'server', 'package.json'));
  report.fastifyResolvedFrom = fileRequire.resolve('fastify');

  const bridge = fileRequire(path.join(R, 'server', 'runtime', 'esmBridge.cjs'));
  const pluginUrl = pathToFileURL(path.join(R, 'plugin ext', 'index.mjs')).href;
  const plugin = await bridge.importUrl(pluginUrl);

  report.bridgeMarker = `${typeof plugin.default} ${plugin.marker}`;

  const app = fastify();

  app.get('/ping', async () => ({ ok: true }));
  await app.register(plugin.default);
  await app.listen({
    host: '127.0.0.1',
    port: 0
  });

  const port = app.server.address().port;

  report.httpPing = await (await fetch(`http://127.0.0.1:${port}/ping`)).text();
  report.httpPlugin = await (await fetch(`http://127.0.0.1:${port}/plugin`)).text();

  const helper = spawnSync(path.join(R, 'runtime', 'node', 'bin', 'node'), [
    path.join(R, 'server', 'runtime', 'helpers', 'hello.mjs'), 'a b', '',
  ], {
    cwd: '/',
    encoding: 'utf8',
    env: {
      PATH: '/nonexistent'
    },
  });

  report.helper = {
    status: helper.status,
    stdout: helper.stdout?.trim() ?? '',
    stderr: helper.stderr?.trim() ?? '',
  };

  process.on('SIGTERM', async () => {
    await app.close();
    fs.writeFileSync(path.join(out, 'sigterm.txt'), 'closed\n');
    process.exit(0);
  });

  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write('READY\n');
}

main().catch((error) => {
  process.stderr.write(`FAIL ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
