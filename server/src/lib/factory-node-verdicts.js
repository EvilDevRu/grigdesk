// Что узел СКАЗАЛ, закрывая свой заход.
//
// Движок кладёт в провайдерскую проекцию `t<TASK>.pipeline` только однострочный дайджест
// `<КЛЮЧ>_COMMENT` (300 символов), а сам вердикт — класс владельца провала и список
// типизированных находок с якорями на файлы — остаётся в журнале попытки. Кокпит его не
// читал вовсе, поэтому модалка узла показывала одну обрезанную строку, а вопрос, ради
// которого маршрут встал на человеке, человеку не показывался нигде: он доставался
// только чтением `stage-results/` руками.
//
// Отсюда роль модуля: достать последний вердикт КАЖДОГО узла попытки и отдать его в
// `nodeMeta`. Текст в находках пишет агент, то есть это недоверенные данные: они
// ограничиваются по числу и длине здесь, а рисуются только интерполяцией.
import fs from 'node:fs/promises';
import path from 'node:path';

const EVENT_RE = /^event\.(\d{20})\.[0-9a-f]{64}\.json$/;
const NODE_RE = /^[a-z0-9][a-z0-9_]{0,40}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

// Потолки. Находок у одного узла бывает пять-шесть, двадцать — заведомо аномалия;
// длина взята с запасом к живым summary (около 300 символов) и режет, а не отбрасывает:
// обрезанное замечание всё ещё полезно, потерянное — нет.
const MAX_FINDINGS = 20;
const SUMMARY_LIMIT = 900;
const REF_LIMIT = 200;
const MAX_REVIEWED = 20;
// Защита от попытки с аномально длинным журналом: читаем только хвост. Вердикт узла,
// вытесненный из хвоста, означает заход, после которого прошло больше четырёхсот
// событий, — такой узел давно переигран.
const MAX_EVENTS = 400;

const SEVERITIES = new Set(['blocking', 'deferred']);

/**
 * Приводит недоверенную строку агента к безопасному однострочному виду.
 *
 * Управляющие символы уезжают в браузер и в подсказки, поэтому схлопываются в пробел;
 * перевод строки тоже, потому что находка — это одна формулировка, а не абзац.
 */
function text(value, limit) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Нормализует один вердикт события журнала.
 *
 * Возвращает null, когда вердикта нет вовсе либо в нём не осталось ничего показываемого:
 * пустая карточка на узле хуже её отсутствия — она обещает содержание, которого нет.
 */
function normalizeVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return null;

  const owner = text(verdict.owner, 40);
  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  const reviewed = Array.isArray(verdict.reviewed) ? verdict.reviewed : [];

  const items = [];
  for (const raw of findings.slice(0, MAX_FINDINGS)) {
    if (!raw || typeof raw !== 'object') continue;
    const summary = text(raw.summary, SUMMARY_LIMIT);
    if (!summary) continue;
    const severity = SEVERITIES.has(raw.severity) ? raw.severity : 'blocking';
    items.push({
      id: text(raw.id, REF_LIMIT),
      anchor: text(raw.anchor, REF_LIMIT),
      severity,
      summary,
    });
  }

  const files = reviewed
    .slice(0, MAX_REVIEWED)
    .map((entry) => text(entry, REF_LIMIT))
    .filter(Boolean);

  if (!owner && !items.length && !files.length) return null;
  return {
    owner,
    findings: items,
    reviewed: files,
    omitted: Math.max(0, findings.length - MAX_FINDINGS),
  };
}

/**
 * Последний вердикт каждого узла закреплённой попытки.
 *
 * События идут возрастающей последовательностью, поэтому поздний вердикт узла
 * перезаписывает ранний: показывать надо то, чем узел кончил, а не чем начинал.
 * Ошибка чтения журнала возвращает пустую карту — вердикт это дополнение к карточке
 * узла, и его отсутствие не имеет права ронять граф.
 */
export async function readNodeVerdicts({ controlDir, task, attempt }) {
  if (!controlDir || !path.isAbsolute(controlDir) || !attempt) return {};
  const dir = path.join(
    controlDir, 'protocol-v2', 'tasks', `t${String(task)}`, 'attempts', attempt, 'stage-results',
  );

  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return {};
  }

  const ordered = names
    .map((name) => [EVENT_RE.exec(name), name])
    .filter(([match]) => match)
    .sort((a, b) => Number(a[0][1]) - Number(b[0][1]))
    .slice(-MAX_EVENTS)
    .map(([, name]) => name);

  const byNode = {};
  for (const name of ordered) {
    let event;
    try {
      event = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const node = typeof event.node === 'string' && NODE_RE.test(event.node) ? event.node : null;
    if (!node) continue;
    const verdict = normalizeVerdict(event.verdict);
    if (!verdict) continue;
    byNode[node] = {
      ...verdict,
      outcome: text(event.outcome, 40),
      // Чем кончилось событие с этим вердиктом: обычный переход, возврат или остановка.
      // По нему модалка отличает «узел вернул решение человеку» от рядового замечания.
      stop: text(event.action?.stop, 40),
      rewind: text(event.action?.rewind, REF_LIMIT),
      at: text(event.at, 40),
      // Порядковый номер события. По нему потребитель находит узел, НА КОТОРОМ маршрут
      // встал: узлов с непустым `stop` в журнале может остаться несколько, если прежнюю
      // остановку сняли возвратом на соседний узел.
      sequence: Number.isInteger(event.sequence) ? event.sequence : null,
    };
  }
  return byNode;
}

/**
 * Узел и класс владельца ТЕКУЩЕЙ остановки.
 *
 * Узлов с непустым `stop` в журнале может остаться несколько: прежнюю остановку могли
 * снять возвратом на соседний узел, а её событие осталось в immutable-журнале. Побеждает
 * событие с наибольшим номером — то есть последнее по времени.
 */
export function stopVerdictOf(verdicts, stop) {
  if (!stop) return null;
  const entry = Object.entries(verdicts || {})
    .filter(([, v]) => v && v.stop === stop)
    .sort((a, b) => (b[1].sequence ?? -1) - (a[1].sequence ?? -1))[0];
  return entry ? { node: entry[0], ...entry[1] } : null;
}
