import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { DesktopSettings } from './settings.ts';
import { localOrigin } from './connection.ts';

export interface DesktopProfile {
  id: string;
  name: string;
  kind: 'local' | 'remote';
  address: string;
  fp: string | null;
  port: number;
  createdAt: number;
}

export interface ProfileInput {
  name: string;
  kind: 'local' | 'remote';
  address: string;
  fp: string | null;
}

/**
 * Удалённый адрес не содержит пути, userinfo или скрытой смены протокола.
 * IPv6 остаётся зарезервированным для следующей версии формата привязки.
 */
export function remoteAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]{1,253}(?::[1-9]\d{0,4})?$/.test(value)) {
    return null;
  }

  try {
    const url = new URL(value);

    return Number(url.port || 443) <= 65535 ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Профиль хранит только публичные адреса и pin, закрытого ключа здесь нет.
 * Повреждённая запись не расширяет границы допустимых origin и портов трубы.
 */
export function normalizeProfile(value: unknown): DesktopProfile | null {
  const item = value as DesktopProfile | null;

  if (!item || typeof item.id !== 'string' || !/^[\w-]{1,80}$/.test(item.id)
    || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100
    || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0
    || !Number.isInteger(item.port) || item.port < 47101 || item.port > 47199) {
    return null;
  }

  const address = item.kind === 'local'
    ? (item.address === 'http://127.0.0.1' ? item.address : localOrigin(item.address))
    : remoteAddress(item.address);

  if (!['local', 'remote'].includes(item.kind) || !address
    || (item.kind === 'remote' && !/^[a-f0-9]{64}$/.test(item.fp || ''))) {
    return null;
  }

  return {
    id: item.id,
    name: item.name.trim(),
    kind: item.kind,
    address,
    fp: item.kind === 'remote' ? item.fp : null,
    port: item.port,
    createdAt: item.createdAt,
  };
}

/**
 * Проверка порта не касается чужого процесса: занятый адрес просто отклоняется.
 * Окончательное listen ещё может проиграть гонку, её обрабатывает владелец трубы.
 */
async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export class Profiles {
  readonly settings: DesktopSettings;
  private save: () => Promise<void>;
  private available: (port: number) => Promise<boolean>;

  constructor(options: {
    settings: DesktopSettings;
    save: () => Promise<void>;
    available?: (port: number) => Promise<boolean>;
  }) {
    this.settings = options.settings;
    this.save = options.save;
    this.available = options.available || portAvailable;
  }

  /**
   * Предпочтительный порт сохраняется, пока свободен и не принадлежит другому профилю.
   * Новый выбор записывается до первой загрузки, чтобы настройки origin оставались стабильны.
   */
  async claimPort(id: string): Promise<number> {
    const profile = this.get(id);
    const used = new Set(this.settings.profiles.filter((item) => item.id !== id).map((item) => item.port));
    const candidates = [profile.port, ...Array.from({ length: 99 }, (_, i) => 47101 + i)];

    for (const port of candidates) {
      if (!used.has(port) && await this.available(port)) {
        if (profile.port !== port) {
          profile.port = port;
          await this.save();
        }

        return port;
      }
    }

    throw new Error('Не удалось выбрать свободный порт приложения.');
  }

  get(id: string): DesktopProfile {
    const profile = this.settings.profiles.find((item) => item.id === id);

    if (!profile) {
      throw new Error('Машина не найдена.');
    }

    return profile;
  }

  /**
   * Повтор привязки одного сертификата обновляет существующую запись без нового origin.
   * Выбор свободного порта и запись нового профиля завершаются одной операцией сохранения.
   */
  async add(input: ProfileInput): Promise<DesktopProfile> {
    const existing = this.settings.profiles.find((item) => input.kind === 'local'
      ? item.kind === 'local' : item.kind === 'remote' && item.fp === input.fp);

    if (existing) {
      existing.address = input.address;
      existing.name = input.name;
      await this.save();

      return existing;
    }

    const profile = normalizeProfile({
      ...input,
      id: randomUUID(),
      port: 47101,
      createdAt: Date.now(),
    });

    if (!profile) {
      throw new Error('Неверные настройки машины.');
    }

    const used = new Set(this.settings.profiles.map((item) => item.port));
    let found = false;

    for (let port = 47101; port <= 47199; port += 1) {
      if (!used.has(port) && await this.available(port)) {
        profile.port = port;
        found = true;
        break;
      }
    }

    if (!found) {
      throw new Error('Не осталось свободных портов приложения.');
    }

    this.settings.profiles.push(profile);
    await this.save();

    return profile;
  }

  async select(id: string | null): Promise<void> {
    if (id !== null) {
      this.get(id);
    }

    this.settings.selected = id;
    await this.save();
  }

  /**
   * Удаление выбранной машины возвращает оболочку к экрану без профиля.
   * Соседние origin и их настройки не переиспользуются автоматически.
   */
  async remove(id: string): Promise<void> {
    this.get(id);
    this.settings.profiles = this.settings.profiles.filter((item) => item.id !== id);

    if (this.settings.selected === id) {
      this.settings.selected = null;
    }

    await this.save();
  }
}
