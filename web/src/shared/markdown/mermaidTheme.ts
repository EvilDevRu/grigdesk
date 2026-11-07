const THEME_COLORS: Record<string, [string, string]> = {
  primaryColor: ['--surface', '#151b24'],
  primaryTextColor: ['--ink', '#e7eaf0'],
  primaryBorderColor: ['--line-2', '#2e3742'],
  lineColor: ['--accent', '#5aa2ff'],
  secondaryColor: ['--surface-2', '#1c222c'],
  tertiaryColor: ['--ground', '#0a0c10'],
  background: ['--ground', '#0a0c10'],
  mainBkg: ['--surface', '#151b24'],
  nodeBorder: ['--line-2', '#2e3742'],
  textColor: ['--ink', '#e7eaf0'],
  edgeLabelBackground: ['--ground', '#0a0c10'],
  // Без явных значений Mermaid выводит доли и строки атрибутов из тёмного primaryColor:
  // доли круговой сливаются, а строка ER получает светлый фон под светлым текстом.
  pie1: ['--accent', '#5aa2ff'],
  pie2: ['--good', '#3fb950'],
  pie3: ['--warn', '#e0a33a'],
  pie4: ['--bad', '#f0564c'],
  pie5: ['--node-code', '#37b7c3'],
  pie6: ['--node-agent', '#e0873f'],
  pieStrokeColor: ['--ground', '#0a0c10'],
  pieOuterStrokeColor: ['--line-2', '#2e3742'],
  pieSectionTextColor: ['--ground', '#0a0c10'],
  pieTitleTextColor: ['--ink', '#e7eaf0'],
  pieLegendTextColor: ['--ink', '#e7eaf0'],
  rowOdd: ['--surface', '#151b24'],
  rowEven: ['--surface-2', '#1c222c'],
};

/**
 * Палитра протокола содержит только разрешённые переменные темы Mermaid.
 * Без документа используется та же тёмная палитра, что у интерфейса GrigDesk.
 */
export function mermaidThemeVariables(documentImpl?: Document): Record<string, string> {
  const style = documentImpl?.defaultView?.getComputedStyle(documentImpl.documentElement);

  return Object.fromEntries(Object.entries(THEME_COLORS).map(([name, [variable, fallback]]) => {
    const color = style?.getPropertyValue(variable).trim() || '';

    return [name, /^#[a-f\d]{3,8}$/i.test(color) ? color : fallback];
  }));
}
