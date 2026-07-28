// Почему конвейер стоит.
//
// Движок умеет останавливаться САМ: три попытки этапа без результата, два возврата
// в сборку без толку, упавший стенд, нехватка прав на запись статуса. В каждом из
// этих случаев он ставит STALLED_HUMAN=1 и пишет причину строкой в
// logs/tNNNN.stages.log — и на этом всё. Кокпит флаг читал (`stalledHuman` в сводке
// задачи), но не показывал нигде: единственным индикатором оставалось «○ стоит» по
// живости демона, одинаковое и для доделанной задачи, и для той, что ждёт человека.
//
// 27.07.2026 #7800 простоял так час: REPRO трижды не смог воспроизвести баг (в третий
// заход — из-за неподнявшегося playwright MCP), движок корректно встал и позвал
// человека, а человек об этом не узнал. Этот модуль достаёт причину из журнала и
// формулирует её так, чтобы по ней было понятно, что делать.
import { parseStagesLog } from './stages-parse.js';

// Формулировки движка (lib/core.sh) → человеческая причина и что с ней делать.
// Порядок не важен: ищем с конца журнала, берём первое совпадение.
const HALT_RULES = [
  {
    re: /^([A-Z_]+): (\d+) возврата не помогли/,
    build: (m) => ({
      stage: m[1],
      title: `${m[1]}: ${m[2]} возврата не помогли`,
      hint: 'этап падает раз за разом — посмотри его отчёт: чинить, менять план или вести руками',
    }),
  },
  {
    re: /^([A-Z_]+): 3 попытки без результата/,
    build: (m) => ({
      stage: m[1],
      title: `${m[1]}: агент трижды не отчитался о результате`,
      hint: 'этап не выставил статус — обычно упирается в бюджет времени, права или недоступный инструмент',
    }),
  },
  {
    re: /^([A-Z_]+): агенту не дали записать результат/,
    build: (m) => ({
      stage: m[1],
      title: `${m[1]}: агенту не хватило прав записать статус`,
      hint: 'повтор бесполезен — нужны права на запись в реестр (песочница/settings этапа)',
    }),
  },
  {
    re: /^sandbox_up упал/,
    build: () => ({
      stage: 'SANDBOX',
      title: 'стенд не поднялся',
      hint: 'смотри хвост logs/tNNNN.orch.log — чаще всего занятый порт или недоснесённая песочница',
    }),
  },
  {
    re: /^([A-Z_]+): агент убит по таймауту/,
    build: (m) => ({
      stage: m[1],
      title: `${m[1]}: агент убит по таймауту`,
      hint: 'работа этапа потеряна целиком — поднимай лимит времени этапа, а не правь промпт',
    }),
  },
];

/**
 * Классифицирует остановку конвейера.
 *
 * @param {{registry: object, timeline?: Array<{ts,event}>, logText?: string, daemonAlive: boolean}} o
 * @returns {null | {kind:'human'|'crashed', stage:string|null, title:string, detail:string|null,
 *                   since:string|null, hint:string, fails:number|null, comment:string|null}}
 *          null — конвейер не стоит (идёт, доделан или ждёт на воротах).
 */
export function detectStall({ registry = {}, timeline, logText, daemonAlive }) {
  const events = timeline || (logText ? parseStagesLog(logText) : []);
  const stalled = registry.STALLED_HUMAN === '1';

  // Демон жив — конвейер работает или стоит на воротах (у ворот своя кнопка, это не затык).
  if (daemonAlive && !stalled) return null;

  let found = null;
  for (let i = events.length - 1; i >= 0 && !found; i -= 1) {
    for (const rule of HALT_RULES) {
      const m = rule.re.exec(events[i].event);
      if (!m) continue;
      found = { ...rule.build(m), detail: events[i].event, since: events[i].ts };
      break;
    }
  }

  if (stalled) {
    const base = found || {
      stage: null,
      title: 'конвейер остановлен и ждёт человека',
      hint: 'причина не нашлась в журнале — смотри logs/tNNNN.stages.log',
      detail: null,
      since: events.length ? events[events.length - 1].ts : null,
    };
    const fails = base.stage && registry[`${base.stage}_FAILS`] ? Number(registry[`${base.stage}_FAILS`]) : null;
    const comment = base.stage ? (registry[`${base.stage}_COMMENT`] || null) : null;
    return { kind: 'human', fails, comment, ...base };
  }

  // Флага нет, а демона тоже нет: конвейер оборвался молча — упал, был убит или
  // зачищен вместе с cgroup. Отличаем от нормального финала по последней строке.
  const last = events.length ? events[events.length - 1] : null;
  if (!last || /конвейер завершён/.test(last.event)) return null;
  return {
    kind: 'crashed',
    stage: found?.stage || null,
    title: found?.title || 'конвейер оборвался, не дойдя до конца',
    detail: found?.detail || last.event,
    since: found?.since || last.ts,
    hint: 'демона нет, а конвейер не закрыт — запусти заново (resume продолжит с этого места)',
    fails: null,
    comment: null,
  };
}
