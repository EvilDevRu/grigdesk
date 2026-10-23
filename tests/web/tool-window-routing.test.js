import assert from 'node:assert/strict';
import test from 'node:test';
import { after } from 'node:test';
import { createUiBrowser } from './helpers/ui-components.js';
import { askAgentDraft } from '../../web/src/shared/codeTree.ts';
import { hostFixture, tick } from './helpers/tool-window-harness.js';
import { coordinatorFixture, instance } from './helpers/tool-window-coordinator.js';
import { chatUploadBoundaryFixture } from './helpers/chat-session.js';

const runtimeBrowser = await createUiBrowser('http://grigdesk.test/#/chats');
const { launchTool } = await import('../../web/src/shared/tools/launcher.ts');

after(() => runtimeBrowser.close());

const target = {
  project: 'demo',
  repo: 'demo',
  root: '/fixture/worktree',
  path: 'src/a.ts',
  line: 7

};

/**
 * Навигация и панель настоящие, native создаёт только одну наблюдаемую instance.
 * После detach локальный dock не имеет права ни монтировать Code, ни принимать его intent.
 */
async function routingFixture(t) {
  const host = await hostFixture(t);
  const f = await coordinatorFixture(t, { pinia: host.pinia, router: host.router });
  const opening = f.coordinator.detach('code');

  await tick();
  await f.ready();
  await opening;
  await host.settle();

  return { host, f };
}

function launchContext(host, f) {
  return {

    route: host.router.currentRoute.value,

    router: host.router,

    dock: host.dock,

    toolWindows: f.coordinator,

    canDock: () => true,

  };
}

test(
  'TW-L01: рейка, настроенная клавиша, ссылка ChatSession и code route поднимают одну instance',
  async (t) => {
  for(const entry of ['rail', 'hotkey', 'chat', 'route']) {
    await t.test(entry, async (t) => {
      const { host, f } = await routingFixture(t);

      if(entry === 'rail') {
        const rail = host.wrapper.findAll('.tool-rail-item').find((button) => (
          button.attributes('aria-label')?.startsWith('Код')
        ));

        assert.ok(rail);
        await rail.trigger('click');
      } else if(entry === 'hotkey') {
        host.state.hotkeys.toolByCombo['Ctrl+Shift+Digit1'] = 'code';
        host.browser.document.dispatchEvent(new host.browser.KeyboardEvent('keydown', {

          code: 'Digit1',
          key: '1',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,

        }));
      } else if(entry === 'chat') {
        globalThis.__uploadBoundaryToolLauncher = {
          openTool: (id, intent) => launchTool(launchContext(host, f), id, intent),
        };
        t.after(() => {
          delete globalThis.__uploadBoundaryToolLauncher;
        });

        const chat = await chatUploadBoundaryFixture(t, {
          stubs: {
            '../../features/code/links.ts': `export * from './src/features/code/links.ts';`,
            './StepList.vue': `export default {
              template: '<section class="step-list-stub"></section>'
            };`,
          }
        });
        // Ссылка проходит настоящий onMarkdownClick ChatSession, а не вызов launcher из теста.
        chat.sessions[0].messages.push({
          role: 'assistant',
          text: 'Ссылка на файл',
          steps: [{ k: 'text', text: 'Ссылка на файл' }],
        });
        await host.settle();

        const link = document.createElement('a');

        link.href = '#/code?' + new URLSearchParams(target);
        link.setAttribute('data-code-link', 'true');

        const container = chat.wrapper.get('.step-list-stub').element;

        container.append(link);
        link.dispatchEvent(new host.browser.MouseEvent('click', {
          bubbles: true,
          button: 0,
          cancelable: true

        }));
      } else {
        await host.router.push({ path: '/code', query: target });
      }

      await host.settle();
      assert.equal(host.wrapper.findAll('[data-panel="code"]').length, 0);
      assert.deepEqual(host.dock.intents.code || [], []);
      assert.equal(f.nativeCalls.filter(([action]) => action === 'open').length, 1);
      assert.ok(f.nativeCalls.some(([action, id, current]) => (
        action === 'focus' && id === 'code' && current === instance
      )));

      const commands = f.channels.main.posted.filter((message) => message.type === 'command');

      if(entry === 'chat' || entry === 'route') {
        assert.equal(commands.length, 1);
        assert.deepEqual(commands[0].intent, { type: 'open-file', ...target });
      } else {
        assert.equal(commands.length, 0);
      }
    });
  }
});

test(
  'TW-L02: query/back/replace не дублируют команду; переходы detached tools не монтируют local',
  async (t) => {
  const { host, f } = await routingFixture(t);

  await host.router.push({ path: '/code', query: target });
  await host.settle();
  assert.equal(host.router.currentRoute.value.path, '/chats');
  host.router.back();
  await host.settle();
  assert.equal(f.channels.main.posted.filter((message) => message.type === 'command').length, 1);

  for(const id of ['ssh', 'db', 'docker', 'shelf', 'example']) {
    const opening = f.coordinator.detach(id);

    await tick();
    await f.receive('ready', { target: { kind: 'tool', id } });
    await f.receive('init-ack', { target: { kind: 'tool', id } });
    await opening;
    await host.router.push(id === 'example' ? '/ext/example' : '/' + id);
    await host.settle();
    assert.equal(host.router.currentRoute.value.path, '/chats');
    assert.equal(host.wrapper.findAll(`[data-panel="${id}"]`).length, 0);
  }
});

/**
 * Эталон берётся из askAgentDraft, которым CodePanel формирует прежний draft.
 * Patch намеренно больше транспортного короткого сообщения; отправка агенту запрещена.
 */
async function assertCodeChat(t, patch = '') {
  const sessions = [];
  const routes = [];
  const f = await coordinatorFixture(t, {
    ports: {
      chat: {
        newSession(options) {
          sessions.push(options);

          return 'new-chat';
        },
        send() {
          assert.fail('Спросить агента создаёт черновик, а не отправляет ход');
        },
      },
      router: { push: async (path) => routes.push(path) },
    }
  });
  const action = {

    title: 'Код · a.ts',

    taskId: '42',

    workdir: {
      kind: 'project',
      projectId: 'demo',
      repoKey: 'demo'

    },

    draft: askAgentDraft({
      label: 'task',
      branch: 'task-42',
      absPath: '/fixture/a.ts',
      line: 7,
      patch

    }),

  };
  const opening = f.coordinator.detach('code');

  await tick();
  await f.ready();
  await opening;
  await f.receive('main-action', { seq: 1, action: { type: 'code-chat', ...action } });
  await f.receive('main-action', { seq: 1, action: { type: 'code-chat', ...action } });
  assert.deepEqual(sessions, [action]);
  assert.deepEqual(routes, ['/chats']);
  assert.equal(f.mounted.has('code'), false);
  assert.equal(f.channels.main.posted.at(-1).type, 'main-action-ack');
}

test('TW-L03: code-chat в main создаёт один прежний draft; child остаётся инструментом', async (t) => {
  await assertCodeChat(t);
});

test('TW-L03b: patch 2000×200 переносит точный результат askAgentDraft без отправки агенту', async (t) => {
  const patch = Array.from({ length: 2000 }, (_, index) => `${index}:${'я'.repeat(200)}`).join('\n');

  assert.ok(Buffer.byteLength(patch) > 400_000);
  await assertCodeChat(t, patch);
});
