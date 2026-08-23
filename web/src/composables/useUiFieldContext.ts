import {
  computed,
  inject,
  provide,
  toValue,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';

export interface UiFieldContext {
  controlId: Ref<string> | ComputedRef<string>;
  describedBy: ComputedRef<string | undefined>;
  invalid: ComputedRef<boolean>;
  required: Ref<boolean> | ComputedRef<boolean>;
}

const UI_FIELD_CONTEXT: InjectionKey<UiFieldContext> = Symbol('ui-field-context');

export function provideUiFieldContext(context: UiFieldContext): void {
  provide(UI_FIELD_CONTEXT, context);
}

export function useUiFieldContext(): UiFieldContext | null {
  return inject(UI_FIELD_CONTEXT, null);
}

export function mergeUiDescribedBy(...values: Array<string | null | undefined>): string | undefined {
  const ids = values.flatMap((value) => String(value || '').split(/\s+/)).filter(Boolean);
  return ids.length ? [...new Set(ids)].join(' ') : undefined;
}

export function useResolvedFieldState(options: {
  id?: MaybeRefOrGetter<string | undefined>;
  describedBy?: MaybeRefOrGetter<string | undefined>;
  invalid?: MaybeRefOrGetter<boolean | undefined>;
  required?: MaybeRefOrGetter<boolean | undefined>;
}) {
  const field = useUiFieldContext();
  return {
    id: computed(() => toValue(options.id) || field?.controlId.value),
    describedBy: computed(() => mergeUiDescribedBy(toValue(options.describedBy), field?.describedBy.value)),
    invalid: computed(() => Boolean(toValue(options.invalid) || field?.invalid.value)),
    required: computed(() => Boolean(toValue(options.required) || field?.required.value)),
  };
}
