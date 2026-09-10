/**
 * Состояние сервиса вендора — его же словами, а не нашей догадкой.
 *
 * «Не удалось получить лимиты» отвечало только на «что-то сломалось», а на главный вопрос
 * человека — «это у меня или у них?» — не отвечало вовсе: ссылку на страницу состояния он
 * открывал руками и читал сам. Кокпит читает её за него и приносит в ту же строку ответ:
 * вендор о сбое молчит (значит, искать у себя — сеть, VPN, туннель) или сбой признан и
 * назван (значит, ждать и не чинить целое).
 *
 * Разбирается формат Atlassian Statuspage (`/api/v2/summary.json`) — на нём живут страницы
 * всех трёх вендоров. Знание это не вендорское, а форматное: адрес по-прежнему объявляет
 * адаптер (`statusPage`), домена вендора здесь нет ни одного. Чужой движок ничего не ломает:
 * незнакомая форма даёт `unknown`, и всплывашка показывает то же, что показывала раньше, —
 * одну ссылку.
 *
 * Тексты приходят из внешнего сервиса и попадают человеку на экран, поэтому обрезаются по
 * длине и лишаются переводов строк: страница состояния — источник данных, а не разметки.
 */
import { safeHttpsUrl } from './providerUsage.ts';
import { withRetry } from './retry.ts';

/**
 * Состояния лимитов, при которых вопрос «это у них?» вообще имеет смысл. Локальные беды
 * сюда не входят: при `auth_required` надо логиниться, при `unsupported` — обновлять CLI,
 * и страница состояния вендора там только уводит в сторону.
 */
export const VENDOR_FAULT_USAGE_STATES = new Set(['unavailable', 'blocked', 'rate_limited']);

// Разобранная сводка страницы состояния вендора.
export interface VendorStatus {
  state: string;
  indicator?: string;
  summary: string;
  components: string[];
  incident: string;
  url?: string;
  checkedAt?: number;
}

const INDICATOR_STATES = {
  none: 'ok',
  minor: 'degraded',
  major: 'down',
  critical: 'down',
  maintenance: 'degraded',
};

const MAX_SUMMARY = 120;
const MAX_NAME = 60;
const MAX_INCIDENT = 120;
const MAX_COMPONENTS = 3;

/**
 * Статусы, которыми страница закрывает инцидент. Сводка Statuspage кладёт в `incidents`
 * только неразрешённые, но совместимые движки отдают в том же массиве и уже закрытые:
 * закрытый инцидент — история, а не факт о текущем состоянии сервиса.
 */
const CLOSED_INCIDENT_STATUSES = new Set(['resolved', 'postmortem', 'completed']);

function clean(value: unknown, limit = MAX_SUMMARY): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

/**
 * Обрезка заголовка инцидента. Он один отвечает словами вендора на «что именно у них
 * сломалось», и разрез посреди слова («…в ChatGPT, Wo») превращает ответ в обрывок.
 * Поэтому режем по границе слова и ставим многоточие, а не по счётчику символов.
 * Границу берём только во второй половине строки: у длинного слова в начале отступать
 * некуда, и там честнее жёсткий срез, чем два слова вместо заголовка.
 */
function clip(value: unknown, limit: number): string {
  const text = clean(value, limit + 1);

  if (text.length <= limit) {
    return text;
  }

  const cut = text.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(' ');

  return `${(boundary > limit / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * Разбор сводки Statuspage. `null` означает «форму не узнали» — это честнее пустого
 * «всё хорошо»: молчание незнакомого движка не факт о сервисе.
 */
export function parseStatuspageSummary(value: unknown): VendorStatus | null {
  const data = value as {
    status?: { indicator?: unknown; description?: unknown };
    components?: unknown;
    incidents?: unknown;
  } | null;
  const indicator = clean(data?.status?.indicator, 32).toLowerCase();
  const state = (INDICATOR_STATES as Record<string, string | undefined>)[indicator];

  if (!state) {
    return null;
  }

  // Контейнер группы (`group: true`) собственного состояния не имеет — его "деградация"
  // это состояние вложенных компонентов, и в списке она была бы вторым именем той же беды.
  const components = (Array.isArray(data?.components) ? data.components : [])
    .map((item) => item as { group?: unknown; status?: unknown; name?: unknown } | null)
    .filter((item) => item && item.group !== true && item.status && item.status !== 'operational')
    .map((item) => clean(item?.name, MAX_NAME))
    .filter(Boolean)
    .slice(0, MAX_COMPONENTS);

  const incidents = (Array.isArray(data?.incidents) ? data.incidents : [])
    .map((item) => item as { name?: unknown; status?: unknown } | null)
    .filter((item) => item?.name
      && !CLOSED_INCIDENT_STATUSES.has(clean(item.status, 32).toLowerCase()));

  // Сводный индикатор — величина производная, и он отстаёт от собственных данных страницы:
  // баннер открытого инцидента поднимается раньше, чем `none` сменится на `minor`. Пока
  // страница называет хотя бы один открытый инцидент или неисправный компонент, «вендор о
  // сбое не сообщает» — уверенная ложь, поэтому свидетельство страницы о себе самой весит
  // больше её же рол-апа.
  const disputed = state === 'ok' && Boolean(incidents.length || components.length);

  return {
    state: disputed ? 'degraded' : state,
    indicator,
    // При расхождении сводная строка молчит: «All Systems Operational» рядом с «сообщает о
    // сбое» читалось бы как отрицание соседнего же предложения.
    summary: disputed ? '' : clean(data?.status?.description),
    components,
    incident: clip(incidents[0]?.name, MAX_INCIDENT),
  };
}

/**
 * Чтение страницы состояния с кэшем по адресу. Ходим только когда лимиты уже не пришли,
 * поэтому запрос короткий и с одним повтором: диагностика не имеет права задерживать сам
 * ответ о лимитах дольше, чем он того стоит.
 */
export function createProviderStatusProbe({
  // Ленивый доступ к fetch, а не снимок при создании: пробу создаёт модуль на подъёме
  // сервера, а подменяют её в тестах уже после — снимок бы такую подмену не увидел.
  fetchImpl = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  timeoutMs = 5_000,
  maxAgeMs = 60_000,
  now = Date.now,
  sleep,
}: {
  fetchImpl?: (...args: Parameters<typeof fetch>) => Promise<Response>;
  timeoutMs?: number;
  maxAgeMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const cache = new Map<string, { at: number; value: VendorStatus }>();

  async function readSummary(page: string): Promise<VendorStatus | null> {
    const response = await withRetry(() => fetchImpl(`${page.replace(/\/+$/u, '')}/api/v2/summary.json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    }), {
      attempts: 2,
      retryWhen: (r: Response) => !r?.ok && (r?.status ?? 500) >= 500,
      ...(sleep ? { sleep } : {}),
    });

    return response?.ok ? parseStatuspageSummary(await response.json()) : null;
  }

  return {
    async read(url: unknown): Promise<VendorStatus | null> {
      const page = safeHttpsUrl(url);

      if (!page) {
        return null;
      }

      const hit = cache.get(page);

      if (hit && now() - hit.at < maxAgeMs) {
        return hit.value;
      }

      let parsed: VendorStatus | null = null;

      try {
        parsed = await readSummary(page);
      } catch {
        parsed = null;
      }

      const value: VendorStatus = {
        state: 'unknown',
        summary: '',
        components: [],
        incident: '',
        ...(parsed || {}),
        url: page,
        checkedAt: now(),
      };

      cache.set(page, { at: now(), value });

      return value;
    },
  };
}
