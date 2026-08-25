// Синхронный каркас для lazy CodePanel. Здесь намеренно нет импорта Monaco:
// компонент должен появиться сразу, пока тяжёлый chunk ещё только загружается.
import { defineComponent, h } from 'vue';

const navigatorIcon = () => h('svg', {
  viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5',
  'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
}, [
  h('rect', { x: '2.5', y: '3', width: '15', height: '14', rx: '2' }),
  h('path', { d: 'M7 3v14' }),
]);

function storedNavigatorWidth() {
  try {
    const value = Number(localStorage.getItem('cockpit-code-dock-nav-width'));
    return Number.isFinite(value) && value > 0 ? Math.min(420, Math.max(140, value)) : 260;
  } catch {
    return 260;
  }
}

export default defineComponent({
  name: 'CodePanelLoading',
  inheritAttrs: false,
  props: {
    compact: { type: Boolean, default: false },
  },
  setup(props) {
    const navigatorWidth = storedNavigatorWidth();
    return () => h('div', {
      class: ['code-panel-loading', { compact: props.compact }],
      role: 'status',
      'aria-label': 'Загрузка кода',
      'aria-busy': 'true',
    }, [
      h('header', { class: 'code-loading-head' }, [
        h('strong', 'Код'),
        h('span', { class: 'code-loading-grow' }),
        props.compact ? h('span', { class: 'code-loading-navigator', 'aria-hidden': 'true' }, [
          navigatorIcon(),
          h('span', 'Дерево'),
        ]) : null,
      ]),
      h('div', {
        class: ['code-loading-layout', { compact: props.compact }],
        style: { '--code-loading-nav-width': `${navigatorWidth}px` },
      }, [
        h('aside', { class: 'code-loading-rail', 'aria-hidden': 'true' }, [
          h('span'), h('span'),
        ]),
        h('aside', { class: 'code-loading-panel', 'aria-hidden': 'true' }, [
          h('div', { class: 'code-loading-tree' }, Array.from({ length: 7 }, (_, index) => (
            h('span', { style: { width: `${48 + (((index + 1) * 17) % 38)}%` } })
          ))),
        ]),
        props.compact ? h('div', { class: 'code-loading-split', 'aria-hidden': 'true' }, [h('span')]) : null,
        h('section', { class: 'code-loading-editor', 'aria-hidden': 'true' }, [
          h('div', { class: 'code-loading-editor-head' }, [h('span')]),
          h('div', { class: 'code-loading-editor-body' }, 'Загрузка кода…'),
        ]),
      ]),
    ]);
  },
});
