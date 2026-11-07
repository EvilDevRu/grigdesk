import assert from 'node:assert/strict';
import {
  promises as fs
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fileURLToPath
} from 'node:url';
import test from 'node:test';

import {
  routeLaunchEnv,
  spawnRouteEngine
} from '../../server/src/lib/factoryRouteCli.ts';
import {
  waitFor
} from './helpers/chat-turns.js';

const AUTH_MODULE = fileURLToPath(new URL('../../server/src/lib/gigacode/auth.ts', import.meta.url));

test('в комплекте сервера конвейер не получает node для раннера GigaCode', () => {
  const source = routeLaunchEnv({
    rootDir: '/opt/grigdesk'
  });
  const packaged = routeLaunchEnv({
    rootDir: '/opt/grigdesk',
    gigacodePackaged: true
  });

  assert.equal(source.GRIGDESK_GIGACODE_NODE_BIN, process.execPath);
  assert.equal(Object.hasOwn(packaged, 'GRIGDESK_GIGACODE_NODE_BIN'), false);
  assert.equal(packaged.GRIGDESK_DEEPSEEK_NODE_BIN, process.execPath);
});

for (const systemd of [true, false]) {
  test(`native OAuth и пути с пробелами доходят в реальный child, systemd=${systemd}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'giga launch spaces '));
    const bin = path.join(root, 'bin');
    const native = path.join(root, 'native home');
    const childResult = path.join(root, 'child.json');
    const systemdLog = path.join(root, 'systemd.json');
    const originalPath = process.env.PATH;

    t.after(async () => {
      process.env.PATH = originalPath;
      await fs.rm(root, {
        recursive: true,
        force: true
      });
    });
    await fs.mkdir(bin);
    await fs.mkdir(native);
    await fs.writeFile(path.join(native, 'gigacode_token.json'), JSON.stringify({
      token: 'synthetic-detached-native-token',
      expiryDate: Date.now() + 3600000,
    }), {
      mode: 0o600
    });

    const factoryBin = path.join(bin, 'fake-factory');

    await fs.writeFile(factoryBin, `#!${process.execPath}
      import { writeFileSync } from 'node:fs';
      import { readGigaCodeCredentialSnapshot } from ${JSON.stringify(AUTH_MODULE)};
      const names = ['GRIGDESK_GIGACODE_BIN', 'GRIGDESK_GIGACODE_HOME',
        'GRIGDESK_GIGACODE_RUNTIME_HOME', 'GRIGDESK_GIGACODE_BWRAP_BIN'];
      const config = { gigacodeHome: process.env.GRIGDESK_GIGACODE_HOME };
      const credential = await readGigaCodeCredentialSnapshot(config);
      writeFileSync(${JSON.stringify(childResult)}, JSON.stringify({
        env: Object.fromEntries(names.map(name => [name, process.env[name] || null])),
        available: Boolean(credential),
      }));
    `, {
      mode: 0o755
    });
    await fs.writeFile(path.join(bin, 'systemd-run'), `#!${process.execPath}
      import { spawnSync } from 'node:child_process';
      import { readFileSync, writeFileSync, statSync } from 'node:fs';
      if (process.argv.includes('--version')) process.exit(${systemd ? 0 : 1});
      const args = process.argv.slice(2);
      const env = {};
      let environmentFileMode = null;
      let commandAt = -1;
      for (const [index, value] of args.entries()) {
        if (value.startsWith('--setenv=')) {
          const pair = value.slice(9); const split = pair.indexOf('=');
          env[pair.slice(0, split)] = pair.slice(split + 1);
        } else if (value.startsWith('--property=EnvironmentFile=')) {
          const file = value.slice('--property=EnvironmentFile='.length);
          environmentFileMode = statSync(file).mode & 0o777;
          for (const line of readFileSync(file, 'utf8').split('\\n').filter(Boolean)) {
            const split = line.indexOf('=');
            env[line.slice(0, split)] = JSON.parse(line.slice(split + 1));
          }
        } else if (value === ${JSON.stringify(factoryBin)}) commandAt = index;
      }
      writeFileSync(${JSON.stringify(systemdLog)}, JSON.stringify({ args, environmentFileMode }));
      if (commandAt < 0) process.exit(97);
      const result = spawnSync(args[commandAt], args.slice(commandAt + 1), { env });
      process.exit(result.status || 0);
    `, {
      mode: 0o755
    });
    process.env.PATH = `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`;

    const config = {
      rootDir: root,
      factoryBin,
      factoryHome: path.join(root, 'engine'),
      profilesDir: path.join(root, 'profiles'),
      stateDir: path.join(root, 'state'),
      factoryConfigRoot: path.join(root, 'config'),
      gigacodeBin: path.join(root, 'cli with spaces'),
      gigacodeHome: native,
      gigacodeRuntimeHome: path.join(root, 'runtime home'),
      gigacodeBwrapBin: '/usr/bin/bwrap',
    };
    const result = await spawnRouteEngine(config, {
      task: 42,
      args: ['synthetic']
    });

    assert.equal(result.ok, true, result.message);
    await waitFor(() => fs.access(childResult).then(() => true, () => false), {
      what: 'child env'
    });

    const child = JSON.parse(await fs.readFile(childResult, 'utf8'));

    assert.equal(child.available, true);
    assert.deepEqual(Object.values(child.env), [config.gigacodeBin, native,
      config.gigacodeRuntimeHome, config.gigacodeBwrapBin
    ]);
    assert.doesNotMatch(JSON.stringify(child), /synthetic-detached-native-token/u);

    if (systemd) {
      assert.doesNotMatch(await fs.readFile(systemdLog, 'utf8'),
        /synthetic-detached-native-token/u);
    }

    assert.match(await fs.readFile(path.join(native, 'gigacode_token.json'), 'utf8'),
      /synthetic-detached-native-token/u);
  });
}
