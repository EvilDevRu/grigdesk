import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * События получает настоящий host gate, а shell возвращает детерминированный ответ helper.
 * Фикстура хранит журнал обеих сессий и не требует ELF, ключа или модели.
 */
async function fixture(t) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'glm-alpha-lineage-'));
  const host = path.join(scratch, 'glmGate.mjs');
  const policyFile = path.join(scratch, 'policy.json');
  const handlers = new Map();
  const protocol = new URL('../../shared/node/glmGateProtocol.ts', import.meta.url);

  t.after(() => rm(scratch, { recursive: true, force: true }));
  await copyFile(new URL('../../deepseek/src/host/glmGate.mjs', import.meta.url), host);
  await writeFile(path.join(scratch, 'glmGateProtocol.mjs'),
    `export * from ${JSON.stringify(protocol.href)};\n`);
  await writeFile(policyFile, '{}');

  const { apply } = await import(pathToFileURL(host).href);
  const parent = agent('parent');
  const child = agent('child', parent.session.id);
  const ctx = {
    on(event, callback) {
      handlers.set(event, callback);
    },
    agents: { roots: () => [parent] },
    tools: {
      guard(callback) {
        handlers.set('guard', callback);
      },
    },
    sessionProjections: { stateOf: () => ({ lastTurn: 1 }) },
    shell: {
      resolve: (request) => request,
      /** Возвращает точную привязку вызова или подтверждение подготовки для данного запуска. */
      async run(request) {
        const input = JSON.parse(request.stdin);
        const output = input.preflight ? { ready: true, ...input.preflight } : {
          ...input.binding,
          decision: 'allow',
          kind: 'test',
          reason: 'fixture',
        };

        return {
          exitCode: 0,
          stdout: { text: JSON.stringify(output) },
        };
      },
    },
  };

  await apply(ctx, {
    command: 'fixture',
    launchId: 'fixture-launch',
    policyFile,
  });
  handlers.get('agent/created')({ agent: parent });

  const execution = {
    agent: parent,
    callId: 'parent-call',
    name: 'subagent_fork',
    arguments: { prompt: 'fixture' },
    signal: new AbortController().signal,
  };

  await handlers.get('tools/pre-execute')(execution, () => undefined);
  assert.equal(handlers.get('guard')(execution), undefined);

  return {
    parent,
    child,
    handlers,
    execution,
  };
}

/**
 * Сессии форка имеют один наследованный event и отдельные журналы для новых записей.
 * Контракт использует объект Session, поэтому фикстура передаёт его в оба hook.
 */
function agent(id, parentSession) {
  const events = [];

  return {
    id: id + '-agent',
    events,
    cancel() {},
    session: {
      id,
      header: {
        cwd: os.tmpdir(),
        origin: parentSession ? 'subagent' : 'root',
        parentSession,
      },
      inheritedEventCount: parentSession ? 1 : 0,
      append(type, data) {
        events.push({ type, data });
      },
    },
  };
}

for (const order of ['descriptor', 'created']) {
  test(`GLM связывает child до первого шага, первым приходит ${order}`, async (t) => {
    const { parent, child, handlers, execution } = await fixture(t);
    const descriptor = {
      type: 'subagent/descriptor',
      seq: 1,
      data: { mode: 'one-shot' },
    };
    const links = () => parent.events.filter((event) => event.type === 'grigdesk/glm-delegation');
    const create = () => handlers.get('agent/created')({ agent: child });
    const describe = () => handlers.get('session/event')(child.session, descriptor);

    await handlers.get('tools/execute')(execution, async () => {
      handlers.get('session/event')(child.session, {
        ...descriptor,
        seq: 0,
        data: { mode: 'continuable' },
      });

      const events = order === 'descriptor' ? [describe, create] : [create, describe];

      events[0]();
      assert.equal(links().length, 0);
      events[1]();
      assert.equal(links().length, 1);
      assert.equal(links()[0].data.parentCallId, execution.callId);
      assert.equal(links()[0].data.childSessionId, child.session.id);
      assert.equal(links()[0].data.launchId, 'fixture-launch');
      assert.equal(await handlers.get('agent/pre-step')({ agent: child }, () => 'proceed'), 'proceed');

      describe();
      assert.equal(links().length, 1);
      assert.deepEqual(await handlers.get('agent/pre-step')({ agent: child }, () => assert.fail()),
        { kind: 'reject' });
    });
  });
}
