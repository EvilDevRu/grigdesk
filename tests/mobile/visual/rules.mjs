/**
 * Правила проверяют реальную геометрию DOM, включая inert фон открытого диалога.
 * Прокрутка кода разрешена локально, а обрезанный обычный текст остаётся нарушением.
 */
export function inspectFrame() {
  const issues = [];
  const scrolling = document.scrollingElement;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  };
  const describe = (element) => element.tagName.toLowerCase() + '.' + element.className;

  // Видимая часть контрола: колонки прокручиваются сами, и строка, уехавшая под шапку или
  // за край ленты, рендерится под ними, но обрезана своим контейнером и пальцу недоступна.
  const clip = (element) => {
    const rect = element.getBoundingClientRect();
    const box = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };

    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);

      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const outer = parent.getBoundingClientRect();

        box.left = Math.max(box.left, outer.left);
        box.top = Math.max(box.top, outer.top);
        box.right = Math.min(box.right, outer.right);
        box.bottom = Math.min(box.bottom, outer.bottom);
      }
    }

    return box;
  };

  if (scrolling.scrollWidth > width + 1) {
    issues.push({
      rule: 'h-scroll',
      w: scrolling.scrollWidth,
      width,
    });
  }

  const elements = [
    ...document.querySelectorAll(
      'button,a[href],input,textarea,select,summary,[role=button],[tabindex="0"]',
    ),
  ].filter((element) => visible(element) && !element.closest('[inert]'));
  const boxes = elements.map((element) => ({
    element,
    rect: element.getBoundingClientRect(),
    shown: clip(element),
  }));

  for (const { element, rect } of boxes) {
    if (rect.left < -1 || rect.right > width + 1) {
      issues.push({
        rule: 'off-screen',
        element: describe(element),
        left: rect.left,
        right: rect.right,
      });
    }

    const compact = document.documentElement.dataset.device === 'tablet' && width >= 760
      && element.closest('[data-touch-density="compact"]');
    const minimum = compact ? 27.9 : 43.9;

    if (rect.width < minimum || rect.height < minimum) {
      issues.push({
        rule: 'small-target',
        element: describe(element),
        w: rect.width,
        h: rect.height,
      });
    }
  }
  for (let first = 0; first < boxes.length; first += 1) {
    for (let second = first + 1; second < boxes.length; second += 1) {
      const a = boxes[first];
      const b = boxes[second];

      if (a.element.contains(b.element) || b.element.contains(a.element)) {
        continue;
      }
      if (
        Math.min(a.shown.right, b.shown.right) - Math.max(a.shown.left, b.shown.left) > 4 &&
        Math.min(a.shown.bottom, b.shown.bottom) - Math.max(a.shown.top, b.shown.top) > 4
      ) {
        issues.push({
          rule: 'overlap',
          a: describe(a.element),
          b: describe(b.element),
        });
      }
    }
  }
  for (const element of document.querySelectorAll(
    'p,h1,h2,strong,span,label,legend,pre,button,a',
  )) {
    if (
      !visible(element) ||
      element.closest('[inert]') ||
      !element.textContent.trim() ||
      element.clientWidth === 0 ||
      element.scrollWidth <= element.clientWidth + 1
    ) {
      continue;
    }

    let cursor = element;
    let allowed = false;

    while (cursor && cursor !== document.body) {
      const style = getComputedStyle(cursor);

      if (
        ['auto', 'scroll'].includes(style.overflowX) ||
        (style.textOverflow === 'ellipsis' && Boolean(cursor.getAttribute('aria-label')))
      ) {
        allowed = true;
        break;
      }

      cursor = cursor.parentElement;
    }

    if (!allowed) {
      issues.push({
        rule: 'clipped-text',
        element: describe(element),
      });
    }
  }

  const dialog = document.querySelector('[role=dialog],[role=alertdialog]');

  if (dialog) {
    const rect = dialog.getBoundingClientRect();

    if (rect.top < -1 || rect.bottom > height + 1) {
      issues.push({
        rule: 'dialog-off-screen',
        top: rect.top,
        bottom: rect.bottom,
        height,
      });
    }
  }

  for (const image of document.images) {
    if (
      visible(image) &&
      image.getBoundingClientRect().width > image.parentElement.getBoundingClientRect().width + 1
    ) {
      issues.push({ rule: 'wide-image' });
    }
  }

  if (!document.getElementById('app')?.textContent.trim() && !dialog) {
    issues.push({ rule: 'empty-frame' });
  }

  return issues;
}

/**
 * Прокручивает документ и каждую прокручиваемую колонку до конца. Лента, списки и
 * карточки прокручиваются в своих контейнерах, поэтому одного window.scrollTo мало.
 */
export function scrollToEnd() {
  window.scrollTo(0, document.scrollingElement.scrollHeight);

  for (const element of document.querySelectorAll('*')) {
    const style = getComputedStyle(element);

    if (
      ['auto', 'scroll'].includes(style.overflowY) &&
      element.scrollHeight > element.clientHeight + 1
    ) {
      element.scrollTop = element.scrollHeight;
    }
  }
}

/**
 * Нижняя панель разделов не должна закрывать ни одну видимую колонку и поле ввода.
 * Рейка планшета стоит сбоку и с содержимым по высоте не спорит.
 */
export function navCoversContent() {
  const nav = document.querySelector('.app-nav');

  if (!nav || getComputedStyle(nav).display === 'none') {
    return false;
  }

  const bar = nav.getBoundingClientRect();

  if (bar.width <= bar.height) {
    return false;
  }

  return [...document.querySelectorAll('.pane-body, .chat-composer')].some((element) => {
    const rect = element.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0 && rect.bottom > bar.top + 1;
  });
}
