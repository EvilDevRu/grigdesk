import { defineComponent, onBeforeUnmount, watch } from 'vue';
import type { PropType } from 'vue';
import type { SurfaceKind } from '../../../shared/web-log/surfacePerformance.ts';
import { beginSurfaceIntent } from './surfaceIntents.ts';

export default defineComponent({
  name: 'PerformanceBoundary',
  props: {
    kind: { type: String as PropType<SurfaceKind>, required: true },
    target: { type: Function as PropType<() => string>, required: true },
    identity: { type: Function as PropType<() => string | null>, required: true },
  },
  /**
   * Родитель регистрирует намерение до setup дочерней панели.
   * Синхронная подписка сохраняет раннюю корреляцию при повторном показе.
   */
  setup(props, { slots }) {
    let cancel = () => {};

    watch(() => props.identity(), (key) => {
      cancel();
      cancel = key === null ? () => {} : beginSurfaceIntent({
        kind: props.kind,
        target: props.target(),
        key,
      });
    }, { immediate: true, flush: 'sync' });
    onBeforeUnmount(() => cancel());

    return () => slots.default?.();
  },
});
