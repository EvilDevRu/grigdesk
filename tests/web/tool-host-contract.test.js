import { migrationUrl } from './helpers/compile-vue.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const root = new URL('../../', import.meta.url);
const source = (path) => readFile(migrationUrl(path.slice(4)), 'utf8');
const count = (text, pattern) => (text.match(pattern) || []).length;

test('AppShell держит один ToolHost, а route-adapter не монтирует вторую панель', async () => {
  let files;
  try {
    files = await Promise.all([
      source('web/src/shared/layout/AppShell.vue'),
      source('web/src/shared/layout/ToolHost.vue'),
      source('web/src/views/CodeView.vue'),
      source('web/src/views/ShelfView.vue'),
      source('web/src/views/TerminalView.vue'),
    ]);
  } catch (error) {
    assert.fail(`Route-adapter полки ещё не реализован: ${error.message}`);
  }
  const [shell, host, codeRoute, shelfRoute, terminalRoute] = files;

  assert.equal(count(shell, /<ToolHost\b/g), 1);
  assert.match(shell, /<ToolHost v-if="workspaceStarted"/);
  assert.equal(count(host, /<component\s+:is="item\.component"/g), 1);
  // Состав панелей — computed из встроенных и страниц плагинов, а не статический список.
  assert.match(host, /v-for="item in tools"/);
  assert.match(host, /const tools = computed\(\(\) => toolsOf\(plugins\)\)/);
  assert.doesNotMatch(codeRoute, /import\s+CodePanel/);
  assert.doesNotMatch(shelfRoute, /import\s+TaskShelfPanel/);
  assert.doesNotMatch(terminalRoute, /import\s+TerminalPanel/);
  assert.match(codeRoute, /data-tool-route="code"/);
  assert.match(shelfRoute, /data-tool-route="shelf"/);
  assert.match(terminalRoute, /data-tool-route="terminal"/);
});

test('Code, Shelf, Terminal, SSH, DB и Докер лениво загружаются независимо', async () => {
  const [registry, codeLoading, asyncView, panelLoading] = await Promise.all([
    source('web/src/shared/tools/registry.ts'),
    source('web/src/views/code/codePanelLoading.ts'),
    source('web/src/shared/asyncView.ts'),
    source('web/src/shared/tools/panelLoading.ts'),
  ]);

  // Шесть встроенных панелей и единственная модульная панель плагина.
  // Удаление старого канала не меняет независимую ленивую загрузку соседей.
  assert.equal(count(registry, /asyncView\(/g), 7);
  assert.doesNotMatch(registry, /PluginFramePanel/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/ext\/PluginModulePanel\.vue'\)/);
  assert.doesNotMatch(registry, /views\/studio3d\/Studio3dPanel\.vue/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/code\/CodePanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/shelf\/TaskShelfPanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/terminal\/TerminalPanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/ssh\/SshPanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/db\/DbPanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/docker\/DockerPanel\.vue'\)/);
  assert.match(registry, /CodePanel\.vue'\), panelLoading\('code'\)\)/);
  assert.match(panelLoading, /code:\s*CodePanelLoading/);
  assert.match(asyncView, /delay: 0/);
  assert.match(asyncView, /errorComponent: LoadFailure/);
  assert.match(asyncView, /timeout: 30000/);
  assert.match(codeLoading, /'aria-busy': 'true'/);
  assert.match(codeLoading, /class: \['code-loading-layout', \{ compact: props\.compact \}\]/);
  assert.match(codeLoading, /class: 'code-loading-rail'/);
  assert.doesNotMatch(codeLoading, /code-loading-tabs/);
  assert.doesNotMatch(codeLoading, /from ['"][^'"]*monaco|import\s+.*TerminalPanel|new WebSocket/i);
  assert.doesNotMatch(registry, /Promise\.all/);
});

test('Узкий route полки объявлен как tool и не создаёт отдельный dock state', async () => {
  const [router, catalog, dock] = await Promise.all([
    source('web/src/router.ts'),
    source('web/src/shared/tools/catalog.ts'),
    source('web/src/stores/dock.ts'),
  ]);

  assert.deepEqual({
    route: /path:\s*['"]\/shelf['"][\s\S]*meta:\s*\{[^}]*tool:\s*['"]shelf['"]/.test(router),
    registry: /id:\s*['"]shelf['"][\s\S]*route:\s*['"]\/shelf['"]/.test(catalog),
    separateShelfState: /shelf(?:Dock|Open|Mounted)\s*:/i.test(dock),
  }, {
    route: true,
    registry: true,
    separateShelfState: false,
  });
});

test('планшет 760–899 остаётся route-only, док и третья колонка начинаются с 900', async () => {
  const [viewport, shell, host] = await Promise.all([
    source('web/src/shared/tools/viewport.ts'),
    source('web/src/shared/layout/AppShell.vue'),
    source('web/src/shared/layout/ToolHost.vue'),
  ]);

  assert.match(viewport, /DOCK_BREAKPOINT = 900/);
  assert.match(shell, /@media \(max-width: 899px\)/);
  assert.match(shell, /grid-template-columns: var\(--app-rail-w\) minmax\(0, 1fr\);/);
  assert.match(shell, /\.dock-route-nav \{ display: flex; \}/);
  assert.match(shell, /grid-template-columns: var\(--app-rail-w\) minmax\(0, 1fr\) var\(--app-rail-w\);/);
  assert.match(host, /@media \(max-width: 899px\) \{ \.tool-rail \{ display: none; \} \}/);
});

test('desktop-сайдбар всегда узкий и не содержит переключателя или плитки обновлений', async () => {
  const shell = await source('web/src/shared/layout/AppShell.vue');

  assert.doesNotMatch(shell, /collapse-btn|toggleSidebar|grigdesk-sidebar|GrigDeskVersionTile/);
  assert.match(shell, /grid-row: 1; grid-column: 1 \/ -1;/);
  assert.match(shell, /grid-row: 2; grid-column: 1;/);
  assert.match(shell, /class="app-mark"/);
});

test('док использует строку инструмента, а разворачивание меняет только геометрию того же render-site',
  async (t) => {
  const [dockView, host, dockStore] = await Promise.all([
    source('web/src/shared/layout/ToolDock.vue'),
    source('web/src/shared/layout/ToolHost.vue'),
    source('web/src/stores/dock.ts'),
  ]);

  assert.doesNotMatch(dockView, /class="dock-head"/);
  assert.doesNotMatch(dockView, /grid-template-rows:\s*42px/);
  await installUiBrowser(t);

  const [{ mount }, Dock] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/shared/layout/ToolDock.vue')),
  ]);
  const wrapper = mount(Dock, {
    attachTo: document.body,
    props: {
      mode: 'dock',
      label: 'Панель',
      width: 400,
      minWidth: 200,
      maxWidth: 800,
    },
  });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.get('[data-context="tool-dock-expand"]').attributes('aria-label'), 'Во весь экран');
  await wrapper.setProps({ expanded: true });
  assert.equal(wrapper.get('[data-context="tool-dock-expand"]').attributes('aria-label'),
    'Вернуть ширину панели');
  assert.match(dockView, /:pressed="expanded"/);
  assert.match(dockView, /mode === 'dock' && !expanded/);
  assert.match(dockView, /emit\('toggle-expanded'\)/);
  assert.doesNotMatch(dockView, /--tool-dock-action-size:\s*30px;/);
  assert.match(dockView, /var\(--tool-dock-action-size/);
  assert.match(dockView, /--tool-dock-action-top:\s*4px;/);
  assert.match(host, /function toggleDockExpanded\(\)\s*{\s*dock\.toggleExpanded\(\);\s*}/);
  assert.match(host, /:expanded="expandedOf\(item\.id\)" :expanded-width="contentWidth"/);
  assert.match(host, /@toggle-expanded="toggleDockExpanded"/);
  assert.doesNotMatch(host, /function maximizeTool/);
  assert.match(dockStore, /isExpanded: false/);
  assert.match(dockStore, /DOCK_EXPANDED_KEY = 'grigdesk-dock-expanded-tools'/);
  assert.match(dockStore, /LEGACY_DOCK_EXPANDED_KEY = 'grigdesk-dock-expanded'/);
  assert.match(dockStore, /expandedPreferences: storedExpandedPreferences\(activeTool\)/);
  assert.match(dockStore, /expandedPreferences\[state\.activeTool\] === true/);
  assert.match(
    dockStore,
    new RegExp(
      String.raw`setExpanded\(value(?:: unknown)?, \{ persist = true \}` +
      String.raw`(?:: \{ persist\?: boolean \})? = \{\}\)(?:: void)?`,
    ),
  );
  assert.match(dockStore, /close\(\)\s*{[\s\S]*this\.isExpanded = false;/);
  assert.match(dockStore, /this\.isExpanded = this\.isOpen && this\.expandedPreference/);
});

test('Escape у развёрнутого дока сначала возвращает ширину и не создаёт второй слой', async () => {
  const [host, shell] = await Promise.all([
    source('web/src/shared/layout/ToolHost.vue'),
    source('web/src/shared/layout/AppShell.vue'),
  ]);

  assert.match(host, /function closeDockLayer\(\)[\s\S]*dock\.isExpanded[\s\S]*dock\.setExpanded\(false\)[\s\S]*hideDock\(\)/);
  assert.equal(count(host, /useUiLayer\('dock'/g), 1);
  assert.match(host, /useUiLayer\('dock', \{[\s\S]*id: 'tool-dock'[\s\S]*onEscape: closeDockLayer/);
  assert.match(host, /watch\(\(\) => route\.path,[\s\S]*dock\.isExpanded[\s\S]*dock\.setExpanded\(false, \{ persist: false \}\)/);
  assert.match(shell, /<main class="content"[^>]*:inert="toolDock\.isExpanded"/);
  assert.match(shell, /:aria-hidden="toolDock\.isExpanded \? 'true' : undefined"/);
});

test('Code держит рейку разделов и навигатор слева от Monaco и меняет ширину разделителем', async () => {
  const [code, actions, dock] = await Promise.all([
    source('web/src/views/code/CodePanel.vue'),
    source('web/src/styles/components/actions.css'),
    source('web/src/shared/layout/ToolDock.vue'),
  ]);

  assert.match(code, /grigdesk-code-dock-nav-width/);
  assert.match(code, /aria-orientation="vertical"/);
  // Рейка — первая колонка сетки; её ширина одна и та же в CSS-переменной и в расчёте
  // координаты разделителя. Шапка вкладок не держит.
  assert.match(code, /<aside class="rail" aria-label="Разделы кода">/);
  assert.match(code, /const RAIL_WIDTH = 44;/);
  assert.match(code, /'--code-rail-width': `\$\{RAIL_WIDTH\}px`/);
  assert.match(code, /clientX - rect\.left - RAIL_WIDTH/);
  assert.match(code, /\.lay \{[\s\S]*grid-template-columns: var\(--code-rail-width, 44px\) minmax/);
  assert.match(code, /\.lay \.rail \{ grid-column:\s*1/);
  assert.match(code, /\.lay \.panel \{[\s\S]*grid-column:\s*2/);
  assert.match(code, /\.lay \.editorwrap \{ grid-column:\s*4/);
  assert.match(code, /\.code-split \{[\s\S]*grid-column:\s*3[\s\S]*cursor:\s*col-resize/);
  assert.match(code, /\.lay\.code-narrow \{ grid-template-columns: var\(--code-rail-width, 44px\) minmax\(0, 1fr\); \}/);
  assert.doesNotMatch(code, /<UiTabs/);
  assert.match(actions, /\.ui-icon-button\[data-context='code-rail-item'\]\[aria-pressed='true'\]/);
  assert.match(dock, /:deep\(\.code-loading-rail\) \{[\s\S]*grid-column: 1;/);
  assert.match(dock, /:deep\(\.code-loading-layout\) \{[\s\S]*grid-template-columns: 44px minmax/);
  assert.match(code, /const NAVIGATOR_MIN_WIDTH = 220/);
  assert.match(code, /const NAVIGATOR_DEFAULT_WIDTH = 320/);
  assert.doesNotMatch(code, /grigdesk-code-dock-split/);
  assert.match(code, /Math\.floor\(width \* 0\.42\)/);
  assert.match(code, /:aria-valuemax="Math\.round\(navigatorMaxWidth\)"/);
  assert.match(code, /--code-nav-width/);
  assert.match(code, /class="navigator-toggle"[\s\S]*?data-context="workspace-toolbar"/);
  assert.match(
    actions,
    /data-context='tool-dock-navigator'\] \{[\s\S]*height:\s*var\(--tool-dock-action-size, 30px\);[\s\S]*min-height:\s*var\(--tool-dock-action-size, 30px\);/,
  );
  assert.match(code,
    /<UiPaneHeader class="code-pane-heading" :data-ui-host-actions="compact \? '' : undefined"/);
});
