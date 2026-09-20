import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
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

  assert.equal(count(shell, /<ToolHost\s*\/>/g), 1);
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
  const [registry, codeLoading] = await Promise.all([
    source('web/src/shared/tools/registry.ts'),
    source('web/src/views/code/codePanelLoading.ts'),
  ]);

  // Шесть встроенных панелей плюс одна общая панель-iframe для страниц плагинов.
  assert.equal(count(registry, /defineAsyncComponent\(/g), 7);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/ext\/PluginFramePanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/code\/CodePanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/shelf\/TaskShelfPanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/terminal\/TerminalPanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/ssh\/SshPanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/db\/DbPanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/docker\/DockerPanel\.vue'\)/);
  assert.match(registry, /loadingComponent: CodePanelLoading/);
  assert.match(registry, /delay: 0/);
  assert.match(codeLoading, /'aria-busy': 'true'/);
  assert.match(codeLoading, /class: \['code-loading-layout', \{ compact: props\.compact \}\]/);
  assert.doesNotMatch(codeLoading, /code-loading-rail/);
  assert.doesNotMatch(codeLoading, /from ['"][^'"]*monaco|import\s+.*TerminalPanel|new WebSocket/i);
  assert.doesNotMatch(registry, /Promise\.all/);
});

test('Узкий route полки объявлен как tool и не создаёт отдельный dock state', async () => {
  const [router, catalog, dock] = await Promise.all([
    source('web/src/router.js'),
    source('web/src/shared/tools/catalog.ts'),
    source('web/src/stores/dock.js'),
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
  assert.match(shell, /@media \(min-width: 760px\) and \(max-width: 899px\)/);
  assert.match(shell, /grid-template-columns: 62px minmax\(0, 1fr\);/);
  assert.match(shell, /\.dock-route-nav \{ display: flex; \}/);
  assert.match(shell, /@media \(min-width: 900px\) and \(max-width: 1099px\)/);
  assert.match(shell, /grid-template-columns: 62px minmax\(0, 1fr\) 44px;/);
  assert.match(host, /@media \(max-width: 899px\) \{ \.tool-rail \{ display: none; \} \}/);
});

test('переключатель desktop-сайдбара закреплён снизу, а смена ширины не происходит скачком', async () => {
  const shell = await source('web/src/shared/layout/AppShell.vue');

  assert.match(shell, /\.collapse-btn \{ margin-top: auto; \}/);
  assert.match(shell, /transition: grid-template-columns \.16s ease-out;/);
  assert.match(shell, /prefers-reduced-motion: reduce[\s\S]*\.shell \{ transition: none; \}/);
  assert.match(
    shell,
    /@media \(min-width: 760px\) and \(max-width: 899px\)[\s\S]*\.dock-route-nav \{ display: flex; \}[\s\S]*\.collapse-btn \{ margin-top: 4px; \}/,
  );
});

test('док использует строку инструмента, а разворачивание меняет только геометрию того же render-site', async () => {
  const [dockView, host, dockStore] = await Promise.all([
    source('web/src/shared/layout/ToolDock.vue'),
    source('web/src/shared/layout/ToolHost.vue'),
    source('web/src/stores/dock.js'),
  ]);

  assert.doesNotMatch(dockView, /class="dock-head"/);
  assert.doesNotMatch(dockView, /grid-template-rows:\s*42px/);
  assert.match(dockView, /expanded \? 'Вернуть ширину панели' : 'Во весь экран'/);
  assert.match(dockView, /:pressed="expanded"/);
  assert.match(dockView, /mode === 'dock' && !expanded/);
  assert.match(dockView, /emit\('toggle-expanded'\)/);
  assert.match(dockView, /--tool-dock-action-size:\s*30px;/);
  assert.match(dockView, /--tool-dock-action-top:\s*4px;/);
  assert.match(host, /function toggleDockExpanded\(\)\s*{\s*dock\.toggleExpanded\(\);\s*}/);
  assert.match(host, /:expanded="expandedOf\(item\.id\)" :expanded-width="contentWidth"/);
  assert.match(host, /@toggle-expanded="toggleDockExpanded"/);
  assert.doesNotMatch(host, /function maximizeTool/);
  assert.match(dockStore, /isExpanded: false/);
  assert.match(dockStore, /DOCK_EXPANDED_KEY = 'cockpit-dock-expanded-tools'/);
  assert.match(dockStore, /LEGACY_DOCK_EXPANDED_KEY = 'cockpit-dock-expanded'/);
  assert.match(dockStore, /expandedPreferences: storedExpandedPreferences\(activeTool\)/);
  assert.match(dockStore, /expandedPreferences\[state\.activeTool\] === true/);
  assert.match(dockStore, /setExpanded\(value, \{ persist = true \} = \{\}\)/);
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
  assert.match(shell, /<main class="content" :inert="toolDock\.isExpanded"/);
  assert.match(shell, /:aria-hidden="toolDock\.isExpanded \? 'true' : undefined"/);
});

test('Code держит навигатор слева от Monaco и меняет его ширину разделителем', async () => {
  const [code, actions] = await Promise.all([
    source('web/src/views/code/CodePanel.vue'),
    source('web/src/styles/components/actions.css'),
  ]);

  assert.match(code, /cockpit-code-dock-nav-width/);
  assert.match(code, /aria-orientation="vertical"/);
  assert.match(code, /\.lay \.panel \{[\s\S]*grid-column:\s*1/);
  assert.match(code, /\.lay \.editorwrap \{ grid-column:\s*3/);
  assert.match(code, /\.code-split \{[\s\S]*grid-column:\s*2[\s\S]*cursor:\s*col-resize/);
  assert.doesNotMatch(code, /<aside class="rail"/);
  assert.doesNotMatch(code, /clientX - rect\.left - 44/);
  assert.match(code, /const NAVIGATOR_MIN_WIDTH = 220/);
  assert.match(code, /const NAVIGATOR_DEFAULT_WIDTH = 320/);
  assert.doesNotMatch(code, /cockpit-code-dock-split/);
  assert.match(code, /Math\.floor\(width \* 0\.42\)/);
  assert.match(code, /:aria-valuemax="Math\.round\(navigatorMaxWidth\)"/);
  assert.match(code, /--code-nav-width/);
  assert.match(code, /data-context="tool-dock-navigator"/);
  assert.match(
    actions,
    /data-context='tool-dock-navigator'\] \{[\s\S]*height:\s*var\(--tool-dock-action-size, 30px\);[\s\S]*min-height:\s*var\(--tool-dock-action-size, 30px\);/,
  );
  assert.match(code, /\.code-panel\.compact \.code-head \{[\s\S]*padding:\s*var\(--tool-dock-action-top, 4px\)[^;]*5px 11px;/);
});
