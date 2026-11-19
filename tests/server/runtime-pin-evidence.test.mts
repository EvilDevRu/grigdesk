import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { collectRuntimePinOutcomes, macRuntimePinLeaves } from '../../tools/ci/runtimePinEvidence.mts';
import { reportRuntimePinEvents } from '../../tools/ci/runtime-pin-reporter.mjs';

const execute = promisify(execFile);
const checkout = path.resolve(import.meta.dirname, '../..');

for (const mode of ['source', 'packaged'] as const) {
  test(`Evidence ${mode} requires exact leaves, directive-free passes, and matched witnesses`, async (t) => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'gd-evidence-'));
    const fixture = path.join(root, 'fixture.mts');
    const witness = path.join(root, 'witness');
    const required = macRuntimePinLeaves(mode);
    const group = mode === 'source' ? 'MAC-SOURCE-RUNTIME-PIN' : 'MAC-VERIFY-RUNTIME-PIN';
    const results = required.map(([id, barrier]) => ({
      id,
      outcome: 'passed',
      barrier,
    }));
    const rawReporter = path.join(root, 'raw.mjs');
    const report = path.join(root, 'events.ndjson');

    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(witness, { mode: 0o700 });

    for (const result of results) {
      await fs.writeFile(path.join(witness, result.id + '.json'), JSON.stringify(result), { mode: 0o600 });
    }

    await fs.writeFile(fixture,
      `import test from 'node:test';
       test(${JSON.stringify(group)}, async t => {
         for (const name of ${JSON.stringify(required.map(([id]) => id))}) {
           await t.test(name, () => {});
         }
       });`, { mode: 0o600 });
    await fs.writeFile(rawReporter,
      `export default async function* raw(events) {
        for await (const event of events) {
          if (event.type === 'test:pass') yield JSON.stringify(event) + '\\n';
        }
      }`, { mode: 0o600 });
    // Вложенный node --test не должен наследовать NODE_TEST_CONTEXT внешнего test-worker:
    // иначе run() рекурсивно пропускает файлы и не создаёт reporter-destination.
    const nestedEnv = { ...process.env };
    delete nestedEnv.NODE_TEST_CONTEXT;
    await execute('/bin/bash', ['tests/run-node-tests-safe.sh', '--test', '--test-concurrency=1',
      '--test-reporter=' + rawReporter, '--test-reporter-destination=' + report, fixture], {
      cwd: checkout,
      timeout: 60_000,
      env: nestedEnv,
    });

    const terminal = (await fs.readFile(report, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const groupPosition = terminal.findIndex(({ data }) => data.name === group);
    const leafPosition = terminal.findIndex(({ data }) => data.name === required[0]![0]);

    assert.ok(groupPosition >= 0 && leafPosition >= 0);

    /**
     * Sends unnormalized Node event fields through the production reporter.
     * A witness never changes a directive or substitutes for a test pass.
     */
    async function collect(events: typeof terminal) {
      const normalized: unknown[] = [];

      for await (const line of reportRuntimePinEvents(events, fixture)) {
        normalized.push(JSON.parse(line));
      }

      return collectRuntimePinOutcomes(mode, normalized, witness);
    }

    assert.deepEqual(await collect(terminal), results.toSorted((a, b) => a.id.localeCompare(b.id)));
    await assert.rejects(collect(terminal.filter((_, position) => position !== leafPosition)),
      /mac_runtime_pin_outcomes_incomplete/u);

    for (const [position, directives] of [
      [groupPosition, ['skip', 'todo']],
      [leafPosition, ['skip', 'todo', 'expectFailure']],
    ] as const) {
      for (const directive of directives) {
        const changed = structuredClone(terminal);

        Object.assign(changed[position]!.data, { [directive]: '' });
        await assert.rejects(collect(changed), /mac_runtime_pin_event_invalid/u);
      }
    }

    const absent = path.join(witness, results[0]!.id + '.json');

    await fs.unlink(absent);
    await assert.rejects(collect(terminal), /mac_runtime_pin_witness_incomplete/u);
    await fs.writeFile(absent, JSON.stringify(results[1]), { mode: 0o600 });
    await assert.rejects(collect(terminal), /mac_runtime_pin_outcome_invalid/u);
  });
}
