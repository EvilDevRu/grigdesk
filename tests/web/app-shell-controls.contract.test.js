import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { shellContractBrowser } from './helpers/shell-contract-browser.js';

const APP_SHELL_PATH = new URL('../../web/src/shared/layout/AppShell.vue', import.meta.url);
const PROVIDER_USAGE_PATH = new URL(
  '../../web/src/features/providers/ProviderUsageResources.vue',
  import.meta.url,
);
const PIPELINE_POPOVER_PATH = new URL(
  '../../web/src/features/pipeline/PipelineTopbarPopover.vue',
  import.meta.url,
);
const ACTIONS_PATH = new URL('../../web/src/styles/components/actions.css', import.meta.url);

test('AppShell использует public UI controls и общую поверхность инструментов', async (t) => {
  const [source, providerUsage, pipelinePopover, actions] = await Promise.all([
    readFile(APP_SHELL_PATH, 'utf8'),
    readFile(PROVIDER_USAGE_PATH, 'utf8'),
    readFile(PIPELINE_POPOVER_PATH, 'utf8'),
    readFile(ACTIONS_PATH, 'utf8'),
  ]);
  const publicUiImport = source.match(/import\s*\{([^}]*)\}\s*from '\.\.\/\.\.\/ui';/u);

  assert.ok(publicUiImport);
  assert.match(publicUiImport[1], /\bUiButton\b/u);
  assert.match(publicUiImport[1], /\bUiIconButton\b/u);
  assert.match(publicUiImport[1], /\bUiPressable\b/u);
  // Знак обновления, метрики и сеть открываются с клавиатуры через общий pressable.
  assert.equal([...source.matchAll(/<UiPressable\b/gu)].length, 5);
  assert.equal([...source.matchAll(/<UiButton\b/gu)].length, 1);
  assert.doesNotMatch(source, /instbar|installDismissed/u);

  const providerSection = /<span v-if="runtimeProviders.length"[\s\S]*?class="netbox mono"/u;
  const outsideProviders = source.replace(providerSection, '');

  assert.equal([...outsideProviders.matchAll(/<UiIconButton\b/gu)].length, 3);
  assert.doesNotMatch(source, /<button\b/u);

  const { page, diagnose } = await shellContractBrowser(t);

  await diagnose(async () => {
    const settings = page.getByRole('button', { name: 'Настройки', exact: true });

    assert.equal(await settings.getAttribute('aria-haspopup'), 'dialog');
    await settings.hover();
    await page.getByRole('tooltip', { name: 'Настройки', exact: true }).waitFor();

    const gear = source.match(/<UiIconButton\b[^>]*:pressed="settings.isOpen"[^>]*>/u)?.[0] ?? '';

    assert.match(gear, /v-tooltip=/u);
    assert.match(gear, /aria-haspopup="dialog"/u);
    assert.match(gear, /:pressed="settings.isOpen"/u);
    assert.doesNotMatch(source, /<router-link to="\/settings"/u);
    assert.match(source, /<UiTopbarPanel[^>]*v-model:open="toolsOpen"[^>]*layer="tools"/u);
    assert.match(source, /attachment="trigger"\s+placement="right-start"/u);
    assert.match(source, /<ToolsGrid[^>]*layout="list"/u);
    assert.doesNotMatch(source, /placeToolsPopover|toolsOutside/u);
    assert.doesNotMatch(source, /\.pu-state button|\.ptip-go button|\.instbar button/u);
    assert.match(source, /data-context="topbar-popover-action"/u);
    assert.match(source, /data-context="topbar-popover-settings"/u);
    assert.match(source, /data-context="topbar-popover-refresh"/u);
    assert.match(source, /data-context="topbar-popover-update"/u);
    assert.doesNotMatch(source, /data-context="topbar-popover-footer"/u);
    assert.match(source, /<BoardTimerPopover/u);
    assert.match(source, /:tasks="topbarTimerTasks"/u);
    assert.match(source, /:worked-today-hours="workedTodayHours"/u);
    assert.match(source, /:busy-task-id="timerActionTaskId(?: \?\? undefined)?"/u);
    assert.match(source, /@toggle-timer="toggleBoardTimer"/u);
    assert.match(source, /<PipelineTopbarPopover/u);
    assert.match(source, /:items="notifyWatch\.topbarItems"/u);
    assert.doesNotMatch(source, /:(?:running|stopped)-count=/u);
    assert.doesNotMatch(source, /:has-errors=/u);
    assert.match(source, /@open-pipeline="openPipeline"/u);
    assert.doesNotMatch(source, /<router-link[^>]*data-context="pipeline-topbar"/u);
    assert.match(source, /total: notifyWatch\.topbarItems\.length/u);
    assert.match(source, /v-if="!phoneLayout && topbarTimerTasks\.length && pipelineTopbar\.total"/u);
    assert.match(source, /<PipelineTopbarPopover\s+v-if="!phoneLayout && pipelineTopbar\.total"/u);
    assert.match(source, /v-if="topbarTimerTasks\.length \|\| \(!phoneLayout && pipelineTopbar\.total\)"/u);
    assert.match(source, /useTasksStore/u);
    assert.match(source, /await taskStore\.timer\(task\.id, action\)/u);
    assert.match(source, /boardStore\.data\?\.today\?\.hours \?\? 0/u);
    assert.ok(
      source.indexOf('<SystemResourcesButton') < source.indexOf('<BoardTimerPopover'),
      'индикатор таймеров должен стоять после динамических CPU/RAM',
    );
    assert.match(providerUsage, /data-context="topbar-popover-confirm"/u);
    assert.match(providerUsage, /data-context="topbar-popover-resource-link"/u);
    assert.match(pipelinePopover, /<UiTopbarPanel/u);
    assert.match(pipelinePopover, /data-context="pipeline-topbar"/u);
    assert.match(pipelinePopover, /pipeline-topbar-running">\{\{ runningCount \}\}/u);
    assert.match(pipelinePopover, /pipeline-topbar-waiting"[^>]*>\s*\{\{ waitingCount \}\}/u);
    assert.match(pipelinePopover, /pipeline-topbar-issues"[^>]*>\s*\{\{ issueCount \}\}/u);
    assert.match(pipelinePopover, /trigger-mode="both"/u);
    assert.match(pipelinePopover, /@click="openPipeline\(close\)"/u);
    assert.match(
      actions,
      /data-context='topbar-popover-action'\][^{]*\{[^}]*height:\s*28px;/u,
    );
    assert.match(
      actions,
      /data-context='topbar-popover-footer'\][^{]*\{[^}]*height:\s*30px;/u,
    );
    // Шапка всплывашки — строка имени, а не панель: иконки в ней меньше ручек панелей.
    assert.match(
      actions,
      /data-context='topbar-popover-update'\][^{]*\{[^}]*width:\s*22px;/u,
    );
    assert.match(
      actions,
      /data-context='topbar-popover-settings'\]\s*svg[^{]*\{[^}]*width:\s*14px;/u,
    );
    assert.match(
      actions,
      /data-context='topbar-popover-resource-link'\][^{]*\{[^}]*height:\s*auto;/u,
    );
    assert.match(
      actions,
      /data-context='topbar-popover-resource-link'\][^{]*\{[^}]*white-space:\s*normal;/u,
    );
    assert.match(
      actions,
      /data-context='board-timers-topbar'\][^{]*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/u,
    );
    assert.match(
      actions,
      /data-context='pipeline-topbar'\][^{]*\{[^}]*height:\s*28px;[^}]*background:\s*transparent;/u,
    );
    assert.match(actions, /data-context='topbar-timer-toggle'/u);
  });
});

// Всплывашка исполнителя: имя вместо строки фактов, обновление — точкой справа, беда
// со ссылкой на состояние вендора СВЕРХУ, деньги аккаунта — только на чтение.
test('всплывашка исполнителя короткая и сама ведёт к причине сбоя', async (t) => {
  const [source, actions] = await Promise.all([
    readFile(APP_SHELL_PATH, 'utf8'),
    readFile(ACTIONS_PATH, 'utf8'),
  ]);

  assert.match(source, /<b class="ptip-name">\{\{ p\.name \}\}<\/b>/u);
  assert.doesNotMatch(source, /<span>\{\{ provTitle\(p\) \}\}<\/span>/u);
  assert.match(source, /class="ptip-upd"/u);
  assert.match(source, /usedUsagePercent\(b\.pct\)/u);

  const h = await shellContractBrowser(t);

  await h.diagnose(async () => {
    await h.openProvider();
    await h.page.locator('.pu-head b').hover();
    await h.page.getByRole('tooltip', { name: 'Израсходовано: 42% окна «Неделя»', exact: true }).waitFor();
    assert.equal(await h.page.locator('.ptip-off').textContent(), 'недоступен');
    assert.match(source, /data-context="topbar-popover-status-link"/u);
    assert.match(source, /:href="statusHintOf\(p\)!?\.url"/u);
    assert.match(source, /<ProviderUsageResources[\s\S]*?readonly[\s\S]*?\/>/u);
    // Класс `.ptip` и подвал `.ptip-go` носит ещё и всплывашка «мозга», поэтому всё
    // остальное сверяем внутри блока исполнителя: от его шапки до соседнего блока сети.
    const popover = source.slice(
      source.indexOf('<template #title>'),
      source.indexOf('class="netbox mono"'),
    );

    // Переход в настройки — иконка в шапке, а не полоса во всю ширину внизу: место
    // всплывашки уходит лимитам.
    assert.doesNotMatch(popover, /class="ptip-go"/u);
    assert.doesNotMatch(popover, /data-context="topbar-popover-footer"/u);
    assert.ok(
      popover.indexOf('data-context="topbar-popover-settings"') < popover.indexOf('class="pu-state"'),
      'шестерёнка настроек живёт в шапке, выше беды лимитов',
    );

    assert.ok(
      popover.indexOf('class="pu-state"') < popover.indexOf('<span class="pu">'),
      'беда лимитов должна стоять выше самих полос',
    );

    // Свежесть цифр держит открытая всплывашка, а не наведение на ряд иконок: раньше
    // лимиты читались один раз на ховер и дальше стояли, сколько бы она ни висела.
    assert.match(source, /@open="usageWatch\.open\(p\.id\)"/u);
    assert.match(source, /@close="usageWatch\.close\(p\.id\)"/u);

    const usageCallback = source.match(/createUsageWatch\(\(\) => \{([\s\S]*?)\}\)/u)?.[1] ?? '';

    assert.match(usageCallback, /usageNow\.value = Date\.now\(\);/u);
    assert.match(usageCallback, /return prov\.loadUsage\(true\);/u);
    assert.doesNotMatch(source, /@mouseenter="prov\.loadUsage\(\)"/u);
    assert.doesNotMatch(source, /@pointerdown="prov\.loadUsage\(\)"/u);
    // Установку новой версии начинают из самой всплывашки: раньше точка о ней только
    // сообщала. Ход один на GrigDesk, поэтому кнопка ждёт чужую установку тоже.
    assert.match(source, /<ProviderInstallDialog\b/u);
    assert.match(source, /useProviderInstallStore/u);
    assert.doesNotMatch(source, /api\.post\(`\/api\/providers\/\$\{[^}]*\}\/update`/u);
    assert.match(
      actions,
      /data-context='topbar-popover-status-link'\][^{]*\{[^}]*height:\s*auto;/u,
    );
  });
});

test('TIP-MIG-01: каждая иконка постоянной рейки имеет доступное имя', async () => {
  const { parse } = await import('../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js');
  const source = await readFile(APP_SHELL_PATH, 'utf8');
  const { descriptor } = parse(source);
  const targets = [];

  /**
   * Имя требуется у каждой цели навигации, поскольку видимых подписей больше нет.
   * Разбор шаблона не путает атрибуты с CSS-селекторами или текстом script.
   */
  function visit(node) {
    const navigationTarget = (node.props ?? []).some((prop) =>
      prop.type === 6 && prop.name === 'data-ui-shell-nav');

    if (navigationTarget) {
      targets.push(node);
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
    for (const branch of node.branches ?? []) {
      visit(branch);
    }
  }

  visit(descriptor.template.ast);
  // Обе раскладки сохраняют доступные имена: четыре цели рейки и две нижней навигации.
  assert.equal(targets.length, 6);

  for (const node of targets) {
    const named = node.props.some((prop) => (prop.type === 6 && prop.name === 'aria-label')
      || (prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'aria-label'));

    assert.equal(named, true, `${node.tag}:${node.loc.start.line}`);
  }
});
