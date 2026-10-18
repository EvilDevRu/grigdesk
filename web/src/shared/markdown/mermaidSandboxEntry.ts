// Этот entry исполняется только в opaque iframe с CSP и не получает возможности приложения.
import mermaid from 'mermaid';

import { mermaidThemeVariables } from './mermaidTheme.ts';

const SECURE_OPTIONS = [
  ...mermaid.mermaidAPI.defaultConfig.secure || [],
  'htmlLabels', 'flowchart', 'gantt', 'theme', 'themeVariables', 'themeCSS', 'fontFamily',
  'dompurifyConfig',
];
const THEME_KEYS = Object.keys(mermaidThemeVariables());
let busy = false;
let sequence = 0;

/**
 * Недоверенная схема не задаёт конфиг; палитра принимается по фиксированному allowlist.
 * Запрет directives/frontmatter дополняет strict и CSP, не заменяя сетевую границу.
 */
async function receive(event: MessageEvent): Promise<void> {
  if (event.source !== parent || event.data?.type !== 'mermaid:render' || busy) {
    return;
  }

  const { requestId, code, theme } = event.data as Record<string, unknown>;

  if (typeof requestId !== 'string' || !/^[a-z\d-]{1,80}$/i.test(requestId)) {
    return;
  }

  const reply = (payload: { svg: string } | { error: 'render_failed' }) => parent.postMessage({
    type: 'mermaid:result',
    requestId,
    ...payload,
  }, '*');

  if (typeof code !== 'string' || !code.trim() || code.length > 50_000 ||
      /^\s*---(?:\r?\n|$)/.test(code) || /%%\s*\{/.test(code)) {
    reply({ error: 'render_failed' });

    return;
  }

  const colors = mermaidThemeVariables();
  const supplied = theme && typeof theme === 'object' ? theme as Record<string, unknown> : {};

  for (const key of THEME_KEYS) {
    const value = supplied[key];

    if (typeof value === 'string' && /^#[a-f\d]{3,8}$/i.test(value)) {
      colors[key] = value;
    }
  }

  busy = true;

  const id = `grigDeskMermaid${sequence += 1}`;

  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 300,
      secure: [...new Set(SECURE_OPTIONS)],
      theme: 'base',
      themeVariables: colors,
      fontFamily: 'system-ui, sans-serif',
      flowchart: {
        htmlLabels: false,
        wrappingWidth: 280,
      },
      // Без useWidth Гант растягивается на ширину iframe (1200 px), и в колонке чата
      // его подписи уменьшаются до нечитаемых; полные даты на оси налезают друг на друга.
      gantt: {
        useWidth: 720,
        fontSize: 12,
        sectionFontSize: 12,
        axisFormat: '%d.%m',
      },
    });

    const { svg } = await mermaid.render(id, code);

    reply(svg.length <= 2_000_000 ? { svg } : { error: 'render_failed' });
  } catch {
    reply({ error: 'render_failed' });
  } finally {
    document.getElementById(`d${id}`)?.remove();
    busy = false;
  }
}

window.addEventListener('message', receive);
parent.postMessage({ type: 'mermaid:ready' }, '*');
