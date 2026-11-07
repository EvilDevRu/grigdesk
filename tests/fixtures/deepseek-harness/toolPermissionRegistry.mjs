import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import * as gate from './toolPermissionGate.mjs';

const requireRuntime = createRequire(`${process.argv[2]}/package.json`);
const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { default: ToolRuntime } = await load('@deepseek-ai/dsh-tools');
const { default: Approval } = await load('@deepseek-ai/dsh-user-approval');
const ctx = new Context();

await ctx.plugin(SystemPrompt, {});
await ctx.plugin(ToolRuntime);
await ctx.plugin(Approval, { policy: 'ask' });

const root = process.cwd();
const scenario = process.argv[3];
const mode = scenario.startsWith('readonly') ? 'read-only'
  : scenario.startsWith('automatic') ? 'auto' : 'default';
let sandboxMode = 'workspace-write';
const events = [{ type: 'turn/start', data: {} }];
const session = {
  id: 'registry-root',
  header: { cwd: root },
  get seq() {
    return events.length;
  },
  eventAt: (index) => events[index],
  append: (type, data) => events.push({ type, data }),
};
const agent = { id: session.id, session };
const otherAgent = { id: 'other-root', session: { ...session, id: 'other-root' } };
const rootAgents = scenario === 'swapped-agent' ? [agent, otherAgent] : [agent];

ctx.provide('agents', {
  roots: () => rootAgents,
  get: (id) => rootAgents.find((candidate) => candidate.id === id),
});
ctx.provide('sandboxPolicy', { resolve: () => ({ mode: sandboxMode, workspaceRoot: root }) });
ctx.provide('permissionPresets', {
  set(_session, selected) {
    sandboxMode = selected;
  },
});

let effects = 0;
let questions = 0;
const controller = new AbortController();
let answer;
let asked;
const question = new Promise((resolve) => {
  asked = resolve;
});
const answers = new Map();
const twoQuestions = Promise.withResolvers();
let executingArguments;
let executingContext;

ctx.on('tools/pre-execute', async (exec, next) => {
  executingArguments = exec.arguments;
  executingContext = exec;

  return next();
});

if (scenario !== 'unavailable') {
  ctx.on('approval/request', (request) => {
    questions += 1;
    asked();

    if (scenario === 'throwing') {
      throw new Error('synthetic answerer failure');
    }

    return new Promise((resolve) => {
      answer = resolve;
      answers.set(request.callId, resolve);

      if (answers.size === 2) {
        twoQuestions.resolve();
      }
    });
  });
}

if (scenario === 'hook-deny' || scenario === 'automatic-hook-deny') {
  ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'synthetic hook denial' }));
}

if (scenario === 'automatic-hook-ask') {
  ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'synthetic hook question' }));
}

const toolName = scenario.startsWith('automatic-bash') || scenario.startsWith('automatic-hook')
  ? 'bash' : scenario === 'readonly-read' ? 'read'
    : scenario.endsWith('web-search') ? 'web_search'
      : scenario.endsWith('web-fetch') ? 'web_fetch' : 'write';

ctx.tools.register({
  name: toolName,
  description: 'synthetic',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() {
    effects += 1;

    return 'effect';
  },
});

await ctx.plugin(gate, {
  format: 1,
  consumer: 'deepseek-chat',
  mode,
  workspaceRoot: root,
  revision: 'grigdesk-tool-permissions-v1',
  workActions: {},
});
ctx.emit('agent/session-start', { agent, source: 'new' });

if (scenario === 'swapped-agent') {
  ctx.emit('agent/session-start', { agent: otherAgent, source: 'new' });
}

if (scenario === 'bypass') {
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true });
}

const argumentsForCall = toolName === 'bash'
  ? { command: 'pwd', description: 'Тест штатного вызова shell' }
  : toolName === 'web_search' ? { queries: ['Harness documentation'] }
    : toolName === 'web_fetch' ? { url: 'https://example.org/' }
      : { file_path: `${root}/new.txt`, content: 'ok' };
const pending = ctx.tools.execute({
  name: toolName,
  callId: 'write-call',
  arguments: argumentsForCall,
  signal: controller.signal,
  agent: scenario === 'child' ? { id: 'child', session } : agent,
});

if (scenario === 'parallel') {
  let secondFinished = false;
  const second = ctx.tools.execute({
    name: 'write',
    callId: 'other-call',
    arguments: { file_path: `${root}/other.txt`, content: 'other' },
    signal: controller.signal,
    agent,
  }).then((value) => {
    secondFinished = true;

    return value;
  });

  await twoQuestions.promise;
  answers.get('write-call')('allowed-once');
  assert.equal((await pending).isError, false);
  assert.equal(effects, 1);
  assert.equal(secondFinished, false);
  answers.get('other-call')('rejected');
  assert.equal((await second).isError, true);
  assert.equal(effects, 1);
} else if (['automatic', 'automatic-bash', 'readonly-read'].includes(scenario)
  || ['web_search', 'web_fetch'].includes(toolName)) {
  assert.equal((await pending).isError, false);
  assert.equal(effects, 1);
  assert.equal(questions, 0);
} else if (['bypass', 'unavailable', 'throwing', 'hook-deny', 'automatic-hook-deny',
  'readonly-write', 'child'].includes(scenario)) {
  const result = await pending;

  assert.equal(result.isError, true);
  assert.equal(effects, 0);
} else {
  await Promise.race([
    question,
    pending.then(() => assert.fail('Инструмент завершился без разрешения')),
  ]);
  assert.equal(effects, 0);

  if (scenario === 'frozen-args') {
    assert.throws(() => {
      executingArguments.content = 'unreviewed';
    }, TypeError);
    assert.equal(executingArguments.content, 'ok');
  }

  if (scenario === 'swapped-agent') {
    executingContext.agent = otherAgent;
  } else if (scenario === 'swapped-args') {
    executingContext.arguments = { ...executingArguments, content: 'unreviewed' };
  } else if (scenario === 'swapped-definition') {
    ctx.tools.get(toolName, agent).execute = async () => {
      effects += 1;

      return 'unreviewed-effect';
    };
  }

  if (scenario === 'abort') {
    controller.abort();
    answer('allowed-once');
  } else {
    const permitted = ['allow', 'frozen-args', 'automatic-hook-ask'].includes(scenario)
      || scenario.startsWith('swapped-');

    answer(permitted
      ? 'allowed-once' : 'rejected');
  }

  const result = await pending;

  const allowed = ['allow', 'frozen-args', 'automatic-hook-ask'].includes(scenario);

  assert.equal(effects, allowed ? 1 : 0);
  assert.equal(result.isError, !allowed);
}

await ctx.fiber.dispose();
process.stdout.write('registry-ok\n');
