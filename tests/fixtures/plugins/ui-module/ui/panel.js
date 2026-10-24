import { h, ref, reactive, withDirectives } from 'vue';
import { UiButton, UiInput, UiDialog, confirmDialog, useUiLayer, vTooltip } from '@grigdesk/ui';
import { helperText } from './helper.js';

globalThis.__pluginEntryExecutions = (globalThis.__pluginEntryExecutions || 0) + 1;

export const runtimeProbe = {
   ref,
  reactive,
  UiButton,
  confirmDialog,
  useUiLayer
};


const b1 = reactive({
  starts: 0,
  cleanups: 0,
  progress: ''
});

globalThis.__pluginB1 = b1;

/**
 * Запуск использует переданный общий контекст и отдельный срок фоновой подписки.
 * Очистка кооперативна: её счётчик позволяет увидеть лишний старт или потерю cleanup.
 */
export function start(context) {
  b1.starts += 1;
  globalThis.__pluginBackgroundContext = context;

  const off = context.events?.on('fixture-progress', (data) => {
    b1.progress = String(data);
  }, { lifetime: 'background' });

  return () => {
    off?.();
    b1.cleanups += 1;
  };
}

export default {
  props: ['context', 'active', 'compact', 'presentation'],
  /**
   * Готовый render-компонент использует общие элементы окна и переданный context.
   * Локальный ввод позволяет заметить нежелательное пересоздание при смене языка.
   */
  setup(props) {
    const text = ref('');
    const dialog = ref(false);
    const response = ref('');
    const panelEvent = ref('');
    const error = ref('');

    globalThis.__pluginPanelContext = props.context;
    props.context.events?.on('panel-progress', (data) => {
      panelEvent.value = String(data);
    });

    globalThis.__pluginFixtureExecutions = (globalThis.__pluginFixtureExecutions || 0) + 1;

    return () => h('section', {
      class: 'plugin-runtime-fixture',
      'data-compact': String(props.compact),
      'data-presentation': props.presentation,
    }, [
      h('p', { 'data-plugin-greeting': '' }, props.context.t('greeting', { name: 'Мир' })),
      h('p', { 'data-plugin-helper': '' }, helperText),
      h('output', { 'data-plugin-event': '' }, b1.progress),
      h('output', { 'data-plugin-panel-event': '' }, panelEvent.value),
      h('output', { 'data-plugin-error': '' }, error.value),
      ...(props.context.panel ? [
        h(UiButton, { onClick: () => props.context.alerts.show({
          id: 'fixture',
          title: props.context.t('b1.notification'),
          sticky: true,
        }) }, () => props.context.t('b1.notify')),
        h(UiButton, {
          onClick: () => props.context.alerts.dismiss('fixture'),
        }, () => props.context.t('b1.dismiss')),
        h(UiButton, { onClick: () => props.context.panel.open() }, () => props.context.t('b1.open')),
        h(UiButton, { onClick: () => props.context.panel.close() }, () => props.context.t('b1.close')),
        h(UiButton, {
          onClick: () => props.context.panel.setExpanded(true),
        }, () => props.context.t('b1.expand')),
        h(UiButton, { onClick: async () => {
          try {
            await props.context.askAgent({
              workdir: { kind: 'grigdesk' },
              title: 'Проверка B1',
              draft: 'Черновик B1',
            });
          } catch (failure) {
            error.value = failure.message;
          }
        } }, () => props.context.t('b1.ask')),
      ] : []),
      h('p', { 'data-plugin-settings': '' }, JSON.stringify(props.context.settings.value)),
      h(UiInput, {
        'aria-label': 'Ввод плагина',
        modelValue: text.value,
        'onUpdate:modelValue': (value) => {
           text.value = value;
        },
      }),
      h(UiButton, { onClick: () => {
         dialog.value = true;
      } }, () => 'Диалог плагина'),
      withDirectives(h(UiButton, {}, () => 'Подсказка плагина'), [[vTooltip, 'Общая подсказка']]),
      h(UiButton, {
        onClick: async () => {
           response.value = await props.context.api.get('/api/fixture/echo');
        },
      }, () => 'Запрос плагина'),
      h('output', { 'data-plugin-response': '' }, JSON.stringify(response.value)),
      h(UiDialog, {
        open: dialog.value,
        title: 'Диалог модуля',
        'onUpdate:open': (value) => {
           dialog.value = value;
        },
      }, {
        default: () => h(UiButton, {
          onClick: () => confirmDialog('Подтвердить из плагина?'),
        }, () => 'Подтверждение плагина'),
      }),
    ]);
  },
};
