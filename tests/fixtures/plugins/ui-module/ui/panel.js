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

    globalThis.__pluginFixtureExecutions = (globalThis.__pluginFixtureExecutions || 0) + 1;

    return () => h('section', {
      class: 'plugin-runtime-fixture',
      'data-compact': String(props.compact),
      'data-presentation': props.presentation,
    }, [
      h('p', { 'data-plugin-greeting': '' }, props.context.t('greeting', { name: 'Мир' })),
      h('p', { 'data-plugin-helper': '' }, helperText),
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
