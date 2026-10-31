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
  sourceKey: string;
}
interface BoardRelayOptions {
  role: RelayRole;
  snapshot(): BoardSnapshot | null;
  sourceState(): { key: string; suspended: boolean };
  watchLoads(callback: () => void): () => void;
  watchInvalidation(callback: () => void): () => void;
  apply(data: unknown, readAt: number, sourceKey: string): void;
  invalidate(suspended: boolean): void;
  recheck(): Promise<unknown>;
  mirror(request: (() => void) | null): void;
  channel?: RelayChannel;
}

const BOARD_RELAY_NAME = 'grigdesk-board-v1';

/**
 * Снимок принимается только после локальной проверки его владельца, ключ из канала не доверенный.
 * Отдельная инвалидизация существует и без данных; пауза записи credentials охватывает зеркала.
 */
export function startBoardRelay(options: BoardRelayOptions): () => void {
  const channel = options.channel ?? new BroadcastChannel(BOARD_RELAY_NAME);
  let active = true;
  let receivingInvalidation = false;
  const post = (value: unknown) => {
    if (active) {
      channel.postMessage(value);
    }
  };
  const recheck = () => {
    if (!options.sourceState().suspended) {
      void options.recheck().catch(() => undefined);
    }
  };
  const share = () => {
    const current = options.snapshot();
    const data = current?.data;

    if (current && data && typeof data === 'object' && !Array.isArray(data)
      && !options.sourceState().suspended && current.sourceKey.length > 0) {
      post({
        version: 1,
        type: 'board-snapshot',
        data,
        readAt: current.readAt,
        sourceKey: current.sourceKey,
      });
    }
  };
  const request = () => post({ version: 1, type: 'board-request' });
  const stopLoads = options.watchLoads(share);
  const stopInvalidation = options.watchInvalidation(() => {
    if (receivingInvalidation || options.role !== 'source') {
      return;
    }

    post({
      version: 1,
      type: 'board-source-invalidated',
      suspended: options.sourceState().suspended,
    });
  });

  channel.onmessage = ({ data }) => {
    if (!active) {
      return;
    }
    if (relayType(data, 3) === 'board-source-invalidated' && typeof data.suspended === 'boolean') {
      receivingInvalidation = true;

      try {
        options.invalidate(data.suspended);
      } finally {
        receivingInvalidation = false;
      }

      recheck();

      return;
    }
    if (relayType(data, 5) === 'board-snapshot' && data.data
      && typeof data.data === 'object' && !Array.isArray(data.data) && Number.isFinite(data.readAt)
      && typeof data.sourceKey === 'string' && data.sourceKey.length > 0) {
      const state = options.sourceState();

      if (state.suspended) {
        return;
      }
      if (data.sourceKey !== state.key) {
        recheck();

        return;
      }

      options.apply(data.data, data.readAt, data.sourceKey);
    } else if (options.role === 'source' && relayType(data, 2) === 'board-request') {
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
    stopInvalidation();

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
