import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import description from '../fixtures/executor-settings/deepseek.json' with { type: 'json' };
import {
  deepSeekSettingsSnapshot,
  applyDeepSeekNativeSettings,
} from '../../server/src/lib/executorSettings/deepseek.ts';
import { ProviderSettingsCatalogCache } from '../../server/src/lib/executorSettings/catalog.ts';
import {
  flattenNativeSettings,
  validateNativeSetting,
} from '../../server/src/lib/executorSettings/validation.ts';
import { projectNativeSettingsCatalog } from '../../server/src/lib/executorSettings/projection.ts';
import { prepareDeepSeekLaunch } from '../../server/src/lib/deepseek/runtime.ts';
import { runDeepSeekWebTurn } from '../../server/src/lib/deepseek/webRuntime.ts';
import { runDeepSeekServerTurn } from '../../server/src/lib/deepseek/serverTurn.ts';
import { acpDeepSeekSettingsRpc } from '../../server/src/lib/deepseek/nativeSettingsRpc.ts';
import { writeDeepSeekMetadataStub } from '../helpers/deepseekBinaryStub.mts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';

const context = {
  providerId: 'deepseek',
  binaryIdentity: 'fixture',
  profileFingerprint: 'web-fixture',
  transport: 'web',
  mode: 'default',
  cwdRealpath: '/fixture',
};

test('ACP bridge без capability и чужой метод отвергаются без request', async () => {
  let requests = 0;
  const client = { request: async () => {
    requests += 1;
  } };

  assert.throws(() => acpDeepSeekSettingsRpc(client, {}));

  const rpc = acpDeepSeekSettingsRpc(client, {
    agentCapabilities: { _meta: { 'grigdesk.settings': { contract: 1 } } },
  });

  await assert.rejects(rpc.rpc('session/prompt'));
  assert.equal(requests, 0);
});

test('unknown mutation readback запрещает prompt вместо sent', async () => {
  await assert.rejects(applyDeepSeekNativeSettings({
    rpc: async (method) => method === 'settings/describe' ? description : { value: {} },
  }, {
    accepted: [{
      fieldId: '["future-namespace","enabled"]',
      path: ['future-namespace', 'enabled'],
      value: false,
    }],
  }));
});

for (const absent of [false, true]) {
  test(`readback после model selection ${absent ? 'unknown' : 'mismatch'} запрещает prompt`, async () => {
    const current = structuredClone(description);
    let prompts = 0;
    let stopped = 0;

    await assert.rejects(runDeepSeekServerTurn({
      bin: '/fixture',
      cwd: '/fixture',
      overlayPath: '/fixture/overlay',
      env: {},
      message: 'fixture',
      model: '["deepseek-official","deepseek-v4-flash"]',
      nativeSettings: {
        accepted: [{
          fieldId: '["future-namespace","enabled"]',
          path: ['future-namespace', 'enabled'],
          value: false,
        }],
      },
      startServer: async () => ({
        stop: async () => {
          stopped += 1;
        },
        client: {
          createSession: async () => 'fixture-session',
          prompt: async () => {
            prompts += 1;
          },
          rpc: async (method) => {
            if (method === 'settings/describe') {
              return current;
            }

            if (method === 'session/selectModel') {
              current.namespaces[0].value = absent ? {} : { enabled: true };

              return {};
            }

            return current.namespaces[0];
          },
        },
      }),
    }));
    assert.equal(prompts, 0);
    assert.equal(stopped, 1);
  });
}

test('DSH объявляет новый namespace и boolean, скрывая описанные secrets', async () => {
  const cache = new ProviderSettingsCatalogCache();
  const read = await cache.read(
    { discover: async () => deepSeekSettingsSnapshot(description, context) },
    context,
  );
  const fields = flattenNativeSettings(read.fields);

  assert.equal(fields.find((field) => field.id === '["future-namespace","enabled"]')?.writable, true);

  const catalog = projectNativeSettingsCatalog(read, {
    format: 1,
    revision: 0,
    overrides: {},
  });

  assert.equal(JSON.stringify(catalog).includes('sentinel'), false);
  assert.equal(fields.find((field) => field.path.at(-1) === 'credential')?.writable, false);
});

test('DSH не создаёт второй редактор effort и thinking, сохраняя соседний maxTokens', async () => {
  const native = structuredClone(description);

  native.namespaces.push({
    ns: 'llm-deepseek',
    revision: 0,
    applies: 'live',
    secrets: [],
    value: {
      reasoningEffort: 'medium',
      thinking: true,
      maxTokens: 100,
    },
    schema: {
      type: 'object',
      dict: {
        reasoningEffort: { type: 'string' },
        thinking: { type: 'boolean' },
        maxTokens: { type: 'number', meta: { min: 1, step: 1 } },
      },
    },
  });

  const cache = new ProviderSettingsCatalogCache();
  const read = await cache.read({ discover: async () => deepSeekSettingsSnapshot(native, context) }, context);
  const fields = flattenNativeSettings(read.fields);

  assert.equal(fields.find((field) => field.id === '["llm-deepseek","reasoningEffort"]').writable, false);
  assert.equal(fields.find((field) => field.id === '["llm-deepseek","thinking"]').writable, false);
  assert.equal(fields.find((field) => field.id === '["llm-deepseek","maxTokens"]').writable, true);
});

test('namespace llm-pi-ai в describe DeepSeek целиком принадлежит GrigDesk и не пишется', async () => {
  const native = structuredClone(description);

  native.namespaces.push({
    ns: 'llm-pi-ai',
    revision: 0,
    applies: 'live',
    secrets: [],
    value: { baseURL: 'https://fixture.invalid', futureFlag: true },
    schema: {
      type: 'object',
      dict: {
        baseURL: { type: 'string' },
        futureFlag: { type: 'boolean' },
      },
    },
  });

  const cache = new ProviderSettingsCatalogCache();
  const read = await cache.read({ discover: async () => deepSeekSettingsSnapshot(native, context) }, context);
  const fields = flattenNativeSettings(read.fields).filter((field) => field.path[0] === 'llm-pi-ai');

  assert.equal(fields.length, 2);

  for (const field of fields) {
    assert.equal(field.writable, false);
    assert.ok(field.owner);
    assert.equal(validateNativeSetting(read.fields, field.id, field.value)?.code, 'readonly_field');
  }
});

test('DSH отправляет новый leaf через адресный mutate и проверяет принятое значение', async () => {
  const received = [];
  const plan = {
    fingerprint: 'proof',
    accepted: [
      {
        fieldId: '["future-namespace","enabled"]',
        path: ['future-namespace', 'enabled'],
        value: false,
        channelId: 'isolated-settings-document',
      },
    ],
  };
  const evidence = await applyDeepSeekNativeSettings(
    {
      async rpc(method, args) {
        received.push({ method, args });

        return method === 'settings/describe' ? description : description.namespaces[0];
      },
    },
    plan,
  );

  assert.deepEqual(received[1], {
    method: 'settings/mutate',
    args: {
      ns: 'future-namespace',
      expectedRevision: 3,
      ops: [
        {
          op: 'set',
          path: ['enabled'],
          value: false,
        },
      ],
    },
  });
  assert.equal(evidence[0]?.result, 'sent');
});

test('DSH готовит отдельный документ каждого запуска, сохраняя shared home при set и reset', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-dsh-layer-'));
  const { binary } = await writeDeepSeekMetadataStub(t);

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const options = {
    config: { deepseekRuntimeHome: root, deepseekBin: binary },
    cwd: root,
    workspaceRoot: root,
    projectRoot: root,
    chatKey: 'fixture-chat',
    mode: 'workspace-write',
    approval: 'ask',
    transport: 'web',
  };
  const original = await prepareDeepSeekLaunch(options);
  const document = path.join(original.dshHome, 'settings.yaml');

  await fs.writeFile(document, 'private:\n  secret: sentinel\nordinary: 7\n');

  const selected = await prepareDeepSeekLaunch({
    ...options,
    nativeSettings: {
      accepted: [
        {
          fieldId: '["ui-theme","fontSize"]',
          path: ['ui-theme', 'fontSize'],
          value: 16,
        },
      ],
    },
  });
  const overlay = await fs.readFile(selected.overlayPath, 'utf8');

  assert.match(overlay, /id: "settings"/);

  const isolated = path.join(selected.launchDir, 'native-settings.yaml');

  assert.equal(await fs.readFile(isolated, 'utf8'), await fs.readFile(document, 'utf8'));
  await fs.writeFile(isolated, 'changed\n');

  const reset = await prepareDeepSeekLaunch(options);

  assert.equal((await fs.readFile(reset.overlayPath, 'utf8')).includes('native-settings.yaml'), false);
  assert.equal((await fs.readFile(document, 'utf8')).includes('sentinel'), true);
});

test('DSH web CLI получает новый leaf до prompt и resume после reset больше его не отправляет', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-dsh-cli-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bin = path.join(root, 'dsh');
  const scenarioFile = path.join(root, 'scenario.json');
  const trace = path.join(root, 'trace.jsonl');
  const info = { ...runtimeInfoFixture(), journal: { write: 3, read: [0, 1, 2, 3] } };
  const fixture = new URL('../fixtures/deepseek-harness/fakeWeb.mjs', import.meta.url).pathname;
  const quote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

  await fs.writeFile(scenarioFile, JSON.stringify({ updates: [] }));
  await fs.writeFile(
    bin,
    '#!/bin/sh\n' +
      `if [ "$1" = "--runtime-info" ]; then printf '%s\\n' ` +
      `${quote(JSON.stringify(info))}; exit 0; fi\n` +
      `exec ${quote(process.execPath)} ${quote(fixture)} ` +
      `--scenario ${quote(scenarioFile)} --log ${quote(trace)} "$@"\n`,
    { mode: 0o755 },
  );

  const plan = {
    providerId: 'deepseek',
    contextFingerprint: 'fixture',
    schemaRevision: 'fixture',
    storageRevision: '1',
    fingerprint: 'false',
    payload: { 'future-namespace': { enabled: false } },
    accepted: [
      {
        fieldId: '["future-namespace","enabled"]',
        path: ['future-namespace', 'enabled'],
        value: false,
        channelId: 'isolated-settings-document',
      },
    ],
  };
  const options = {
    config: { deepseekRuntimeHome: path.join(root, 'runtime'), deepseekBin: bin },
    cwd: root,
    projectRoot: root,
    chatKey: 'native-proof',
    message: 'fixture',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      DEEPSEEK_API_KEY: 'synthetic-native-proof',
    },
  };
  const first = await runDeepSeekWebTurn({ ...options, nativeSettings: plan });

  await runDeepSeekWebTurn({ ...options, sessionId: first.sessionId });

  const received = (await fs.readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const mutations = received.filter((entry) => entry.message?.method === 'settings/mutate');
  const sessions = received.filter((entry) => entry.message?.method === 'session/create');

  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].message.params.ops, [
    {
      op: 'set',
      path: ['enabled'],
      value: false,
    },
  ]);
  assert.equal(
    received.findIndex((entry) => entry.message?.method === 'settings/mutate') <
      received.findIndex((entry) => entry.message?.method === 'session/prompt'),
    true,
  );
  assert.equal(sessions[1].message.params.request.sessionId, first.sessionId);
});
