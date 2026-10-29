import assert from 'node:assert/strict';
import test from 'node:test';

import { card, job, snapshot } from './helpers/providerInstallFixture.js';
import {
  atProject, atWorkspace, fillProject, names, repository, request, requireWizard,
  token, waitState, wizardBrowser,
} from './helpers/onboardingFixture.js';

/**
 * Каждая проверка страницы получает независимый backend и настоящий UI в браузере.
 * Начальное состояние создаётся только публичным серверным переходом, а не готовым JSON.
 */
async function aiPage(t, options = {}) {
  requireWizard();

  const f = await wizardBrowser(t, options);

  await request(f.app, 'POST', '/start', { expectedRevision: 0, mode: 'manual' });

  const page = await f.newPage({ route: '#/onboarding' });

  return { ...f, page };
}

test('ONB-STEPS-01: текущий, готовый, пропущенный и будущие шаги различимы', async (t) => {
  const f = await aiPage(t);
  const { page } = f;

  await page.getByText('Где работают задачи', { exact: true }).waitFor();
  assert.equal(await page.locator('[aria-current="step"]').count(), 1);
  assert.match(await page.locator('[aria-current="step"]').innerText(), /ИИ/);

  for (const title of ['Разбор проекта и стенд', 'Маршруты', 'Включение конвейера']) {
    const step = page.getByText(title, { exact: true });

    await step.waitFor();

    const disabled = await step.evaluate((element) =>
      Boolean(element.closest('[aria-disabled="true"], :disabled')));

    assert.equal(disabled, true, title);
  }

  await page.getByRole('button', { name: names.skip }).click();
  await waitState(f, (state) => state.active.step === 'project');
  await page.getByRole('textbox', { name: names.title }).waitFor();
  assert.match(await page.locator('[aria-current="step"]').innerText(), /Проект/);
  await page.getByText(/ИИ.*пропущ|пропущ.*ИИ/i).first().waitFor();

  const dir = await repository(f.root);

  await fillProject(page, [dir]);
  await page.getByRole('button', { name: names.next }).click();
  await waitState(f, (state) => state.active.step === 'workspace');
  await page.getByRole('radio', { name: /Каждая задача в своей копии/i }).waitFor();
  assert.match(await page.locator('[aria-current="step"]').innerText(), /Где работают задачи/);
  assert.equal(await page.getByRole('button', { name: /Проект.*(готов|выполнен)/i }).count(), 0,
    'готовый проект не создаётся повторным кликом по метке');
});

test('ONB-AI-01: статусы, общий installer, login без Enter и немедленный refresh', async (t) => {
  const cards = [
    {
      ...card,
      id: 'claude',
      name: 'Claude',
      installed: false,
      available: false,
      authLabel: 'Нет входа',
    },
    {
      ...card,
      id: 'codex',
      name: 'Codex',
      installed: true,
      available: false,
      authLabel: 'Нет входа',
    },
    {
      ...card,
      id: 'kimi',
      name: 'Kimi',
      installed: true,
      available: true,
      chatEnabled: true,
    },
    {
      ...card,
      id: 'setup-only',
      name: 'Только настройка',
      installed: true,
      available: true,
      chatEnabled: false,
    },
  ];

  for (const item of cards) {
    item.installation = { ...item.installation, loginCommand: `${item.id} login` };
  }

  const f = await aiPage(t, { providers: cards });
  const { page } = f;
  const refreshed = [];
  const installationPosts = [];
  let installation = snapshot();

  await page.route('**/api/providers/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    if (pathname === '/api/providers/claude/install/start') {
      installationPosts.push(route.request().postDataJSON());
      installation = snapshot(null, 1, {
        claude: job({
          operation: 'install',
          status: 'succeeded',
          outcome: 'installed',
          stage: 'models',
          finishedAt: 1_700_000_001_000,
        }),
      });
      await route.fulfill({ status: 202, json: installation });

      return;
    }
    if (pathname === '/api/providers/installations/current') {
      await route.fulfill({ json: installation });

      return;
    }

    await route.continue();
  });

  await page.getByText('Claude', { exact: true }).last().waitFor();
  await page.getByText(/не установлен/i).first().waitFor();
  await page.getByText(/нет входа|не выполнен вход/i).first().waitFor();
  await page.getByText('Готов к работе', { exact: true }).waitFor();
  assert.equal(await page.getByText('Готов к работе', { exact: true }).count(), 1,
    'setup-only не объявлен готовым для чатов');
  await page.getByRole('button', { name: /установить.*Claude|установить/i }).last().click();

  const confirmation = page.getByRole('dialog').last();

  await confirmation.waitFor();
  assert.equal(installationPosts.length, 0);
  assert.ok((await confirmation.innerText()).includes(cards[0].installation.installCommand));
  await confirmation.getByRole('button', { name: /^(Установить|Install)$/ }).click();
  await page.locator('[data-role="provider-install-dialog"]').waitFor();
  assert.equal(await page.locator('[data-role="provider-install-dialog"]').count(), 1);
  assert.deepEqual(installationPosts, [{}], 'Команда берётся сервером, браузер посылает пустое тело');
  await page.keyboard.press('Escape');


  await page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    window.__onboardingTerminalCalls = [];
    pinia._s.get('dock').$onAction(({ name, args }) => {
      if (name === 'enqueue' && args[0] === 'terminal') {
        window.__onboardingTerminalCalls.push(args[1]);
      }
    });
  });
  await page.getByRole('button', { name: /войти.*Codex|войти/i }).first().click();
  await page.waitForFunction(() => window.__onboardingTerminalCalls.length > 0);

  const terminalCalls = await page.evaluate(() => window.__onboardingTerminalCalls);

  const loginCommand = cards.find((item) => item.id === 'codex').installation.loginCommand;

  assert.deepEqual(terminalCalls, [{ type: 'insert', text: loginCommand }]);
  assert.equal(terminalCalls[0].text.includes('\n'), false);

  await page.route('**/api/providers*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();

      return;
    }

    refreshed.push(route.request().url());
    await route.fulfill({ json: {
      providers: cards.map((item) => ({
        ...item,
        authLabel: 'Вход выполнен',
        available: true,
      })),
      models: [],
    } });
  });
  await page.getByRole('button', { name: /Проверить снова|Check again/i }).click();
  assert.ok(refreshed.some((url) => new URL(url).searchParams.get('refresh') === '1'));
  await page.getByText('Вход выполнен', { exact: true }).first().waitFor();


});

test('ONB-SKIP-01: предупреждение и подтверждённый пропуск восстанавливаются', async (t) => {
  const f = await aiPage(t, { providers: [] });

  await f.page.getByText(/без ИИ конвейер работать не будет/i).waitFor();
  await f.page.getByRole('button', { name: names.skip }).click();

  const state = await waitState(f, (value) => value.active.step === 'project');

  assert.equal(state.active.aiSkipped, true);
  await f.page.reload({ waitUntil: 'domcontentloaded' });
  await f.page.getByRole('textbox', { name: names.title }).waitFor();
  assert.equal((await request(f.app)).active.aiSkipped, true);
});

test('ONB-PROJECT-UI: несколько папок проверяются сразу, ветка своя у каждой', async (t) => {
  requireWizard();

  const f = await wizardBrowser(t);

  await atProject(f, 'manual');

  const first = await repository(f.root, 'first');
  const second = await repository(f.root, 'second');
  const page = await f.newPage({ route: '#/onboarding' });

  await fillProject(page, [first, second], 'Два репозитория');
  assert.equal(await page.getByRole('combobox', { name: names.branch }).nth(0).inputValue(), 'main');
  await page.getByRole('combobox', { name: names.branch }).nth(1).selectOption('feature');
  await page.getByRole('button', { name: names.next }).click();

  const state = await waitState(f, (value) => value.active.step === 'workspace');

  assert.deepEqual(state.active.draft.repositories.map((repo) => repo.baseBranch), ['main', 'feature']);
  assert.equal((await f.app.projects.read(state.active.projectId)).repos.length, 2);
  assert.ok(f.calls.filter((call) => call.url.endsWith('/repository')).length >= 2);
});

for (const mode of ['local', 'remote', 'browser', 'phone', 'old-desktop']) {
  test(`ONB-PICKER-UI: выбор папки ${mode} и отмена`, async (t) => {
    requireWizard();

    const profile = {
      id: 'fixture',
      name: 'Машина',
      kind: mode === 'remote' ? 'remote' : 'local',
      address: 'http://127.0.0.1:12345',
    };
    const shell = mode === 'browser' || mode === 'phone' ? null : {
      rev: 1,
      profile,
      profiles: [profile],
      status: 'online',
      detail: null,
      localAvailable: true,
      capabilities: mode === 'old-desktop' ? [] : ['selectDirectory'],
      serverApi: { major: 0, minor: 1 },
      appApi: { major: 0, minor: 1 },
    };
    const f = await wizardBrowser(t, { shell });

    await atProject(f, 'manual');

    const page = await f.newPage({ route: '#/onboarding', touch: mode === 'phone' });
    const picker = page.getByRole('button', { name: /Выбрать папку|Choose folder|Select folder/i });
    const path = page.getByRole('textbox', { name: names.path }).first();

    assert.equal(await path.isEditable(), true);

    if (mode !== 'local') {
      assert.equal(await picker.count(), 0);

      return;
    }

    const directory = await repository(f.root);
    let canceled = true;
    const nativeCalls = [];

    await page.route('**/__shell/directory/select', async (route) => {
      nativeCalls.push(route.request().postDataJSON());
      await route.fulfill({ json: { path: canceled ? null : directory } });
    });
    await picker.click();
    assert.equal(await path.inputValue(), '');
    canceled = false;
    await picker.click();
    await waitState(f, (state) => state.active.draft.repositories[0].source === directory);
    assert.equal(await path.inputValue(), directory);
    assert.deepEqual(nativeCalls, [{ profileId: profile.id }, { profileId: profile.id }]);
  });
}

test('ONB-MODE-UI: isolated по умолчанию, shared и выбранная ветка после reload', async (t) => {
  requireWizard();

  const f = await wizardBrowser(t);
  let state = await atWorkspace(f, 'manual');
  const page = await f.newPage({ route: '#/onboarding' });

  assert.equal(await page.getByRole('radio', { name: /Каждая задача в своей копии/i }).isChecked(), true);
  await page.getByText(/несколько задач|параллельно/i).first().waitFor();
  await page.getByText(/правки.*не трогает|не трогает.*правки/i).first().waitFor();
  await page.getByText(/следующ/i).first().waitFor();
  await page.getByRole('radio', { name: /Прямо в моей папке/i }).check();
  state = await waitState(f, (value) => value.active.draft.workspace.mode === 'shared');
  await page.getByText(/по одной задаче/i).first().waitFor();
  await page.getByText(/уже запущенн/i).first().waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.getByRole('radio', { name: /Прямо в моей папке/i }).isChecked(), true);
  assert.equal((await request(f.app)).active.id, state.active.id);
});

for (const locale of ['ru', 'en']) {
  test(`ONB-MODE-UI: shared при ветке feature объясняет различие (${locale})`, async (t) => {
    requireWizard();

    const f = await wizardBrowser(t);
    let state = await atProject(f, 'manual');
    const dir = await repository(f.root);

    state = await request(f.app, 'PATCH', '', {
      ...token(state),
      draft: {
        title: 'Мой магазин',
        repositories: [{
          name: 'repo1',
          source: dir,
          baseBranch: 'feature',
        }],
        workspace: { mode: 'isolated' },
      },
    });
    await request(f.app, 'POST', '/advance', token(state));

    const page = await f.newPage({ route: '#/onboarding', locale });

    await page.getByRole('radio', { name: /Прямо в моей папке|Directly in my folder/i }).check();
    await page.getByText(/feature.*main|main.*feature/).first().waitFor();

    const saved = await waitState(f, (value) => value.active.draft.workspace.mode === 'shared');

    assert.equal(saved.active.draft.repositories[0].baseBranch, 'feature');

    const { git } = await import('../server/helpers/onboardingFixture.js');

    assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
  });
}

for (const step of ['ai', 'project', 'workspace', 'summary']) {
  test(`ONB-DISMISS-UI: ${step} ждёт ACK и открывает обычное место настройки`, async (t) => {
    requireWizard();

    const f = await wizardBrowser(t);

    if (step === 'ai') {
      await request(f.app, 'POST', '/start', { expectedRevision: 0, mode: 'manual' });
    } else if (step === 'project') {
      await atProject(f, 'manual');
    } else {
      const state = await atWorkspace(f, 'manual');

      if (step === 'summary') {
        await request(f.app, 'POST', '/advance', token(state));
      }
    }

    const page = await f.newPage({ route: '#/onboarding' });
    let release;
    const gate = new Promise((resolve) => {
    release = resolve;
  });

    f.controls.intercept = async (_route, call) => {
      if (call.url.endsWith('/dismiss')) {
        await gate;
      }

      return false;
    };

    try {
      await page.getByRole('button', { name: names.dismiss }).click();
      assert.equal(new URL(page.url()).hash, '#/onboarding');
    } finally {
      release();
    }

    await page.waitForURL(/#\/projects/);
    assert.equal((await request(f.app)).autoOpenDisabled, true);

    if (step === 'ai') {
      const settings = page.locator('[data-role="settings-modal"]');

      await settings.waitFor();
      await settings.locator('[data-page="agents.providers"]').waitFor();
      await settings.getByRole('heading', { name: /исполнител|provider/i }).waitFor();
    }
  });
}

test('ONB-SUMMARY-01: итог, ручной остаток, ссылка и completed без нового start', async (t) => {
  requireWizard();

  const f = await wizardBrowser(t);
  const state = await atWorkspace(f, 'manual');

  await request(f.app, 'POST', '/advance', token(state));

  const page = await f.newPage({ route: '#/onboarding' });

  await page.getByText(state.active.draft.title, { exact: true }).waitFor();

  for (const pattern of [/разбор проекта.*стенд/i, /маршрут/i, /включени.*конвейер/i, /вручную/i]) {
    await page.getByText(pattern).first().waitFor();
  }

  const link = page.locator('a[href*="source=grigdesk"][href*="pipeline-sample"]');

  assert.equal(await link.getAttribute('href'),
    '#/documents?source=grigdesk&path=server%2Fseed%2Fpipeline-sample%2FREADME.md');
  await page.getByRole('button', { name: /ещё проект|another project/i }).waitFor();
  assert.equal(f.calls.filter((call) => call.url.endsWith('/start')).length, 0);
});
