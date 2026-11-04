import assert from 'node:assert/strict';
import test from 'node:test';
import { shellAction, readShellState } from '../../web/src/shared/shellClient.ts';
import { setWebDiagnosticSink } from '../../web/src/shared/webDiagnostics.ts';
import { setPerformancePolicy } from '../../web/src/shared/performanceContext.ts';

test('shell command имеет одно pending и итог, но long-poll штатно ожидает без pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const rows = [];
  let clock = 0;
  let release;

  t.mock.method(performance, 'now', () => clock);
  setPerformancePolicy(true);
  setWebDiagnosticSink((event, data) => rows.push({ event, data }));
  t.after(() => {
    setPerformancePolicy(false);
    setWebDiagnosticSink(null);
  });
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => release = resolve));

  const request = shellAction('POST', '/connect', { pairing: 'secret' });

  clock = 3000;
  t.mock.timers.tick(9000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.phase, 'pending');
  clock = 3500;
  release(new Response('{}'));
  await request;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].data.phase, 'success');
  assert.equal(rows[1].data.ms, 3500);
  assert.doesNotMatch(JSON.stringify(rows), /secret|pairing/u);
  rows.length = 0;

  const poll = readShellState(42);

  t.mock.timers.tick(30_000);
  release(new Response(JSON.stringify({
    rev: 43,
    status: 'online',
    profile: null,
    profiles: [],
    capabilities: [],
    localAvailable: false,
  }), { headers: { 'content-type': 'application/json' } }));
  await poll;
  assert.equal(rows.length, 0);
});

test('off убирает shell pending и поздний finish после verbose не возрождается', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const rows = [];
  let release;

  setWebDiagnosticSink((event, data) => rows.push({ event, data }));
  setPerformancePolicy(true);
  t.after(() => {
    setPerformancePolicy(false);
    setWebDiagnosticSink(null);
  });
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => release = resolve));

  const request = shellAction('POST', '/profiles', { pairing: 'secret' });

  setPerformancePolicy(false);
  setPerformancePolicy(true);
  t.mock.timers.tick(30_000);
  release(new Response('{}'));
  await request;
  assert.equal(rows.length, 0);
});

test('диагностика не принимает неполный ShellState с одной rev', async (t) => {
  setPerformancePolicy(true);
  t.after(() => setPerformancePolicy(false));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ rev: 43 }));
  assert.equal(await readShellState(), null);
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    rev: 44,
    status: 'online',
    profile: null,
    profiles: [],
    capabilities: [],
    localAvailable: false,
  }));
  assert.equal((await readShellState()).rev, 44);
});
