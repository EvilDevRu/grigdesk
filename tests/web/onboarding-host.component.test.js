import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import {
  atWorkspace, projectInput, request, wizardBrowser,
} from './helpers/onboardingFixture.js';

/**
 * Host проверяется внутри настоящего App с его auth, shell и общей шиной событий.
 * Подменён только внешний транспорт, поэтому тест видит лишние start и переходы.
 */
function requireHost() {
  assert.ok(existsSync(new URL('../../web/src/shared/onboarding/OnboardingHost.vue', import.meta.url)),
    'Нет host автозапуска мастера');
}

for (const scenario of ['empty', 'passport', 'dismissed', 'manual', 'auto-saved']) {
  test(`ONB-HOST-01: допуск сервера ${scenario} управляет единственным автопереходом`, async (t) => {
    if (scenario !== 'empty') {
      requireHost();
    }

    const f = await wizardBrowser(t);

    if (scenario === 'passport' || scenario === 'manual') {
      await f.app.projects.create(projectInput('demo'));
    }
    if (scenario === 'manual') {
      await request(f.app, 'POST', '/start', { expectedRevision: 0, mode: 'manual' });
    }
    if (scenario === 'auto-saved') {
      await atWorkspace(f);
    }
    if (scenario === 'dismissed') {
      const state = await request(f.app, 'POST', '/start', { expectedRevision: 0, mode: 'auto' });

      await request(f.app, 'POST', '/dismiss', {
        expectedRevision: state.revision,
        sessionId: state.active.id,
      });
    }

    const page = await f.newPage();

    requireHost();

    const eligible = scenario === 'empty' || scenario === 'auto-saved';

    if (eligible) {
      await page.waitForURL(/#\/onboarding/);
    } else {
      await page.waitForResponse((response) => response.url().endsWith('/api/onboarding'))
        .catch(() => {});
      assert.equal(page.url().includes('#/onboarding'), false);
    }

    assert.equal(f.calls.filter((call) => call.url.endsWith('/start')).length, eligible ? 1 : 0);
    await f.publish();
    assert.equal(f.calls.filter((call) => call.url.endsWith('/start')).length, eligible ? 1 : 0);
  });
}

for (const response of [
  { status: 200, json: {} },
  { status: 404, json: { error: 'not_found' } },
  { status: 500, json: { error: 'read_failed' } },
]) {
  test(`ONB-HOST-01: GET ${response.status} без допуска не открывает мастер и тост`, async (t) => {
    requireHost();

    const f = await wizardBrowser(t);

    f.controls.onboardingGet = response;

    const page = await f.newPage();

    await page.waitForFunction(() => document.querySelector('.shell'));
    assert.equal(page.url().includes('#/onboarding'), false);
    assert.equal(f.calls.filter((call) => call.url.endsWith('/start')).length, 0);
    assert.equal(await page.getByRole('alert').count(), 0);

    await page.goto(f.origin + '#/onboarding?new=1');
    await page.getByText(/обнов|недоступ|ошиб|update|unavailable|error/i).first().waitFor();
  });
}

test('ONB-HOST-01: начальный /projects не перехватывается', async (t) => {
  requireHost();

  const f = await wizardBrowser(t);
  const page = await f.newPage({ route: '#/projects' });

  await page.getByRole('button', { name: /Новый|New/ }).first().waitFor();
  assert.equal(page.url().includes('#/onboarding'), false);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/start')).length, 0);
});

for (const scenario of ['auth', 'no-machine', 'offline', 'surface']) {
  test(`ONB-HOST-01: до готовности ${scenario} нет запросов onboarding`, async (t) => {
    requireHost();

    const profile = {
      id: 'fixture',
      name: 'Машина',
      kind: 'remote',
      address: 'https://example.invalid',
    };
    const shell = {
      rev: 1,
      profile: scenario === 'no-machine' ? null : profile,
      profiles: scenario === 'no-machine' ? [] : [profile],
      status: scenario === 'offline' ? 'offline' : 'online',
      localAvailable: false,
      capabilities: [],
      detail: null,
      appApi: { major: 0, minor: 1 },
      serverApi: { major: 0, minor: 1 },
    };
    const f = await wizardBrowser(t, {
      ...(scenario === 'auth' ? { authenticated: false } : { shell }),
    });
    const page = await f.newPage({
      route: scenario === 'surface' ? '?surface=task&id=11#/surface' : '#/',
      surface: scenario === 'surface',
    });

    await page.waitForLoadState('domcontentloaded');
    assert.equal(f.calls.filter((call) => call.url.startsWith('/api/onboarding')).length, 0);
  });
}
