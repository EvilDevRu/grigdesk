import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';

import { deferred, eventually, runChat, syntheticAdapter } from './accessProfiles.js';

/**
 * Живая модель — настоящий ребёнок с IPC, hooks соответствуют контракту пула.
 * busy/permission порождаются HTTP-ходом, фон и сон — штатными сигналами адаптера.
 */
export async function liveAdapter(t, control) {
  const handles = [];
  const environments = [];
  const adapter = syntheticAdapter();

  control.handles = handles;
  control.environments = environments;
  control.enter = async (state) => {
    control.state = state;

    const handle = handles.at(-1);

    if (state === 'background') {
      handle.spec.hooks.onBackgroundStart();
    } else if (state === 'sleep') {
      handle.spec.hooks.onBackgroundTasks([{
        id: 'sleeping-worker',
        kind: 'subagent',
        description: 'Ожидает результат',
      }]);
    } else {
      control.held = deferred();
      control.entered = deferred();
      control.running = runChat(control.fixture);
      await control.entered.promise;
    }
  };
  control.leave = async () => {
    const handle = handles.at(-1);

    if (control.state === 'background') {
      await handle.spec.hooks.onBackground({ reply: 'Фон завершён', sessionId: 'live-session' });
    } else if (control.state === 'sleep') {
      handle.spec.hooks.onBackgroundTasks([]);
    } else if (control.state === 'permission') {
      const event = await eventually(
        async () => control.fixture.events.findLast((item) => item.name === 'chat-permission'),
        Boolean,
      );

      await control.fixture.request('POST', `/api/chat/permission/${event.payload.pid}`, { allow: true });
      await control.running;
    } else {
      control.held.resolve();
      await control.running;
    }

    control.state = null;
  };
  adapter.session = {
    mode: 'persistent',
    unsolicited: true,
    /**
     * Открывает настоящий дочерний процесс с окружением выбранного снимка.
     * Готовность подтверждается IPC ребёнка до публикации handle пулу.
     */
    async open(spec) {
      const child = fork(new URL('../fixtures/access-profiles/live-worker.mjs', import.meta.url), [], {
        env: spec.env ?? {},
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const [ready] = await once(child, 'message');

      assert.equal(ready.type, 'ready');
      environments.push(ready.env);

      const handle = {
        spec,
        pid: child.pid,
        get alive() {
          return child.exitCode === null && child.signalCode === null;
        },
        /**
         * Ход ждёт реального разрешения сервера либо управляемого барьера.
         * Ответ приходит от живого ребёнка, а не синтезируется пулом сессий.
         */
        async send(turn) {
          if (control.state === 'permission') {
            const answer = turn.onPermission({
              tool: 'Bash',
              input: { command: 'echo fixture' },
              requiresExplicitUser: true,
            });

            control.entered.resolve();
            await answer;
          } else if (control.state === 'running') {
            control.entered.resolve();
            await control.held.promise;
          }

          const result = once(child, 'message');

          child.send({ type: 'send' });

          const [message] = await result;
          const sessionId = spec.sessionId || `live-session-${handles.length}`;

          await turn.onSessionCreated?.(sessionId);

          return {
            reply: message.reply,
            sessionId,
            steps: []
          };
        },
        async interrupt() {
          control.held?.resolve();
        },
        async close() {
          if (handle.alive) {
            const exited = once(child, 'exit');

            child.kill('SIGTERM');
            await exited;
          }
        },
      };

      handles.push(handle);

      return handle;
    },
  };
  t.after(async () => {
    control.held?.resolve();
    await Promise.all(handles.map((handle) => handle.close()));
  });

  return adapter;
}
