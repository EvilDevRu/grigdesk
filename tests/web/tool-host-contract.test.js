import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const count = (text, pattern) => (text.match(pattern) || []).length;

test('AppShell держит один ToolHost, а route-adapter не монтирует вторую панель', async () => {
  const [shell, host, codeRoute, terminalRoute] = await Promise.all([
    source('web/src/shared/layout/AppShell.vue'),
    source('web/src/shared/layout/ToolHost.vue'),
    source('web/src/views/CodeView.vue'),
    source('web/src/views/TerminalView.vue'),
  ]);

  assert.equal(count(shell, /<ToolHost\s*\/>/g), 1);
  assert.equal(count(host, /<component\s+:is="item\.component"/g), 1);
  assert.match(host, /v-for="item in TOOL_REGISTRY"/);
  assert.doesNotMatch(codeRoute, /import\s+CodePanel/);
  assert.doesNotMatch(terminalRoute, /import\s+TerminalPanel/);
  assert.match(codeRoute, /data-tool-route="code"/);
  assert.match(terminalRoute, /data-tool-route="terminal"/);
});

test('Code и Terminal лениво загружаются независимо', async () => {
  const [registry, codeLoading] = await Promise.all([
    source('web/src/shared/tools/registry.js'),
    source('web/src/views/code/CodePanelLoading.js'),
  ]);

  assert.equal(count(registry, /defineAsyncComponent\(/g), 2);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/code\/CodePanel\.vue'\)/);
  assert.match(registry, /import\('\.\.\/\.\.\/views\/terminal\/TerminalPanel\.vue'\)/);
  assert.match(registry, /loadingComponent: CodePanelLoading/);
  assert.match(registry, /delay: 0/);
  assert.match(codeLoading, /'aria-busy': 'true'/);
  assert.match(codeLoading, /class: \['code-loading-layout', \{ compact: props\.compact \}\]/);
  assert.doesNotMatch(codeLoading, /from ['"][^'"]*monaco|import\s+.*TerminalPanel|new WebSocket/i);
  assert.doesNotMatch(registry, /Promise\.all/);
});

test('планшет 760–899 остаётся route-only, док и третья колонка начинаются с 900', async () => {
  const [viewport, shell, host] = await Promise.all([
    source('web/src/shared/tools/viewport.js'),
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
  assert.match(dockView, /:aria-pressed="expanded"/);
  assert.match(dockView, /mode === 'dock' && !expanded/);
  assert.match(dockView, /emit\('toggle-expanded'\)/);
  assert.match(dockView, /--tool-dock-action-size:\s*30px;/);
  assert.match(dockView, /--tool-dock-action-top:\s*4px;/);
  assert.match(host, /function toggleDockExpanded\(\)\s*{\s*dock\.toggleExpanded\(\);\s*}/);
  assert.match(host, /:expanded="expandedOf\(item\.id\)" :expanded-width="contentWidth"/);
  assert.match(host, /@toggle-expanded="toggleDockExpanded"/);
  assert.doesNotMatch(host, /function maximizeTool/);
  assert.match(dockStore, /isExpanded: false/);
  assert.match(dockStore, /DOCK_EXPANDED_KEY = 'cockpit-dock-expanded'/);
  assert.match(dockStore, /expandedPreference: stored\(DOCK_EXPANDED_KEY\) === '1'/);
  assert.match(dockStore, /setExpanded\(value, \{ persist = true \} = \{\}\)/);
  assert.match(dockStore, /close\(\)\s*{[\s\S]*this\.isExpanded = false;/);
  assert.match(dockStore, /else if \(!wasOpen\) this\.isExpanded = this\.expandedPreference/);
});

test('Escape у развёрнутого дока сначала возвращает ширину и не создаёт второй слой', async () => {
  const [host, shell] = await Promise.all([
    source('web/src/shared/layout/ToolHost.vue'),
    source('web/src/shared/layout/AppShell.vue'),
  ]);

  assert.match(host, /function closeDockLayer\(\)[\s\S]*dock\.isExpanded[\s\S]*dock\.setExpanded\(false\)[\s\S]*hideDock\(\)/);
  assert.equal(count(host, /registerLayer\('tool-dock'/g), 1);
  assert.match(host, /registerLayer\('tool-dock', \{ priority: 80, close: closeDockLayer \}\)/);
  assert.match(host, /watch\(\(\) => route\.path,[\s\S]*dock\.isExpanded[\s\S]*dock\.setExpanded\(false, \{ persist: false \}\)/);
  assert.match(shell, /<main class="content" :inert="toolDock\.isExpanded"/);
  assert.match(shell, /:aria-hidden="toolDock\.isExpanded \? 'true' : undefined"/);
});

test('compact Code держит дерево слева от Monaco и меняет его ширину вертикальным разделителем', async () => {
  const code = await source('web/src/views/code/CodePanel.vue');

  assert.match(code, /cockpit-code-dock-nav-width/);
  assert.match(code, /aria-orientation="vertical"/);
  assert.match(code, /\.lay\.compact \.panel \{[\s\S]*grid-column:\s*2/);
  assert.match(code, /\.lay\.compact \.editorwrap \{ grid-column:\s*4/);
  assert.match(code, /\.code-split \{[\s\S]*grid-column:\s*3[\s\S]*cursor:\s*col-resize/);
  assert.doesNotMatch(code, /cockpit-code-dock-split/);
  assert.match(code, /Math\.floor\(width \* 0\.42\)/);
  assert.match(code, /:aria-valuemax="Math\.round\(navigatorMaxWidth\)"/);
  assert.match(code, /--code-nav-width/);
  assert.match(code, /\.navigator-toggle \{[\s\S]*height:\s*var\(--tool-dock-action-size, 30px\);[\s\S]*padding-block:\s*0/);
  assert.match(code, /\.code-panel\.compact \.code-head \{[\s\S]*padding:\s*var\(--tool-dock-action-top, 4px\)[^;]*5px 11px;/);
});
