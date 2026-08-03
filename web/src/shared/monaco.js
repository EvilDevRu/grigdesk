// Общая обвязка Monaco для всех вьюх кокпита (диф приёмки, плагин «Код»).
// Ядро редактора + подсветка всех базовых языков (Monarch, главный поток).
// НЕ тянем language/typescript|json (им нужны свои воркеры и они сыплют «Missing requestHandler»);
// для read-only просмотра языковые сервисы не нужны — только подсветка.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/basic-languages/monaco.contribution';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

// Воркер один: editor.worker (в нём же считается сравнение для дифа).
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Тема под палитру кокпита (определяется один раз на модуль).
monaco.editor.defineTheme('cockpit-dark', {
  base: 'vs-dark', inherit: true, rules: [],
  colors: {
    'editor.background': '#0a0c10',
    'editorGutter.background': '#0a0c10',
    'editor.foreground': '#e7eaf0',
    'editorLineNumber.foreground': '#3a4453',
    'editorLineNumber.activeForeground': '#8a93a3',
    'diffEditor.insertedLineBackground': '#3fb95015',
    'diffEditor.removedLineBackground': '#f0564c15',
    'diffEditor.insertedTextBackground': '#3fb95028',
    'diffEditor.removedTextBackground': '#f0564c28',
    'editorWidget.background': '#151b24',
    'editorOverviewRuler.border': '#00000000',
    'scrollbarSlider.background': '#2e374288',
    'scrollbarSlider.hoverBackground': '#2e3742cc',
  },
});

// Язык по расширению файла (подсветка).
const LANG = {
  php: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', vue: 'html', json: 'json', css: 'css', scss: 'scss',
  html: 'html', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell',
  py: 'python', sql: 'sql', xml: 'xml', env: 'ini', ini: 'ini', blade: 'html',
};
export function langOf(p) { const ext = (p.split('.').pop() || '').toLowerCase(); return LANG[ext] || 'plaintext'; }

// Общие опции read-only редакторов. Фичи, которым нужен языковой воркер
// (у нас только editor.worker), выключены — чтобы не сыпать в консоль.
export const READONLY_OPTS = {
  theme: 'cockpit-dark', readOnly: true, automaticLayout: true,
  fontSize: 12.5, lineHeight: 18,
  minimap: { enabled: false }, scrollBeyondLastLine: false,
  links: false, occurrencesHighlight: 'off', stickyScroll: { enabled: false }, codeLens: false,
};

export { monaco };
