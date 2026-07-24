// Красивый конфирм вместо системного confirm(): тёмная модалка в палитре проекта.
// Использование: if (await confirmDialog('Удалить чат «X»?', { danger: true, okText: 'Удалить' })) …
// Esc / клик по фону / «Отмена» → false; Enter / «Ок» → true. Без Vue-обвязки —
// чистый DOM, чтобы звать из любого места одной функцией.

let cssDone = false;

function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const st = document.createElement('style');
  st.textContent = `
.cfm-overlay { position: fixed; inset: 0; z-index: 400; background: rgba(4, 6, 10, .62);
  display: grid; place-items: center; animation: cfm-in .12s ease; }
@keyframes cfm-in { from { opacity: 0; } }
.cfm { background: var(--surface); border: 1px solid var(--line-2); border-radius: 14px;
  padding: 18px 20px 16px; width: min(420px, calc(100vw - 40px));
  box-shadow: 0 18px 50px #000c; }
.cfm-t { font-size: 15px; font-weight: 650; color: var(--ink); }
.cfm-x { margin-top: 8px; font-size: 13.5px; line-height: 1.55; color: var(--ink-mid); overflow-wrap: anywhere; }
.cfm-a { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.cfm-a button { border-radius: 9px; padding: 8px 16px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); }
.cfm-a button:hover { border-color: var(--line-2); }
.cfm-ok { background: var(--accent) !important; border-color: var(--accent) !important; color: #fff !important; font-weight: 600; }
.cfm-ok.danger { background: var(--bad) !important; border-color: var(--bad) !important; }
`;
  document.head.appendChild(st);
}

/**
 * Показать подтверждение. Возвращает Promise<boolean>.
 */
export function confirmDialog(text, { title = 'Подтверди действие', okText = 'Да', cancelText = 'Отмена', danger = false } = {}) {
  injectCss();
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'cfm-overlay';
    const box = document.createElement('div');
    box.className = 'cfm';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const t = document.createElement('div'); t.className = 'cfm-t'; t.textContent = title;
    const x = document.createElement('div'); x.className = 'cfm-x'; x.textContent = text;
    const a = document.createElement('div'); a.className = 'cfm-a';
    const no = document.createElement('button'); no.textContent = cancelText;
    const ok = document.createElement('button'); ok.className = 'cfm-ok' + (danger ? ' danger' : ''); ok.textContent = okText;
    a.append(no, ok);
    box.append(t, x, a);
    wrap.append(box);

    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(true); }
    };
    document.addEventListener('keydown', onKey, true);
    ok.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });

    document.body.appendChild(wrap);
    no.focus();
  });
}
