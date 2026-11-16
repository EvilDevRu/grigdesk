// SVG из изолированного renderer превращается в изображение, а не в DOM приложения.
import { mermaidThemeVariables } from './mermaidTheme.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../uiLocalePort.ts';

const t = localeTranslator(uiLocalePort);

export { mermaidThemeVariables } from './mermaidTheme.ts';

export interface MermaidImage {
  src: string;
  width: number;
  height: number;
}

const MAX_SVG_CHARS = 2_000_000;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const FORBIDDEN_NODES = new Set([
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'animate', 'animatetransform', 'set',
]);



/**
 * Оставляет только внутренние ссылки ресурсов SVG; CSS с escape отклоняется целиком.
 * Это фильтр результата: сетевую изоляцию самого рисования обеспечивает CSP iframe.
 */
function safeSvgValue(value: string): boolean {
  const withoutFragments = value.replace(/url\(\s*(['"]?)#[\w:.-]+\1\s*\)/gi, '');

  return !/url\s*\(|@import|\\|javascript:|expression\s*\(/i.test(withoutFragments);
}

/**
 * Проверяет готовый SVG перед помещением в data URL изображения.
 * Непригодный результат возвращает null и оставляет человеку исходный код схемы.
 */
export function svgToImage(svg: string, documentImpl = globalThis.document): MermaidImage | null {
  if (typeof svg !== 'string' || svg.length > MAX_SVG_CHARS || /<!DOCTYPE|<!ENTITY/i.test(svg)) {
    return null;
  }

  const Parser = documentImpl?.defaultView?.DOMParser;

  if (!Parser) {
    return null;
  }

  const parsed = new Parser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;

  if (root?.localName !== 'svg' || root.namespaceURI !== SVG_NAMESPACE ||
      parsed.querySelector('parsererror')) {
    return null;
  }

  for (const node of [root, ...root.querySelectorAll('*')]) {
    if (node.namespaceURI !== SVG_NAMESPACE || FORBIDDEN_NODES.has(node.localName.toLowerCase())) {
      return null;
    }

    if (node.localName === 'style' && !safeSvgValue(node.textContent || '')) {
      return null;
    }

    for (const attribute of [...node.attributes]) {
      const name = attribute.localName.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith('on') || !safeSvgValue(value) ||
          ((name === 'href' || name === 'src') && !/^#[\w:.-]+$/.test(value))) {
        return null;
      }
    }
  }

  const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);

  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) ||
      viewBox[2]! <= 0 || viewBox[3]! <= 0 || viewBox[2]! > 4096 || viewBox[3]! > 4096 ||
      viewBox[2]! * viewBox[3]! > 4_000_000) {
    return null;
  }

  const width = Math.ceil(viewBox[2] || 0);
  const height = Math.ceil(viewBox[3] || 0);

  if (width * height > 4_000_000) {
    return null;
  }

  root.setAttribute('width', String(width * 2));
  root.setAttribute('height', String(height * 2));
  root.removeAttribute('style');

  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(root.outerHTML)}`,
    width,
    height,
  };
}

export interface MermaidRendererOptions {
  document: Document;
  rendererUrl: string;
  timeoutMs?: number;
  waitForPaint?: () => Promise<void>;
  loadRenderer?: (url: string, signal: AbortSignal) => Promise<string>;
}

export interface MermaidRenderer {
  render(code: string, options?: { signal?: AbortSignal }): Promise<MermaidImage | null>;
  dispose(): void;
}

/**
 * Создаёт один изолированный renderer для документа и закрывает его при dispose.
 * Подменяемые документ и таймаут нужны протокольным тестам без запуска библиотеки.
 */
export function createMermaidRenderer(options: MermaidRendererOptions): MermaidRenderer {
  const documentImpl = options.document;
  const host = documentImpl.defaultView;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let frame: HTMLIFrameElement | null = null;
  let ready = false;
  let disposed = false;
  let sequence = 0;
  let active: MermaidJob | null = null;
  let rendererSource: string | null = null;
  let assetController: AbortController | null = null;
  const waiting: MermaidJob[] = [];

  /**
   * Снятый frame больше не имеет доступа к текущему requestId.
   * После отказа следующая схема создаст библиотеку заново.
   */
  function resetFrame(): void {
    assetController?.abort();
    assetController = null;
    frame?.remove();
    frame = null;
    ready = false;
  }

  /**
   * Завершение снимает таймер и подписку отмены ровно один раз.
   * Promise всегда разрешается контролируемым результатом, без rejected fallback.
   */
  function finish(result: MermaidImage | null): void {
    const job = active;

    if (!job) {
      return;
    }

    active = null;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    job.resolve(result);
    void startNext();
  }

  /**
   * В непрозрачный frame уходят только исходник и allowlist палитры.
   * Загрузка asset завершается ready до отправки первого задания.
   */
  function send(): void {
    if (!active || !frame?.contentWindow || !ready) {
      return;
    }

    frame.contentWindow.postMessage({
      type: 'mermaid:render',
      requestId: active.requestId,
      code: active.code,
      theme: mermaidThemeVariables(documentImpl),
    }, '*');
  }

  /**
   * CSP разрешает только доверенный script с nonce, без сети для схемы.
   * Видимый layout нужен измерениям Mermaid, сам frame остаётся за экраном.
   */
  function createFrame(): boolean {
    const url = new URL(options.rendererUrl, documentImpl.location.href);

    if (!/^https?:$/.test(url.protocol) || /['";<>\s\\]/.test(url.href)) {
      return false;
    }

    // getRandomValues доступен и по обычному HTTP, где randomUUID отсутствует.
    const random = globalThis.crypto.getRandomValues(new Uint32Array(4));
    const nonce = [...random].map((value) => value.toString(16).padStart(8, '0')).join('');
    const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
      "img-src data: blob:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none';";
    const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

    frame = documentImpl.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;width:1200px;height:900px;visibility:hidden';

    const head = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" ' +
      `content="${escapeAttribute(policy)}">`;

    frame.srcdoc = `${head}</head><body></body></html>`;
    documentImpl.body.appendChild(frame);
    void loadFrame(frame, url.href, head, nonce);

    return true;
  }

  /**
   * Asset получает родитель: opaque iframe не обслуживается его Service Worker.
   * Только доверенный bundle попадает в nonce-script; отменённый frame не оживает.
   */
  async function loadFrame(
    target: HTMLIFrameElement,
    url: string,
    head: string,
    nonce: string,
  ): Promise<void> {
    const controller = new AbortController();

    assetController = controller;

    try {
      const source = rendererSource ?? await (options.loadRenderer || fetchRendererSource)(
        url, controller.signal,
      );

      if (disposed || frame !== target) {
        return;
      }

      rendererSource = source;
      assetController = null;

      // JSON сохраняет код побайтово после разбора, а экранирование < защищает srcdoc
      // от закрывающего HTML script внутри строк и комментариев доверенного bundle.
      const literal = JSON.stringify(source).replaceAll('<', '\\u003c');

      target.srcdoc = `${head}<script nonce="${nonce}">` +
        'const renderer = document.createElement("script");' +
        `renderer.nonce = "${nonce}"; renderer.textContent = ${literal};` +
        'document.head.appendChild(renderer);</script></head><body></body></html>';
    } catch {
      if (frame === target && !disposed) {
        resetFrame();
        finish(null);
      }
    }
  }

  /**
   * Принимаем только сообщение текущего окна и активного задания.
   * Ошибки протокола и чрезмерные ответы не могут опубликовать произвольный HTML.
   */
  function receive(event: MessageEvent): void {
    if (!frame || event.source !== frame.contentWindow || !event.data ||
        typeof event.data !== 'object') {
      return;
    }

    const data = event.data as Record<string, unknown>;

    if (data.type === 'mermaid:ready' && !ready) {
      ready = true;
      send();

      return;
    }

    if (data.type !== 'mermaid:result' || data.requestId !== active?.requestId || !active) {
      return;
    }

    if (data.error === 'render_failed') {
      finish(null);
    } else if (typeof data.svg === 'string' && data.svg.length <= MAX_SVG_CHARS) {
      const image = svgToImage(data.svg, documentImpl);
      const job = active;

      if (image && image.width <= 16 && image.height <= 16 && !job.retried) {
        job.retried = true;
        clearTimeout(job.timer);
        active = null;
        resetFrame();
        waiting.unshift(job);
        void startNext();

        return;
      }

      finish(image && image.width <= 16 && image.height <= 16 ? null : image);
    }
  }

  /**
   * Новый frame ждёт кадр родителя: в задаче после fetch Mermaid может измерить текст в ноль.
   * Таймаут начинается после кадра; отменённое задание не создаёт frame поздним продолжением.
   */
  async function startNext(): Promise<void> {
    if (disposed || active || !waiting.length) {
      return;
    }

    active = waiting.shift()!;

    const job = active;

    try {
      if (!frame && options.waitForPaint) {
        await options.waitForPaint();

        if (disposed || active !== job) {
          return;
        }
      }

      job.timer = setTimeout(job.abort, timeoutMs);

      if (!frame && !createFrame()) {
        finish(null);

        return;
      }

      send();
    } catch {
      if (disposed || active !== job) {
        return;
      }

      resetFrame();
      finish(null);
    }
  }

  /**
   * Ожидающих схем не больше 32, активная занимает отдельный слот.
   * Отмена убирает ожидающее задание; активное отменяется вместе с его frame.
   */
  function render(code: string, { signal }: { signal?: AbortSignal } = {}): Promise<MermaidImage | null> {
    if (disposed || !host || !code.trim() || code.length > 50_000 ||
        signal?.aborted || waiting.length >= 32) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const job: MermaidJob = {
        code,
        requestId: `diagram-${sequence += 1}`,
        resolve,
        signal,
        abort: () => {
          if (active === job) {
            resetFrame();
            finish(null);
          } else {
            const index = waiting.indexOf(job);

            if (index >= 0) {
              waiting.splice(index, 1);
              signal?.removeEventListener('abort', job.abort);
              resolve(null);
            }
          }
        },
      };

      signal?.addEventListener('abort', job.abort, { once: true });
      waiting.push(job);
      void startNext();
    });
  }

  /**
   * Dispose запрещает новые задания и отписывает родительское окно.
   * Уже ожидающий потребитель получает null, а удалённый frame больше не принимается.
   */
  function dispose(): void {
    disposed = true;
    host?.removeEventListener('message', receive);
    resetFrame();
    finish(null);

    for (const job of waiting.splice(0)) {
      job.signal?.removeEventListener('abort', job.abort);
      job.resolve(null);
    }
  }

  host?.addEventListener('message', receive);

  return { render, dispose };
}

interface MermaidJob {
  code: string;
  requestId: string;
  resolve(result: MermaidImage | null): void;
  signal?: AbortSignal;
  abort(): void;
  timer?: ReturnType<typeof setTimeout>;
  retried?: boolean;
}

let sharedRenderer: MermaidRenderer | null = null;

/**
 * Загружает единственный статический renderer через SW родительской страницы.
 * Cookies не нужны asset-у; отказ загрузки возвращает очередь к fallback и retry.
 */
async function fetchRendererSource(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { credentials: 'omit', signal });

  if (!response.ok) {
    throw new Error(t('core.mdRendererMermaidNedostupen'));
  }

  return response.text();
}

/**
 * Один renderer обслуживает все схемы вкладки и создаёт iframe только при первом задании.
 * URL статически привязан к generated asset, чтобы Vite публиковал его с хешем.
 */
export function renderMermaid(
  code: string,
  options?: { signal?: AbortSignal },
): Promise<MermaidImage | null> {
  if (!globalThis.document?.body || !code.trim() || code.length > 50_000 || options?.signal?.aborted) {
    return Promise.resolve(null);
  }

  sharedRenderer ??= createMermaidRenderer({
    document: globalThis.document,
    rendererUrl: new URL('../../../.generated/markdown/mermaid-renderer.js', import.meta.url).href,
    waitForPaint: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  });

  return sharedRenderer.render(code, options);
}
