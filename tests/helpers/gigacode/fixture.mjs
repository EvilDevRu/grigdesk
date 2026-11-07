import {
  promises as fs
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fileURLToPath
} from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const MODEL_A = 'synthetic/model-a(gigacode)';
export const MODEL_B = 'synthetic/model-b(gigacode)';

/**
 * Синтетическая установка имеет ту же package/ACP identity, что наблюдённая поставка.
 * Формы initialize взяты из provenance fixture; prompt и инструменты всегда synthetic.
 */
export async function makeGigaCodeFixture(t, scenario = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gigacode-fixture-'));
  const cli = path.join(root, 'cli');
  const auth = path.join(root, 'native');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'capture-home');

  t.after(() => fs.rm(root, {
    recursive: true,
    force: true
  }));
  await Promise.all([cli, auth, workspace, home].map((dir) => fs.mkdir(dir)));

  const initialize = JSON.parse(await fs.readFile(
    path.join(ROOT, 'tests/fixtures/gigacode/26.7.33/initialize.json'), 'utf8',
  ));

  initialize.agentInfo.version = scenario.packageVersion || initialize.agentInfo.version;

  const models = [MODEL_A, MODEL_B].map((modelId, index) => ({
    modelId,
    name: `Synthetic ${index + 1}`,
    _meta: {
      contextLimit: 8192
    },
  }));
  const configFor = (id) => [{
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: id,
    options: models.map((model) => ({
      value: model.modelId,
      name: model.name
    })),
  }];
  const defaults = {
    sessionId: `synthetic-${path.basename(root)}`,
    captureStartup: true,
    ...(scenario.captureRequests ? {
      captureFile: path.join(workspace, 'requests.jsonl'),
      captureCwd: workspace,
    } : {}),
    initialize,
    discoverMcp: true,
    session: {
      models: {
        currentModelId: MODEL_A,
        availableModels: models
      },
      modes: {
        currentModeId: 'default',
        availableModes: [{
          id: 'default'
        }]
      },
    },
    configOptions: configFor(MODEL_A),
    configByModel: Object.fromEntries(models.map((model) => [model.modelId, configFor(model
      .modelId)])),
    updates: [{
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'Ответ fixture'
      }
    }],
    redactMcpEnv: true,
  };
  const scenarioFile = path.join(cli, 'scenario.json');

  await fs.writeFile(scenarioFile, JSON.stringify({
    ...defaults,
    ...scenario
  }));
  await fs.copyFile(path.join(ROOT, 'tests/fixtures/deepseek-harness/fakeAcp.mts'),
    path.join(cli, 'fakeAcp.mts'));
  await fs.writeFile(path.join(cli, 'package.json'), JSON.stringify({
    name: '@gigacode/gigacode',
    version: scenario.packageVersion || '0.13.1',
    type: 'module',
  }));

  const bin = path.join(cli, 'gigacode');

  await fs.writeFile(bin, [
    `#!${process.execPath}`,
    "import path from 'node:path';",
    "import os from 'node:os';",
    "import { readFileSync } from 'node:fs';",
    "if (process.argv.includes('--version')) {",
    `  console.log(${JSON.stringify(JSON.stringify(scenario.cliVersion || '26.7.33'))});`,
    '} else {',
    "  if (!process.argv.includes('--acp')) process.exit(97);",
    "  process.argv.push('--scenario', new URL('./scenario.json', import.meta.url).pathname);",
    "  const scenario = JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url)));",
    "  const capture = !scenario.captureCwd || scenario.captureCwd === process.cwd();",
    "  process.argv.push('--log', capture && scenario.captureFile",
    "    ? scenario.captureFile : path.join(os.homedir(), 'requests.jsonl'));",
    "  await import('./fakeAcp.mts');",
    '}',
  ].join('\n'), {
    mode: 0o755
  });
  await fs.writeFile(path.join(auth, 'gigacode_token.json'), JSON.stringify({
    token: 'synthetic-native-fixture-token',
    expiryDate: Date.now() + 3600000,
    config: {
      features: []
    },
  }), {
    mode: 0o600
  });

  return {
    root,
    workspace,
    home,
    scenarioFile,
    config: {
      gigacodeBin: bin,
      gigacodeHome: auth,
      gigacodeRuntimeHome: path.join(root, 'private'),
      gigacodeBwrapBin: '/usr/bin/bwrap',
    },
  };
}
