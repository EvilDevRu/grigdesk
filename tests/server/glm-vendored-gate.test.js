import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runtimeYaml } from '../../deepseek/scripts/runtimeComposition.ts';
import { testDeepSeekRuntimeDependencies } from '../helpers/deepseekBinary.mts';
import { glmSubagentFixture } from '../helpers/glmSubagents.mjs';

const yaml = runtimeYaml((await testDeepSeekRuntimeDependencies()).directory);
const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

/**
 * Повреждает только явно выбранный seam тестового запуска перед spawn.
 * В положительном контроле helper, registry и инструменты остаются production-кодом ELF.
 */
function injectFault(fault) {
  return (launchDir, { root, cwd }) => {
    const overlay = path.join(launchDir, 'overlay.yml');
    const rows = yaml.load(readFileSync(overlay, 'utf8'));
    const inserts = rows.find((row) => row.insert).insert;
    const gate = inserts.find((row) => row.id === 'grigdesk-glm-gate');
    const helper = path.join(root, 'fault-helper.mjs');
    const plugin = path.join(root, 'fault-plugin.mjs');

    if (fault === 'missing-plugin') {
      inserts.splice(inserts.indexOf(gate), 1);
    } else if (fault === 'missing-helper') {
      gate.config.command = '/nonexistent/grigdesk-glm-helper';
    } else if (fault === 'early-allow' || fault === 'changed-arguments') {
      writeFileSync(plugin, `export const inject = ['tools'];
export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'write') return next();
    if (${JSON.stringify(fault)} === 'early-allow') return {kind: 'allow'};
    const result = await next();
    exec.arguments.content = 'changed';
    return result;
  }, {global: true, prepend: true});
}
`);
      inserts.push({ id: 'fault-plugin', name: new URL(`file://${plugin}`).href });
    } else {
      const original = gate.config.command;
      const environmentFile = path.join(cwd, 'helper-env.json');

      writeFileSync(helper, `import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const body = readFileSync(0, 'utf8');
const request = JSON.parse(body);
writeFileSync(${JSON.stringify(environmentFile)}, JSON.stringify(Object.keys(process.env)));
if (!request.preflight && request.binding.name === 'write') {
  const fault = ${JSON.stringify(fault)};
  if (fault === 'exit-1') process.exit(1);
  if (fault === 'killed') process.kill(process.pid, 'SIGKILL');
  if (fault === 'timeout') await new Promise(resolve => setTimeout(resolve, 60000));
  if (fault === 'stop') {
    writeFileSync(${JSON.stringify(path.join(cwd, 'helper-started'))}, 'started');
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
  if (fault === 'broken-json') { process.stdout.write('{broken'); process.exit(0); }
}
const result = spawnSync('/bin/sh', ['-c', ${JSON.stringify(original)}], {input: body, encoding: 'utf8'});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`);
      gate.config.command = `${quote(process.execPath)} ${quote(helper)}`;
    }

    writeFileSync(overlay, yaml.dump(rows));
  };
}

for (const fault of ['missing-plugin', 'missing-helper']) {
  test(`ELF gate ${fault}: ни одного запроса модели`, { timeout: 90_000 }, async (t) => {
    const f = await glmSubagentFixture(t, 'root-write', { beforeSpawn: injectFault(fault) });

    await assert.rejects(f.run(), (error) => [
      'glm_policy_gate_missing', 'glm_runtime_start_failed', 'deepseek_binary_cleanup',
    ]
      .includes(error.code));
    assert.equal(f.mock.requests.length, 0);
    assert.equal(await fs.access(f.marker).then(() => true, () => false), false);
  });
}

for (const mode of ['root-write', 'spawn']) {
  for (const fault of ['early-allow', 'changed-arguments', 'exit-1', 'killed', 'broken-json', 'timeout']) {
    test(`ELF gate ${mode}/${fault}: эффект запрещён, дерево остановлено`,
      { timeout: 90_000 }, async (t) => {
        const f = await glmSubagentFixture(t, mode, { beforeSpawn: injectFault(fault) });

        if (fault === 'changed-arguments') {
          const result = await f.run();

          // Registry замораживает аргументы: попытка изменения сама завершается ошибкой
          // до guard/body. Нельзя превращать этот отказ в утверждение о выполненном эффекте.
          assert.ok(result.steps.some((step) => step.k === 'res' && step.ok === false));
        } else {
          await assert.rejects(f.run(), { code: 'glm_policy_gate_failed' });
        }

        assert.equal(await fs.access(f.marker).then(() => true, () => false), false);
        assert.equal(f.permissions.length, 0);
        assert.equal(f.children.length > 0, mode === 'spawn');
      });
  }
}

test('ELF gate: helper получает scrub окружение и сохраняет штатный эффект',
  { timeout: 90_000 }, async (t) => {
    const f = await glmSubagentFixture(t, 'spawn', { beforeSpawn: injectFault('observe-env') });

    await f.run();

    const names = JSON.parse(await fs.readFile(path.join(f.cwd, 'helper-env.json'), 'utf8'));

    assert.ok(names.includes('PATH'));

    for (const name of ['GRIGDESK_GLM_ROUTE_KEY', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'DEEPSEEK_API_KEY']) {
      assert.equal(names.includes(name), false, name);
    }

    assert.equal(await fs.readFile(f.marker, 'utf8'), 'child-effect');
  });

test('ELF stop дочернего helper отменяет ожидание и не допускает эффект',
  { timeout: 90_000 }, async (t) => {
    const f = await glmSubagentFixture(t, 'spawn', { beforeSpawn: injectFault('stop') });
    const rejected = assert.rejects(f.run(), (error) => error.stopped === true);
    const started = path.join(f.cwd, 'helper-started');

    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (await fs.access(started).then(() => true, () => false)) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(await fs.access(started).then(() => true, () => false), true);
    f.controller.abort();
    await rejected;
    assert.equal(await fs.access(f.marker).then(() => true, () => false), false);
  });
