import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  assertGeometry, fillProject, names, projectInput, repository, request, requireWizard,
  scaleWizardText, token, waitState, wizardBrowser,
} from './helpers/onboardingFixture.js';

/**
 * Единственный поток считается по реально созданным EventSource каждого документа.
 * Серверное событие проходит общий EVENT_NAMES и вызывает чтение нового снимка.
 */
async function assertSse(f, page) {
  const before = f.calls.filter((call) => call.method === 'GET' && call.url === '/api/onboarding').length;

  const current = await request(f.app);

  await request(f.app, 'PATCH', '', {
    ...token(current),
    draft: { ...current.active.draft, workspace: { mode: 'isolated' } },
  });
  await f.publish();
  await page.waitForFunction(() => window.__onboardingSources?.some((source) => source.readyState === 1));

  const active = await page.evaluate(() => window.__onboardingSources
    .filter((source) => source.readyState === 1).length);

  assert.equal(active, 1);

  const deadline = Date.now() + 4000;

  while (f.calls.filter((call) => call.method === 'GET' && call.url === '/api/onboarding').length <= before
    && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(f.calls.filter((call) => call.method === 'GET' && call.url === '/api/onboarding').length > before,
    'onboarding-changed дошёл через общую шину и вызвал перечитывание');
}

test('ONB-E2E-01: настоящий App и HTTP, два Git, ACK/reload и обычная форма', {
  timeout: 120000,
}, async (t) => {
  requireWizard();

  const f = await wizardBrowser(t, { providers: [] });
  const first = await repository(f.root, 'first');
  const second = await repository(f.root, 'second');
  const page = await f.newPage();

  await page.waitForURL(/#\/onboarding/);
  await page.getByRole('button', { name: names.skip }).click();
  await waitState(f, (state) => state.active.step === 'project');
  await fillProject(page, [first, second], 'Два репозитория из мастера');
  await page.getByRole('combobox', { name: names.branch }).nth(1).selectOption('feature');
  await waitState(f, (state) => state.active.draft.repositories[1]?.baseBranch === 'feature');
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.getByRole('textbox', { name: names.title }).inputValue(),
    'Два репозитория из мастера');
  await page.getByRole('button', { name: names.next }).click();
  await waitState(f, (state) => state.active.step === 'workspace');
  await page.getByRole('radio', { name: /Прямо в моей папке/i }).check();
  await waitState(f, (state) => state.active.draft.workspace.mode === 'shared');

  const other = await f.newPage();

  await other.waitForURL(/#\/onboarding/);
  assert.equal(await other.getByRole('radio', { name: /Прямо в моей папке/i }).isChecked(), true);
  await assertSse(f, page);
  await page.getByRole('radio', { name: /Прямо в моей папке/i }).check();
  await waitState(f, (state) => state.active.draft.workspace.mode === 'shared');
  await page.getByRole('button', { name: names.next }).click();

  const finished = await waitState(f, (state) => state.active.status === 'completed');

  assert.equal(finished.active.origin, 'auto');
  assert.equal(finished.autoOpenDisabled, true);
  assert.deepEqual(finished.active.draft.repositories.map((repo) => repo.baseBranch), ['main', 'feature']);

  const instruction = page.locator('a[href*="source=grigdesk"][href*="pipeline-sample"]');

  await instruction.click();
  await page.locator('.documents-view').waitFor();

  const samplePath = path.join(f.config.rootDir, 'server/seed/pipeline-sample/README.md');
  const supplied = await readFile(samplePath, 'utf8');
  const heading = supplied.split('\n').find((line) => /^# /.test(line)).slice(2).trim();

  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  await page.goto(f.origin + `#/projects/${finished.active.projectId}`);
  await page.getByRole('textbox', { name: /Название|Name|Title/i }).fill('Правка прежней формой');
  await page.locator('[data-role="project-save"]').click();

  const deadline = Date.now() + 5000;
  let saved;

  do {
    saved = await f.app.projects.read(finished.active.projectId);

    if (saved.title === 'Правка прежней формой') {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);

  assert.equal(saved.title, 'Правка прежней формой');
  assert.equal(saved.repos.length, 2);
});

test('ONB-E2E-02: manual после reload и второго context продолжается только кнопкой', {
  timeout: 120000,
}, async (t) => {
  requireWizard();

  const f = await wizardBrowser(t);

  await f.app.projects.create(projectInput('demo'));

  const page = await f.newPage({ route: '#/projects' });

  await page.getByRole('button', { name: names.manual }).click();
  await page.getByRole('button', { name: names.skip }).click();
  await page.getByRole('textbox', { name: names.title }).fill('Ручной второй проект');

  const state = await waitState(f, (value) => value.active.draft.title === 'Ручной второй проект');

  assert.equal(state.active.origin, 'manual');
  await page.goto(f.origin + '#/board');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.shell').waitFor();
  assert.equal(page.url().includes('#/onboarding'), false);

  const other = await f.newPage({ route: '#/board' });

  assert.equal(other.url().includes('#/onboarding'), false);
  await other.goto(f.origin + '#/projects');
  await other.getByRole('button', { name: names.manual }).click();
  assert.equal(await other.getByRole('textbox', { name: names.title }).inputValue(), 'Ручной второй проект');
  assert.equal((await request(f.app)).active.id, state.active.id);

  const starts = f.calls.filter((call) => call.url.endsWith('/start')).length;

  await other.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await other.getByRole('textbox', { name: names.title }).inputValue(), 'Ручной второй проект');
  assert.equal(f.calls.filter((call) => call.url.endsWith('/start')).length, starts);
  assert.equal((await f.app.projects.list()).length, 1);
});

test('ONB-E2E-02: RU/EN, узкий экран, touch, текст130%, все шаги и устойчивый отказ', {
  timeout: 240000,
}, async (t) => {
  requireWizard();

  const matrix = [
    {
      width: 1280,
      height: 800,
      touch: false,
      scale: 1,
    },
    {
      width: 1280,
      height: 800,
      touch: false,
      scale: 1,
      workspaceWidth: 600,
    },
    {
      width: 390,
      height: 844,
      touch: true,
      scale: 1,
    },
    {
      width: 320,
      height: 640,
      touch: true,
      scale: 1.3,
    },
  ];

  for (const locale of ['ru', 'en']) {
    for (const size of matrix) {
      const dockLabel = size.workspaceWidth ? ' с доком' : '';
      const label = `${locale} ${size.workspaceWidth || size.width}px${dockLabel}`;

      await t.test(label, async (t) => {
        const f = await wizardBrowser(t, { providers: [] });
        const dir = await repository(f.root);
        const page = await f.newPage({
          locale,
          viewport: { width: size.width, height: size.height },
          touch: size.touch,
        });

        await page.waitForURL(/#\/onboarding/);
        await page.getByRole('button', { name: names.skip }).waitFor();

        if (size.workspaceWidth) {
          await page.evaluate((width) => {
            const content = document.querySelector('.shell .content');
            const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
            const dock = pinia._s.get('dock');

            dock.open('terminal');
            dock.setWidth(innerWidth - content.getBoundingClientRect().left - width);
            content.style.width = `${width}px`;
            content.style.maxWidth = `${width}px`;
          }, size.workspaceWidth);
          await page.waitForFunction(() => {
            const rect = document.querySelector('.shell .content').getBoundingClientRect();

            return Math.abs(rect.width - 600) < 2;
          });
        }

        if (size.scale !== 1) {
          await scaleWizardText(page, size.scale);
        }

        await assertGeometry(page, size.touch);
        await page.getByRole('button', { name: names.skip }).click();
        await fillProject(page, [dir], 'Данные пользователя / User data');
        await assertGeometry(page, size.touch);
        await page.getByRole('button', { name: names.next }).click();
        await page.getByRole('radio', {
          name: /Каждая задача в своей копии|Each task in its own copy/i,
        }).waitFor();
        await assertGeometry(page, size.touch);
        await page.getByRole('button', { name: names.next }).click();
        await waitState(f, (state) => state.active.status === 'completed');
        await page.getByText('Данные пользователя / User data', { exact: true }).waitFor();
        await assertGeometry(page, size.touch);
        assert.equal(await page.getByText(/onboarding\.[a-z]/i).count(), 0,
          'Не показаны ключи вместо перевода');
        await page.getByRole('button', { name: names.dismiss }).click();
        await page.waitForURL(/#\/projects/);
        await page.goto(f.origin + '#/board');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('.shell').waitFor();
        assert.equal(page.url().includes('#/onboarding'), false);
        assert.equal((await request(f.app)).autoOpenDisabled, true);
      });
    }
  }
});
