// Наблюдения браузера принадлежат серверу. Модель получает только выданные им
// идентификаторы и видимый текст; селекторы и сетевые права в ответе запрещены.
import { createHash } from 'node:crypto';

import type { Locator, Page } from 'playwright-core';
import type { ScreenMap } from '../render/recorder.ts';
import { ShowcaseError } from '../errors.ts';

export interface ObservedIdentity {
  tag: string;
  role: string;
  text: string;
}

export interface ObservedElement {
  id: string;
  selector: string;
  // Подпись из карты может быть null: контракт профиля допускает элемент без неё.
  title?: string | null;
  observed?: ObservedIdentity;
}

export interface ScreenObservation {
  screenId: string;
  sceneIndex: number;
  actionIndex: number;
  // Адрес страницы в момент наблюдения: по одному тексту экрана модель не видит,
  // что клик сменил маршрут. Прежние отчёты этого поля не имеют.
  path?: string;
  text: string;
  surfaces: string[];
  elements: { id: string; text: string; visible: boolean; state?: string }[];
  error?: string;
}

// Идентификатор найденного экрана несёт его адрес: он читается в списке сцен и в
// промпте без карты, а хеш нужен только адресам длиннее строки.
const PAGE_ID_PREFIX = 'page:';
const PAGE_ID_PATH_MAX = 120;

/**
 * Адрес страницы в форме пути экрана карты: путь и hash-маршрут SPA. Запрос не
 * входит: страница, дописавшая себе `?period=…`, остаётся тем же экраном карты,
 * а состояние по параметрам воспроизводят действия сцены.
 */
export function pagePathOf(url: string): string {
  const parsed = new URL(url);
  const route = parsed.hash.startsWith('#/') ? parsed.hash.split('?')[0] : '';

  return `${parsed.pathname}${route}`;
}

export function pageScreenId(path: string): string {
  if (path.length <= PAGE_ID_PATH_MAX) {
    return `${PAGE_ID_PREFIX}${path}`;
  }

  const hash = createHash('sha256').update(path).digest('hex').slice(0, 8);

  return `${PAGE_ID_PREFIX}${path.slice(0, PAGE_ID_PATH_MAX)}…${hash}`;
}

/**
 * Найденный экран по одному идентификатору: он несёт адрес, поэтому сцена о нём
 * переживает потерю прежнего отчёта (новый стенд, новая ревизия данных). Условие
 * готовности здесь только body — каркас страницы; данные ждёт затишье сети, а
 * элементы наблюдатель находит заново под теми же идентификаторами.
 */
export function screenFromPageId<Screen extends ScreenMap & { title: string }>(id: string): Screen | null {
  if (!id.startsWith(PAGE_ID_PREFIX) || id.includes('…')) {
    return null;
  }

  const path = id.slice(PAGE_ID_PREFIX.length);

  return {
    id,
    title: `Страница ${path}`,
    path,
    readySelector: 'body',
    elements: [],
  } as unknown as Screen;
}

/**
 * Экран, на котором браузер оказался на самом деле. Карта объявляет экраны заранее,
 * а клик может увести на страницу, которой в ней нет. Тогда страница становится
 * найденным экраном с адресом из самого браузера: модель получает его идентификатор
 * наравне с объявленными и может назвать своим — и продолжению, и голове сцены,
 * которую запись откроет по этому адресу сама. Условие готовности — каркас
 * (видимый заголовок, иначе main или body); данные второй волны ждёт затишье сети,
 * как у объявленных экранов. Прав найденный экран не добавляет: его элементы находит
 * тот же наблюдатель, и они остаются read-only. Уход на чужой origin экраном не
 * становится: адрес из карты подставляется только к origin цели.
 */
export async function currentScreen<Screen extends ScreenMap & { title: string }>(
  page: Page,
  screens: Screen[],
  baseUrl: string,
  declared: Screen,
  // Адреса, за которыми объявленный экран уже признан: страница, открытая по адресу
  // из карты, может переписать его сама (редирект, локаль, слэш) и остаётся собой.
  aliases: ReadonlyMap<string, string> = new Map(),
): Promise<Screen> {
  const url = new URL(page.url());

  if (url.origin !== new URL(baseUrl).origin) {
    return declared;
  }

  const path = pagePathOf(url.toString());
  const samePath = (screen: ScreenMap) => pagePathOf(new URL(screen.path, baseUrl).toString()) === path
    || aliases.get(path) === screen.id;

  if (samePath(declared)) {
    return declared;
  }

  const known = screens.find(samePath);

  if (known) {
    return known;
  }

  const landmark = await page.evaluate(() => {
    const visible = (node: Element) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);

      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && style.opacity !== '0';
    };
    const heading = [...document.querySelectorAll('h1, h2, h3, [role=heading]')].find((node) => (
      visible(node) && (node as HTMLElement).innerText.trim().length > 0
    ));
    // Кавычки в тексте заголовка сломали бы :has-text(); подстроки без них достаточно.
    const text = heading
      ? (heading as HTMLElement).innerText.replace(/\s+/gu, ' ').replace(/["'\\]/gu, '').trim().slice(0, 60)
      : '';
    const tag = heading?.getAttribute('role') === 'heading'
      ? '[role=heading]'
      : heading?.tagName.toLowerCase();
    const main = document.querySelector('main, [role=main]');
    const readySelector = heading && text
      ? `${tag}:has-text("${text}")`
      : main && visible(main) ? 'main, [role=main]' : 'body';

    return {
      readySelector,
      title: text || document.title.replace(/\s+/gu, ' ').trim().slice(0, 80),
    };
  });
  const screen = {
    id: pageScreenId(path),
    title: landmark.title || `Страница ${path}`,
    path,
    readySelector: landmark.readySelector,
    elements: [],
  } as unknown as Screen;

  screens.push(screen);

  return screen;
}

/**
 * Элементы, которые сцена вправе назвать: свои по карте и найденные браузером на
 * любом экране. У найденного элемента есть личность и проверка видимости при
 * действии, поэтому привязка к экрану ему не нужна — а клик, уводящий на другую
 * страницу, и ожидание элемента уже на ней естественно живут в одной сцене.
 * Результат — только для разрешения целей: в промпт он не попадает.
 */
export function resolvableElements<Element extends { id: string; observed?: unknown }>(
  screens: readonly { elements: Element[] }[],
  screen: { elements: Element[] },
): Element[] {
  const own = new Set(screen.elements.map((element) => element.id));
  const foreign = screens
    .filter((item) => item !== screen)
    .flatMap((item) => item.elements.filter((element) => element.observed && !own.has(element.id)));

  return [...screen.elements, ...foreign];
}

/**
 * У наблюдённой цели проверяется личность, а неоднозначный селектор не получает
 * молчаливый first(): иначе запись может успешно открыть совершенно другой диалог.
 */
export async function actionTarget(page: Page, element: ObservedElement): Promise<Locator> {
  const target = page.locator(element.selector);

  if (element.observed) {
    await target.waitFor({ state: 'attached', timeout: 6000 });
  }
  const count = await target.count();

  if (count > 1) {
    throw new ShowcaseError('target_ambiguous', `Элемент «${element.id}» найден ${count} раз.`, 409);
  }

  if (element.observed && count === 1) {
    const identity = await target.evaluate((node) => {
      const icon = node.tagName.toLowerCase() === 'svg'
        ? `значок ${[...node.classList].filter((name) => /icon|lucide/iu.test(name)).join(' ')} `
          + ((node.closest('button,[role=button],[role=menuitem]') as HTMLElement | null)?.innerText ?? '')
        : '';

      return {
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role') ?? '',
        text: (node.getAttribute('aria-label') || node.getAttribute('title')
          || (node as HTMLElement).innerText || icon).replace(/\s+/gu, ' ').trim().slice(0, 180),
      };
    });

    if (JSON.stringify(identity) !== JSON.stringify(element.observed)) {
      throw new ShowcaseError('target_changed', `Элемент «${element.id}» изменился после проверки.`, 409);
    }
  }

  return target;
}

/**
 * Дополняет карту только реально видимыми узлами объявленного экрана. Селектор
 * строит код браузера, а не модель. Пароли, значения полей и HTML не извлекаются.
 */
export async function observeScreen(
  page: Page,
  screen: ScreenMap,
  sceneIndex: number,
  actionIndex: number,
): Promise<ScreenObservation> {
  const found = await page.evaluate(() => {
    const visible = (node: Element) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);

      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && style.opacity !== '0';
    };
    const label = (node: Element) => {
      const icon = node.tagName.toLowerCase() === 'svg'
        ? `значок ${[...node.classList].filter((name) => /icon|lucide/iu.test(name)).join(' ')} `
          + ((node.closest('button,[role=button],[role=menuitem]') as HTMLElement | null)?.innerText ?? '')
        : '';

      return (node.getAttribute('aria-label') || node.getAttribute('title')
        || (node as HTMLElement).innerText || icon).replace(/\s+/gu, ' ').trim().slice(0, 180);
    };
    const selectorOf = (node: Element) => {
      for (const attribute of ['data-testid', 'id']) {
        const value = node.getAttribute(attribute);

        if (value && (attribute !== 'id' || (/^[a-z][\w-]*$/iu.test(value)
          && !/^(?:radix|reka|headlessui|v)-/iu.test(value)))) {
          const selector = `[${attribute}=${CSS.escape(value)}]`;

          if (document.querySelectorAll(selector).length === 1) {
            return selector;
          }
        }
      }

      const parts: string[] = [];
      let current: Element | null = node;

      while (current && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        const siblings: Element[] = parent
          ? [...parent.children].filter((child) => child.tagName === current?.tagName)
          : [];

        parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = parent;
      }

      return `html > ${parts.join(' > ')}`;
    };
    const stateOf = (node: Element) => {
      const attributes = ['aria-checked', 'aria-selected', 'aria-expanded', 'data-state', 'disabled']
        .filter((attribute) => node.hasAttribute(attribute))
        .map((attribute) => `${attribute}=${node.getAttribute(attribute)}`);

      if (node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)) {
        attributes.push(`checked=${node.checked}`);
      }

      return attributes.join(', ');
    };
    const selectors = [
      'button', '[role=button]', 'a[href]', '[role=link]',
      '[role=combobox]', '[role=option]', '[role=menuitem]',
      '[role=tab]', '[role=dialog]', '[role=tooltip]', '[data-testid]',
      'input[type=checkbox]', 'input[type=radio]', 'h1', 'h2', 'h3',
      'button svg', '[role=button] svg', '[role=menuitem] svg',
      'td', '[role=gridcell]', '[role=columnheader]',
    ].join(',');
    const cellKinds = new Set<string>();
    const nodes = [...document.querySelectorAll(selectors)]
      .filter((node) => visible(node) && !node.closest('[data-showcase-overlay]'))
      .filter((node) => {
        if (!node.matches('td,[role=gridcell]')) {
          return true;
        }

        const column = node.getAttribute('col-id') || node.getAttribute('aria-colindex')
          || String((node as HTMLTableCellElement).cellIndex);
        const kind = /^(?:[-—–]+)?$/u.test(label(node)) ? 'empty' : 'value';
        const key = `${column}:${kind}`;

        if (cellKinds.has(key)) {
          return false;
        }

        cellKinds.add(key);

        return true;
      })
      .sort((left, right) => Number(Boolean(right.closest('[role=dialog],[role=menu],[role=listbox]')))
        - Number(Boolean(left.closest('[role=dialog],[role=menu],[role=listbox]'))))
      .slice(0, 400);
    const surfaces = [...document.querySelectorAll('[role=dialog], [role=tooltip]')]
      .filter(visible)
      .map((node) => {
        const heading = node.querySelector('h1,h2,h3,h4,[role=heading]');

        return `${node.getAttribute('role')}: ${label(heading ?? node)}`;
      });

    return {
      text: document.body.innerText.slice(0, 12000),
      surfaces,
      nodes: nodes.map((node) => ({
        selector: selectorOf(node),
        identity: {
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute('role') ?? '',
          text: label(node),
        },
        text: ((node as HTMLElement).innerText || label(node)).slice(0, 400),
        state: stateOf(node),
        context: node.matches('td,[role=gridcell]') ? (() => {
          const column = node.getAttribute('aria-colindex');
          const header = column ? node.closest('[role=grid],table')
            ?.querySelector(`[role=columnheader][aria-colindex=${CSS.escape(column)}]`) : null;

          return `ячейка колонки ${header ? label(header) : node.getAttribute('col-id') || column || ''}`;
        })() : '',
      })),
    };
  });

  for (const node of found.nodes) {
    const id = `observed-${createHash('sha256').update(node.selector
      + JSON.stringify(node.identity)).digest('hex').slice(0, 16)}`;

    const existing = screen.elements.find((element) => element.id === id);
    const title = `${node.identity.tag} ${node.identity.role}: ${node.identity.text} `
      + `${node.state} ${node.context}`;

    if (existing) {
      existing.title = title;
    } else if (screen.elements.length < 1200) {
      screen.elements.push({
        id,
        selector: node.selector,
        title,
        observed: node.identity,
      });
    }
  }

  const elements: ScreenObservation['elements'] = [];
  const observedNodes = new Map(found.nodes.map((node) => [node.selector, node]));

  for (const element of screen.elements) {
    if (element.observed) {
      // Один узел может менять содержимое после выбора типа. Старый ID описывает
      // прежнее состояние: нельзя объявлять его видимым с текстом уже нового ID.
      const node = observedNodes.get(element.selector);
      const current = node && JSON.stringify(node.identity) === JSON.stringify(element.observed);

      elements.push({
        id: element.id,
        visible: Boolean(current),
        text: current ? node.text : node ? 'элемент изменился: нужен ID текущего состояния' : 'не виден',
        state: current ? node.state : '',
      });

      continue;
    }

    const target = page.locator(element.selector);
    const count = await target.count();
    const visible = count === 1 && await target.isVisible();
    const text = visible
      ? await target.innerText({ timeout: 1000 }).catch(() => '')
      : count > 1 ? `неоднозначно: ${count} элементов` : 'не виден';

    const state = visible ? await target.evaluate((node) => {
      const attributes = ['aria-checked', 'aria-selected', 'aria-expanded', 'data-state', 'disabled']
        .filter((attribute) => node.hasAttribute(attribute))
        .map((attribute) => `${attribute}=${node.getAttribute(attribute)}`);

      if (node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)) {
        attributes.push(`checked=${node.checked}`);
      }

      return attributes.join(', ');
    }) : '';

    elements.push({ id: element.id, text: text.slice(0, 400), visible, state });
  }

  return {
    screenId: screen.id,
    sceneIndex,
    actionIndex,
    path: pagePathOf(page.url()),
    text: found.text,
    surfaces: found.surfaces,
    elements,
  };
}

/** Проверка поверхностей повторяется при настоящей записи, до публикации клипа. */
export async function assertObservedSurfaces(page: Page, expected: string[]): Promise<void> {
  // На записи не строим карту заново: сотни запросов к элементам добавили бы
  // паузы в кадр. Здесь нужен только результат появления окна или подсказки.
  const actual = await page.locator('[role=dialog], [role=tooltip]').evaluateAll((nodes) => (
    nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);

      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && style.opacity !== '0';
    }).map((node) => {
      const heading = node.querySelector('h1,h2,h3,h4,[role=heading]') ?? node;
      const label = (heading.getAttribute('aria-label') || heading.getAttribute('title')
        || (heading as HTMLElement).innerText || '').replace(/\s+/gu, ' ').trim().slice(0, 180);

      return `${node.getAttribute('role')}: ${label}`;
    })
  ));

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ShowcaseError(
      'screen_result_changed',
      `Результат действия изменился: ожидалось «${expected.join('; ') || 'без диалога'}», `
        + `видно «${actual.join('; ') || 'без диалога'}».`,
      409,
    );
  }
}
