// Минимальный SEA-хост: внешний bridge комплекта грузит ESM-плагин из D/plugins.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as sea from 'node:sea';
import fastify from 'fastify';

const out = process.env.PROBE_OUT;
const R = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
const report = {
  isSea: sea.isSea(),
  R,
};

// Загружает пользовательский ESM-плагин через файловый bridge готового комплекта.
// Настоящий HTTP-ответ и штатный SIGTERM доказывают полный цикл этой пробы.
async function main() {
  const fileRequire = createRequire(path.join(R, 'server', 'package.json'));
  const bridge = fileRequire(path.join(R, 'server', 'runtime', 'esmBridge.cjs'));
  const entry = process.env.PROBE_ENTRY || 'server.js';
  const pluginUrl = pathToFileURL(path.join(R, 'plugins', 'demo plugin', entry)).href;
  const plugin = await bridge.importUrl(pluginUrl);

  report.relative = plugin.value;
  report.marker = plugin.marker;

  const app = fastify();

  await app.register(plugin.default);
  await app.listen({
    host: '127.0.0.1',
    port: 0
  });

  const port = app.server.address().port;

  report.http = await (await fetch(`http://127.0.0.1:${port}/plugin`)).text();

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
