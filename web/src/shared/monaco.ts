// Общая обвязка Monaco для всех вьюх GrigDesk (диф приёмки, плагин «Код»).
// Ядро редактора + подсветка всех базовых языков (Monarch, главный поток).
// НЕ тянем language/typescript|json (им нужны свои воркеры и они сыплют «Missing requestHandler»);
// для read-only просмотра языковые сервисы не нужны — только подсветка.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/basic-languages/monaco.contribution';
// Шрифт значков Monaco (@font-face codicon) живёт в отдельной фиче, а не в editor.api.
// Без него знаки «+»/«−» дифа и стрелки свёрнутых участков — квадратики запасного шрифта.
import 'monaco-editor/features/codicon/register';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

// Воркер один: editor.worker (в нём же считается сравнение для дифа).
declare global {
  var MonacoEnvironment: monaco.Environment | undefined;
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Тема под палитру GrigDesk (определяется один раз на модуль).
monaco.editor.defineTheme('grigdesk-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0a0c10',
    'editorGutter.background': '#0a0c10',
    'editor.foreground': '#e7eaf0',
    'editorLineNumber.foreground': '#3a4453',
    'editorLineNumber.activeForeground': '#8a93a3',
    // Фон строк и полей дифа: на тёмной теме 8% не читались как «добавлено/удалено».
    'diffEditor.insertedLineBackground': '#3fb95026',
    'diffEditor.removedLineBackground': '#f0564c26',
    'diffEditor.insertedTextBackground': '#3fb95045',
    'diffEditor.removedTextBackground': '#f0564c45',
    'diffEditorGutter.insertedLineBackground': '#3fb95040',
    'diffEditorGutter.removedLineBackground': '#f0564c40',
    'diffEditorOverview.insertedForeground': '#3fb950aa',
    'diffEditorOverview.removedForeground': '#f0564caa',
    // Свёрнутые неизменённые области остаются различимы, но не спорят с самим diff.
    'diffEditor.diagonalFill': '#1c222c66',
    'editorWidget.background': '#151b24',
    'editorOverviewRuler.border': '#00000000',
    'scrollbarSlider.background': '#2e374288',
    'scrollbarSlider.hoverBackground': '#2e3742cc',
  },
});

// Язык по расширению файла (подсветка).
const LANG: Record<string, string> = {
  php: 'php',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  py: 'python',
  sql: 'sql',
  xml: 'xml',
  env: 'ini',
  ini: 'ini',
  blade: 'html',
};

/**
 * Выбирает только встроенную подсветку по расширению файла.
 * Неизвестный формат открывается обычным текстом, без языкового сервиса.
 */
export function langOf(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();

  return LANG[ext] || 'plaintext';
}

// Общие опции read-only редакторов. Фичи, которым нужен языковой воркер
// (у нас только editor.worker), выключены — чтобы не сыпать в консоль.
export const READONLY_OPTS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'grigdesk-dark',
  readOnly: true,
  automaticLayout: true,
  fontSize: 12.5,
  lineHeight: 18,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  links: false,
  occurrencesHighlight: 'off',
  stickyScroll: { enabled: false },
  codeLens: false,
};

export { monaco };
