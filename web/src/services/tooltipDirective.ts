import type { DirectiveBinding, ObjectDirective } from 'vue';

import type { UiOverlayPlacement } from '../types/uiOverlays.ts';
import { isKeyboardFocus, isTouchPointer } from './tooltipInput.ts';
import {
  forgetTooltipTarget,
  hideTooltip,
  releaseTooltip,
  requestTooltip,
  updateTooltip,
  type TooltipTarget,
} from './tooltips.ts';

interface DirectiveState {
  text: string;
  placement: UiOverlayPlacement;
  description: string | null;
  suppressed: boolean;
  handlers: Record<string, EventListener>;
}

const states = new WeakMap<TooltipTarget, DirectiveState>();

function normalize(value: unknown): string {
  return value === null || value === undefined || value === false ? '' : String(value).trim();
}

function side(binding: DirectiveBinding<unknown>): UiOverlayPlacement {
  return (['top', 'right', 'bottom', 'left'] as const)
    .find((placement) => binding.modifiers[placement]) ?? 'top';
}

/**
 * Директива снимает только описание, которое сама записала и которым ещё владеет.
 * Собственное имя и описание поля остаются независимыми от визуальной справки.
 */
function syncAttributes(el: TooltipTarget, state: DirectiveState): void {
  if (state.description !== null && el.getAttribute('aria-description') === state.description) {
    el.removeAttribute('aria-description');
  }

  state.description = null;

  if (!state.text) {
    el.removeAttribute('data-ui-tooltip');

    return;
  }

  el.setAttribute('data-ui-tooltip', state.text);

  if (!el.hasAttribute('aria-description') && el.getAttribute('aria-label')?.trim() !== state.text) {
    el.setAttribute('aria-description', state.text);
    state.description = state.text;
  }
}

/**
 * Все обработчики привязаны к корневой цели и читают её актуальный текст.
 * Их ссылки хранятся вместе с состоянием для точного снятия при размонтировании.
 */
function mounted(el: TooltipTarget, binding: DirectiveBinding<unknown>): void {
  const state: DirectiveState = {
    text: normalize(binding.value),
    placement: side(binding),
    description: null,
    suppressed: false,
    handlers: {},
  };

  state.handlers = {
    pointerenter: (event) => {
      if (!isTouchPointer(event) && !state.suppressed) {
        requestTooltip(el, state.text, state.placement, 'pointer');
      }
    },
    pointerdown: () => {
      hideTooltip();
      state.suppressed = true;
    },
    focusin: (event) => {
      const target = event.target as Element;

      if (!state.suppressed && target.closest('[data-ui-tooltip]') === el && isKeyboardFocus(event)) {
        requestTooltip(el, state.text, state.placement, 'focus');
      }
    },
    focusout: (event) => {
      const next = (event as FocusEvent).relatedTarget;

      if (!(next instanceof Node) || !el.contains(next)) {
        state.suppressed = false;
        releaseTooltip(el, 'focus');
      }
    },
    pointerleave: () => {
      state.suppressed = false;
      releaseTooltip(el, 'pointer');
    },
  };

  states.set(el, state);
  syncAttributes(el, state);

  for (const [event, handler] of Object.entries(state.handlers)) {
    el.addEventListener(event, handler);
  }
}

/**
 * Обновляем текст и сторону существующей цели без нового запроса на показ.
 * Пустое значение снимает только атрибуты, которыми владела директива.
 */
function updated(el: TooltipTarget, binding: DirectiveBinding<unknown>): void {
  const state = states.get(el);
  const text = normalize(binding.value);
  const placement = side(binding);

  if (!state || (state.text === text && state.placement === placement)) {
    return;
  }

  state.text = text;
  state.placement = placement;
  syncAttributes(el, state);
  updateTooltip(el, text, placement);
}

/**
 * Удалённая цель не оставляет слушателей и не может воскреснуть из таймера сервиса.
 * Чужое описание, изменённое после mounted, сохраняется даже на отсоединённом элементе.
 */
function beforeUnmount(el: TooltipTarget): void {
  const state = states.get(el);

  if (!state) {
    return;
  }

  for (const [event, handler] of Object.entries(state.handlers)) {
    el.removeEventListener(event, handler);
  }

  forgetTooltipTarget(el);
  state.text = '';
  syncAttributes(el, state);
  states.delete(el);
}

// Публичная директива используется через фасад UI; состояние остаётся приватным.
// Один набор обработчиков сопровождает цель от mounted до beforeUnmount.
export const vTooltip: ObjectDirective<TooltipTarget, unknown> = {
  mounted,
  updated,
  beforeUnmount,
};
