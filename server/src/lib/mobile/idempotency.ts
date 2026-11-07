import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { MobileInputError } from './errors.ts';
import { privateRead, privateWrite, serialized } from './files.ts';

export type OperationResult = {
  status: number;
  body: unknown;
};
export type OperationProof = {
  kind: 'chat';
  chatId: string;
  clientId: string;
  turnId: string;
  contentHash: string;
};
export type OperationInput = {
  method: string;
  path: string;
  body: unknown;
  createdAt: number;
  proof?: OperationProof;
};
type Record = {
  version: 1;
  fingerprint: string;
  boot: string;
  createdAt: number;
  reservedAt: number;
  finishedAt?: number;
  state: 'pending' | 'done' | 'unknown';
  result: OperationResult | null;
  proof?: OperationProof;
};

const MAX_RECORD_BYTES = 264192;

/**
 * Канонизирует JSON независимо от порядка полей объекта.
 * Ограничение глубины не позволяет внешнему телу переполнить стек перед резервированием.
 */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 40) {
    throw new MobileInputError('bad_request', 'Слишком сложная структура запроса.');
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonical(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item, depth + 1)]),
    );
  }

  return value;
}

/**
 * Связывает ключ с методом, нормализованным путём, телом и исходным временем.
 * Перестановка query/JSON-полей не меняет fingerprint одного и того же запроса.
 */
function fingerprint(input: OperationInput): string {
  const url = new URL(input.path, 'https://mobile.invalid');

  url.searchParams.sort();

  return createHash('sha256')
    .update(
      JSON.stringify([
        input.method.toUpperCase(),
        url.pathname + url.search,
        canonical(input.body),
        input.createdAt,
      ]),
    )
    .digest('hex');
}

export class OperationJournal {
  private directory: string;
  private now: () => number;
  private maxRecords: number;
  private maxBytes: number;
  private boot = randomBytes(16).toString('hex');
  private recover?: (device: string, proof: OperationProof) => Promise<OperationResult | null>;

  constructor(
    directory: string,
    options: {
      now?: () => number;
      maxRecords?: number;
      maxBytes?: number;
      recover?: (device: string, proof: OperationProof) => Promise<OperationResult | null>;
    } = {},
  ) {
    this.directory = path.join(directory, 'operations');
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? 10000;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.recover = options.recover;
  }

  /**
   * Проверяет обе части файлового ключа до обращения к диску.
   * Имена из внешнего запроса не могут выйти за каталог своего устройства.
   */
  private file(device: string, key: string): string {
    if (!/^d[a-f0-9]{8,32}$/.test(device) || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
      throw new MobileInputError('bad_operation', 'Неверный ключ операции.');
    }

    return path.join(this.directory, device, `${key}.json`);
  }

  /**
   * Проверяет запись перед выдачей сохранённого ответа.
   * Повреждённый intent не допускает повторного вызова эффекта.
   */
  private async read(file: string): Promise<Record | null> {
    const value = (await privateRead(file)) as Record | null;

    if (value === null) {
      return null;
    }

    if (
      value.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      !['pending', 'done', 'unknown'].includes(value.state) ||
      typeof value.boot !== 'string' ||
      !Number.isSafeInteger(value.createdAt) ||
      !Number.isSafeInteger(value.reservedAt) ||
      (value.proof !== undefined &&
        (value.proof?.kind !== 'chat' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(value.proof.chatId) ||
          !/^[A-Za-z0-9_-]{8,80}$/.test(value.proof.clientId) ||
          !/^m_[a-f0-9]{64}$/.test(value.proof.turnId) ||
          !/^[a-f0-9]{64}$/.test(value.proof.contentHash))) ||
      (value.state === 'done' && (!value.result || !Number.isInteger(value.result.status)))
    ) {
      throw new MobileInputError(
        'operation_journal_corrupt',
        'Журнал мобильных операций повреждён.',
        503,
      );
    }

    return value;
  }

  /**
   * Считает общий бюджет и убирает только доказанные итоги старше суток.
   * Pending/unknown сохраняются без TTL, защищая от повторения неоднозначного эффекта.
   */
  private async capacity(): Promise<void> {
    await fs.mkdir(this.directory, {
      recursive: true,
      mode: 0o700,
    });

    let count = 0;
    let bytes = 0;

    for (const device of await fs.readdir(this.directory)) {
      if (!/^d[a-f0-9]{8,32}$/.test(device)) {
        continue;
      }

      for (const name of await fs.readdir(path.join(this.directory, device))) {
        if (!name.endsWith('.json')) {
          continue;
        }

        const file = path.join(this.directory, device, name);
        const record = await this.read(file);

        if (
          record?.state === 'done' &&
          this.now() - (record.finishedAt ?? record.reservedAt) > 86400000
        ) {
          await fs.rm(file);

          continue;
        }

        count += 1;

        const size = (await fs.stat(file)).size;

        bytes += record?.state === 'done' ? size : Math.max(size, MAX_RECORD_BYTES);
      }
    }

    if (count >= this.maxRecords || bytes + MAX_RECORD_BYTES > this.maxBytes) {
      throw new MobileInputError(
        'operation_journal_full',
        'Журнал операций заполнен. Новая команда не принята.',
        503,
      );
    }
  }

  /**
   * Только читает исход операции своего устройства, без запуска обработчика.
   * Pending другого процесса означает неизвестный исход после падения, а не разрешение повтора.
   */
  async get(device: string, key: string) {
    const file = this.file(device, key);
    let record = await this.read(file);

    if (!record) {
      return {
        state: 'not_found',
        result: null,
      };
    }

    if (record.state !== 'done' && record.boot !== this.boot && record.proof && this.recover) {
      record = await serialized(file, async () => {
        const latest = (await this.read(file))!;

        await this.restore(device, file, latest);

        return latest;
      });
    }

    const state =
      record.state === 'pending' && record.boot !== this.boot ? 'unknown' : record.state;

    return {
      state,
      result: record.result,
    };
  }

  /**
   * Старый intent завершается лишь при точном совпадении server-owned accepted turn.
   * Восстановление читает общий ledger и никогда не выполняет обработчик операции повторно.
   */
  private async restore(device: string, file: string, record: Record): Promise<void> {
    if (record.state === 'done' || record.boot === this.boot || !record.proof || !this.recover) {
      return;
    }

    const result = await this.recover(device, record.proof);

    if (!result) {
      return;
    }

    const restored: Record = {
      ...record,
      state: 'done',
      result,
      finishedAt: this.now(),
    };

    if (Buffer.byteLength(JSON.stringify(restored)) > MAX_RECORD_BYTES) {
      throw new MobileInputError(
        'operation_unknown',
        'Исход команды требует сверки состояния.',
        409,
      );
    }

    await privateWrite(file, JSON.stringify(restored));
    Object.assign(record, restored);
  }

  /**
   * Пишет intent с fsync до эффекта и результат с fsync до ответа клиенту.
   * Повтор после неоднозначной ошибки никогда автоматически не выполняет обработчик снова.
   */
  async run(
    device: string,
    key: string,
    input: OperationInput,
    effect: () => Promise<OperationResult>,
  ) {
    const file = this.file(device, key);

    if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
      throw new MobileInputError('bad_operation', 'Укажите исходное время операции.');
    }

    const hash = fingerprint(input);
    const job = serialized(file, async () => {
      const existing = await this.read(file);

      if (existing) {
        if (existing.fingerprint !== hash) {
          throw new MobileInputError(
            'idempotency_conflict',
            'Ключ уже принадлежит другой операции.',
            409,
          );
        }

        await this.restore(device, file, existing);

        if (existing.state === 'done') {
          return existing.result!;
        }

        throw new MobileInputError(
          'operation_unknown',
          'Исход команды неизвестен. Перечитайте состояние.',
          409,
        );
      }

      if (input.createdAt > this.now() + 60000 || this.now() - input.createdAt > 600000) {
        throw new MobileInputError('operation_expired', 'Время приёма этой команды истекло.', 409);
      }

      const record: Record = {
        version: 1,
        fingerprint: hash,
        boot: this.boot,
        createdAt: input.createdAt,
        reservedAt: this.now(),
        state: 'pending',
        result: null,
        ...(input.proof ? { proof: input.proof } : {}),
      };

      await serialized(this.directory, async () => {
        await this.capacity();
        await privateWrite(file, JSON.stringify(record));
      });

      const result = await effect();

      if (Buffer.byteLength(JSON.stringify(result)) > 262144) {
        throw new MobileInputError(
          'operation_unknown',
          'Исход команды требует сверки состояния.',
          409,
        );
      }

      record.state = 'done';
      record.finishedAt = this.now();
      record.result = result;

      if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) {
        throw new MobileInputError(
          'operation_unknown',
          'Исход команды требует сверки состояния.',
          409,
        );
      }

      await privateWrite(file, JSON.stringify(record));

      return result;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        job,
        new Promise<OperationResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: 202,
                body: { operationPending: true },
              }),
            25000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
