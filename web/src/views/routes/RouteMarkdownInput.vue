<template><div ref="host" class="route-markdown-input" data-escape-owner="monaco"></div></template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type * as Monaco from 'monaco-editor/editor/editor.api';

const props = withDefaults(defineProps<{
  modelValue: string;
  language?: 'markdown' | 'json';
}>(), { language: 'markdown' });
const emit = defineEmits<{
  'update:modelValue': [value: string];
  save: [];
  blur: []
}>();
const host = ref<HTMLElement | null>(null);
let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
let model: Monaco.editor.ITextModel | null = null;
let disposed = false;

defineExpose({ focus: () => editor?.focus() });

onMounted(async () => {
  const { monaco } = await import('../../shared/monaco.ts');

  if (disposed || !host.value) {
    return;
  }

  model = monaco.editor.createModel(props.modelValue, props.language);
  editor = monaco.editor.create(host.value, {
    model,
    theme: 'grigdesk-dark',
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  });
  editor.onDidChangeModelContent(() => emit('update:modelValue', model?.getValue() ?? ''));
  editor.onDidBlurEditorText(() => emit('blur'));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'));
});

watch(() => props.modelValue, (value) => {
  if (model && model.getValue() !== value) {
    model.setValue(value);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  editor?.dispose();
  model?.dispose();
  editor = null;
  model = null;
});
</script>

<style scoped>
.route-markdown-input { min-height: 180px; height: 28vh; border: 1px solid var(--line); }
</style>
