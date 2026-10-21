import { parseSurfaceTarget } from '../../../shared/desktop/surfaceContract.ts';

// Межоконные сообщения desktop. Главный документ — единственный владелец постоянных потоков;
// окна карточек получают от него события, сигналы и снимки, а каналы закрывает их владелец.

// Только нужная часть BroadcastChannel: тест подставляет свой канал без живого процесса Node.
export interface RelayChannel {
  onmessage: BroadcastChannel['onmessage'];
  postMessage(value: unknown): void;
  close(): void;
}
export type RelayRole = 'source' | 'mirror';

interface ShellRelayOptions {
  role: RelayRole;
  watchRevision(callback: () => void): () => void;
  refresh(): Promise<unknown>;
  channel?: RelayChannel;
}

const SHELL_RELAY_NAME = 'grigdesk-shell-v1';

/**
 * Принимается только сообщение известной формы: лишние поля означают другую версию.
 * Возвращает тип сообщения либо null; шаг 11 использует проверку и для синхронизации задач.
 */
export function relayType(data: unknown, size: number): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  const value = data as Record<string, unknown>;

  if (Object.keys(value).length !== size || value.version !== 1 || typeof value.type !== 'string') {
    return null;
  }

  return value.type;
}

/**
 * Главный документ держит единственный long-poll оболочки и лишь сообщает о новой ревизии.
 * Окно карточки перечитывает состояние коротким запросом и своего long-poll не держит.
 */
export function startShellRelay(options: ShellRelayOptions): () => void {
  const channel = options.channel ?? new BroadcastChannel(SHELL_RELAY_NAME);
  let active = true;
  let stopWatch = () => {
  };

  if (options.role === 'source') {
    stopWatch = options.watchRevision(() => {
      if (active) {
        channel.postMessage({ version: 1, type: 'shell-changed' });
      }
    });
  }
  else {
    channel.onmessage = ({ data }) => {
      if (active && relayType(data, 2) === 'shell-changed') {
        void options.refresh().catch(() => undefined);
      }
    };
  }

  return () => {
    active = false;
    stopWatch();
    channel.onmessage = null;
    channel.close();
  };
}

interface BoardSnapshot {
  data: unknown;
  readAt: number;
}
interface BoardRelayOptions {
  role: RelayRole;
  snapshot(): BoardSnapshot | null;
  watchLoads(callback: () => void): () => void;
  apply(data: unknown, readAt: number): void;
  mirror(request: (() => void) | null): void;
  channel?: RelayChannel;
}

const BOARD_RELAY_NAME = 'grigdesk-board-v1';

/**
 * Дашборд портала опрашивает только главный документ. Документ, сам прочитавший доску
 * (опрос главного окна или действие в карточке), делится снимком; остальные его применяют.
 */
export function startBoardRelay(options: BoardRelayOptions): () => void {
  const channel = options.channel ?? new BroadcastChannel(BOARD_RELAY_NAME);
  let active = true;
  const post = (value: unknown) => {
    if (active) {
      channel.postMessage(value);
    }
  };
  const share = () => {
    const current = options.snapshot();
    const data = current?.data;

    if (current && data && typeof data === 'object' && !Array.isArray(data)) {
      post({
        version: 1,
        type: 'board-snapshot',
        data,
        readAt: current.readAt,
      });
    }
  };
  const request = () => post({ version: 1, type: 'board-request' });
  const stopLoads = options.watchLoads(share);

  channel.onmessage = ({ data }) => {
    if (!active) {
      return;
    }
    if (relayType(data, 4) === 'board-snapshot' && data.data
      && typeof data.data === 'object' && !Array.isArray(data.data) && Number.isFinite(data.readAt)) {
      options.apply(data.data, data.readAt);
    }
    else if (options.role === 'source' && relayType(data, 2) === 'board-request') {
      share();
    }
  };

  if (options.role === 'mirror') {
    options.mirror(request);
    request();
  }

  return () => {
    active = false;
    stopLoads();

    if (options.role === 'mirror') {
      options.mirror(null);
    }

    channel.onmessage = null;
    channel.close();
  };
}

interface ShelfRelayOptions {
  role: RelayRole;
  channel: RelayChannel;
  acknowledge(id: string): unknown;
}

/**
 * Отметку полки исполняет главное окно с полным наблюдением конвейера и оценки.
 * Закрытая форма сообщения исключает произвольные действия и неканонические номера.
 */
export function startShelfRelay(options: ShelfRelayOptions): () => void {
  let active = true;

  options.channel.onmessage = ({ data }) => {
    if (!active || options.role !== 'source' || relayType(data, 3) !== 'shelf-acknowledge') {
      return;
    }

    const target = parseSurfaceTarget({ kind: 'task', id: data.taskId });

    if (target) {
      void Promise.resolve().then(() => options.acknowledge(target.id)).catch(() => undefined);
    }
  };

  return () => {
    active = false;
    options.channel.onmessage = null;
    options.channel.close();
  };
}
