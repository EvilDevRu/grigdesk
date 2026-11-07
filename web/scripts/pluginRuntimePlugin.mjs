import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = fileURLToPath(new URL('../src/pluginRuntime/', import.meta.url));
const facades = {
  vue: path.join(runtimeDir, 'vue.ts'),
  '@grigdesk/ui': path.join(runtimeDir, 'ui.ts'),
};

/**
 * Один Rollup-граф выпускает фасады и ядро с общими экземплярами модулей.
 * Карта использует хэши текущего output и не участвует в запуске самого окна.
 */
export default function pluginRuntimePlugin() {
  let building = false;

  return {
    name: 'grigdesk-plugin-runtime',
    configResolved(config) {
      building = config.command === 'build';
    },
    /**
     * Строгая сигнатура сохраняет имена экспортов даже при минификации.
     * Выпускаем entry в общем графе, чтобы не получить второй экземпляр Vue/UI.
     */
    buildStart() {
      if (!building) {
        return;
      }

      for (const [name, id] of Object.entries(facades)) {
        this.emitFile({
          type: 'chunk',
          id,
          name: name === 'vue' ? 'plugin-vue' : 'plugin-ui',
          preserveSignature: 'strict',
        });
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const imports = Object.fromEntries(Object.entries(facades).map(([name, id]) => {
          if (!building) {
            return [name, `/src/pluginRuntime/${path.basename(id)}`];
          }

          const entry = Object.values(context.bundle ?? {}).find((item) =>
            item.type === 'chunk' && item.facadeModuleId === id);

          if (!entry) {
            throw new Error(`Не выпущен фасад плагина: ${name}`);
          }

          return [name, `./${entry.fileName}`];
        }));

        return html.replace(/<head\b[^>]*>/iu, (head) =>
          `${head}\n<script type="importmap">${JSON.stringify({ imports })}</script>`);
      },
    },
    /**
     * Внешний ESM не участвует в HMR и удерживает старые ссылки на компоненты.
     * Изменение загруженного графа фасадов требует полной перезагрузки документа.
     */
    handleHotUpdate(context) {
      const roots = Object.values(facades).map((id) => context.server.moduleGraph.getModuleById(id));
      const pending = roots.filter(Boolean);
      const visited = new Set();

      while (pending.length) {
        const module = pending.pop();

        if (visited.has(module)) {
          continue;
        }

        visited.add(module);

        if (module.file === context.file) {
          context.server.ws.send({ type: 'full-reload', path: '*' });

          return [];
        }

        pending.push(...module.importedModules);
      }
    },
  };
}
