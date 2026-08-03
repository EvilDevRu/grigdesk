/**
 * Дашборд обновляется каждые 5 с. Обновление ОБЯЗАНО быть точечным: пересборка всего блока
 * заставляла браузер заново строить карточки и SVG-графы — страница дёргалась, а карточки
 * с тикающим таймером перерисовывали граф каждые 5 с.
 *
 * Тест берёт функцию patch прямо со страницы живого дашборда.
 * Запуск: node tests/engine/dom-patch.mjs   (нужен jsdom; без него — пропуск)
 */
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('— jsdom не установлен, тест пропущен (npm i jsdom)');
  process.exit(0);
}

const URL_ = process.env.FACTORY_URL || 'http://localhost:8070';
let page;
try {
  page = await (await fetch(URL_)).text();
} catch {
  console.log(`— дашборд ${URL_} не отвечает, тест пропущен`);
  process.exit(0);
}

const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const js = scripts.sort((a, b) => b.length - a.length)[0]
  .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"');
const src = js.slice(js.indexOf('function patch('), js.indexOf('setInterval(poll,5000)'));

const dom = new JSDOM('<div id="app"></div>', { runScripts: 'outside-only' });
const { window } = dom;
global.document = window.document;
window.eval(src);
const patch = window.eval('patch');
const mk = (h) => { const d = window.document.createElement('div'); d.innerHTML = h; return d; };
const app = window.document.getElementById('app');

let ok = true;
const check = (name, cond) => { console.log((cond ? '✓ ' : '✗ ') + name); if (!cond) ok = false; };

const card = (t, timer, stage) => `<div class="card" data-key="task-${t}">
  <div class="hdr" data-key="hdr">Задача #${t} <span class="tmr">${timer}</span></div>
  <div data-key="graph"><svg><g class="ns-${stage}"></g></svg></div>
  <div class="strip" data-key="strip">стенд</div></div>`;

app.innerHTML = '<div data-key="top">шапка</div>' + card(101, '00:01', 'run') + card(7900, '10:00', 'run');
const before = [...app.children];
patch(app, mk('<div data-key="top">шапка</div>' + card(101, '00:01', 'run') + card(7900, '10:00', 'run')));
check('данные не изменились — ни один узел не пересоздан', app.children.length === before.length
      && [...app.children].every((c, i) => c === before[i]));

const svg = app.querySelector('svg');
patch(app, mk('<div data-key="top">шапка</div>' + card(101, '00:06', 'run') + card(7900, '10:00', 'run')));
check('тикнул таймер — граф не перерисован', app.querySelector('svg') === svg);
check('тикнул таймер — шапка карточки обновилась', app.querySelector('.hdr').textContent.includes('00:06'));

patch(app, mk('<div data-key="top">шапка</div>' + card(101, '00:11', 'done') + card(7900, '10:00', 'run')));
check('сменился этап — граф перерисован', app.querySelector('svg') !== svg
      && app.querySelector('g').getAttribute('class') === 'ns-done');

patch(app, mk('<div data-key="top">шапка</div>' + card(101, '00:11', 'done')));
check('задача исчезла — карточка удалена, порядок цел',
      [...app.children].map((c) => c.dataset.key).join(',') === 'top,task-101');

app.innerHTML = '<h2>ЗАДАЧИ (2)</h2>' + card(1, '0', 'run');
patch(app, mk('<h2>ЗАДАЧИ (3)</h2>' + card(1, '0', 'run')));
check('блок без data-key обновляется по позиции', app.children[0].textContent === 'ЗАДАЧИ (3)');

console.log(ok ? '\nИТОГ: ЗЕЛЁНО' : '\nИТОГ: ЕСТЬ ПРОБЛЕМЫ');
process.exit(ok ? 0 : 1);
