import type { Component } from '../../web/node_modules/vue/dist/vue.js';
import type {
  PluginBaseContext, PluginModuleContext, PluginModuleStart, PluginPanelProps,
  PluginPresentation, PluginUiModule,
} from '../../packages/plugin-types/src/web.js';
import { createPluginContext } from '../../web/src/pluginRuntime/context.ts';
import { createPluginContextServices } from '../../web/src/pluginRuntime/contextServices.ts';
import { loadPluginModule } from '../../web/src/pluginRuntime/loader.ts';
import PluginModulePanel from '../../web/src/views/ext/PluginModulePanel.vue';

// PUBLIC-WEB-CONTEXT: реальные фабрики совместимы с публичными портами.
declare const base: Awaited<ReturnType<typeof createPluginContext>>;
declare const services: ReturnType<typeof createPluginContextServices>;
const publicBase: PluginBaseContext = base;
const context: PluginModuleContext = services.context;
const response: Promise<unknown> = context.api.get('/api/fixture', { signal: context.signal });

context.api.post('/api/fixture', {}, {
  timeoutMs: 1,
  idleTimeoutMs: 1,
  retry: false,
});
context.api.put('/api/fixture', {});
context.api.patch('/api/fixture', {});
context.api.del('/api/fixture', {});
context.t('author.ownKey', { name: 'Плагин' }, 'Запасной текст');

const off: () => void = context.events.on('ready', (data) => {
  void data;
}, { lifetime: 'background' });
const shown: boolean = context.alerts.show({
  id: 'ready',
  title: 'Готово',
  tone: 'accent',
});

context.alerts.dismiss('ready');
context.alerts.clear();

const chat: Promise<string> = context.askAgent({
  workdir: { kind: 'grigdesk' },
  title: 'Плагин',
  draft: 'Черновик',
});
const opened: Promise<boolean> = context.panel.open();
const closed: Promise<boolean> = context.panel.close();
const expanded: boolean = context.panel.setExpanded(true);
// @ts-expect-error PUBLIC-WEB-CONTEXT: locale readonly.
context.locale.value = 'en';
// @ts-expect-error PUBLIC-WEB-CONTEXT: settings readonly.
context.settings.value.changed = true;
// @ts-expect-error PUBLIC-WEB-CONTEXT: неподдержанный срок подписки.
context.events.on('ready', () => {}, { lifetime: 'forever' });
context.alerts.show({
  id: 'bad',
  title: 'Ошибка',
  // @ts-expect-error PUBLIC-WEB-CONTEXT: неподдержанный тон.
  tone: 'invalid-tone',
});
// @ts-expect-error PUBLIC-WEB-CONTEXT: чужой id не принимается.
context.panel.open('another-plugin');
// @ts-expect-error PUBLIC-WEB-CONTEXT: workdir обязателен.
context.askAgent({ title: 'Плагин', draft: 'Черновик' });
// @ts-expect-error PUBLIC-WEB-CONTEXT: options есть только у get/post.
context.api.put('/api/fixture', {}, { signal: context.signal });

// PUBLIC-MODULE-START: loader сохраняет тип optional hook.
declare const loaded: Awaited<ReturnType<typeof loadPluginModule>>;
const start: PluginModuleStart | undefined = loaded.start;
declare const component: Component;
const module: PluginUiModule = { default: component, start: async () => () => {} };
// @ts-expect-error PUBLIC-MODULE-START: cleanup должен быть функцией.
const invalidStart: PluginModuleStart = () => 42;

// PUBLIC-PANEL-PRESENTATION: тип настоящего SFC не расширяется до string.
declare const panelProps: InstanceType<typeof PluginModulePanel>['$props'];
const presentation: PluginPresentation | undefined = panelProps.presentation;
const props: PluginPanelProps = {
  context,
  active: true,
  compact: false,
  presentation: 'placeholder',
};
// @ts-expect-error PUBLIC-PANEL-PRESENTATION: неизвестный режим не допускается.
const invalidProps: PluginPanelProps = { context, presentation: 'floating' };

void [publicBase, response, off, shown, chat, opened, closed, expanded, start, module,
  invalidStart, presentation, props, invalidProps];
