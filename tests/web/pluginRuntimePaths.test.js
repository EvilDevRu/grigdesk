import assert from 'node:assert/strict';
import test from 'node:test';

import pluginRuntimePlugin from '../../web/scripts/pluginRuntimePlugin.mjs';

/**
 * В Windows абсолютный путь и ID выходного фасада могут иметь разные разделители.
 * HTML должен получить карту для тех же двух entry из текущей сборки.
 */
test('plugin runtime matches Vite facade paths across Windows separators', () => {
  const plugin = pluginRuntimePlugin();
  const bundle = {};

  plugin.configResolved({ command: 'build' });
  plugin.buildStart.call({
    emitFile(entry) {
      const fileName = `assets/${entry.name}-fixture.js`;

      bundle[fileName] = {
        type: 'chunk',
        facadeModuleId: entry.id.replaceAll('/', '\\'),
        fileName,
      };
    },
  });

  const html = plugin.transformIndexHtml.handler('<head></head>', { bundle });

  assert.match(html, /"vue":"\.\/assets\/plugin-vue-fixture\.js"/u);
  assert.match(html, /"@grigdesk\/ui":"\.\/assets\/plugin-ui-fixture\.js"/u);
});
