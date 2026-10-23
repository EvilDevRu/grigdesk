import { randomBytes } from 'node:crypto';

import { deviceName, MobileInputError } from './errors.ts';
import { serialized } from './files.ts';
import type { Device, DeviceScope, DeviceStore } from './store.ts';

type Code = {
  exp: number;
  attemptId?: string;
  connected?: boolean;
  scope: DeviceScope;
  name?: string;
  fp?: string;
  result?: Device;
};

export class PairingCodes {
  private devices: DeviceStore;
  private now: () => number;
  private codes = new Map<string, Code>();
  private failures = new Map<
    string,
    {
      count: number;
      exp: number;
    }
  >();

  constructor({ devices, now = Date.now }: { devices: DeviceStore; now?: () => number }) {
    this.devices = devices;
    this.now = now;
  }

  /**
   * Удаляет истёкшие коды и окна перебора, ограничивая состояние привязки.
   * Результат использованного кода остаётся доступным до его прежнего exp.
   */
  private sweep() {
    for (const [code, item] of this.codes) {
      if (item.exp <= this.now()) {
        this.codes.delete(code);
      }
    }

    for (const [fp, item] of this.failures) {
      if (item.exp <= this.now()) {
        this.failures.delete(fp);
      }
    }
  }

  /**
   * Выдаёт одноразовый код только в памяти процесса на десять минут.
   * Переполнение отказывает новой выдаче без удаления ещё действующих кодов.
   */
  issue(input: { scope?: DeviceScope; name?: unknown } = {}): {
    code: string;
    exp: number;
  } {
    this.sweep();

    if (this.codes.size >= 100) {
      throw new MobileInputError('pair_busy', 'Слишком много действующих кодов привязки.', 429);
    }

    const code = randomBytes(24).toString('base64url');
    const exp = this.now() + 600000;

    this.codes.set(code, {
      exp,
      scope: input.scope ?? 'mobile-v1',
      ...(input.name === undefined ? {} : { name: deviceName(input.name) }),
    });

    return {
      code,
      exp,
    };
  }

  /**
   * Корреляция хранится в той же ограниченной TTL-записи, что одноразовый код.
   * Успех подтверждает только новый authenticated hello устройства результата.
   */
  issuePhone() {
    const issued = this.issue({ scope: 'client', name: 'Телефон' });
    const item = this.codes.get(issued.code)!;

    item.attemptId = randomBytes(16).toString('hex');

    return { ...issued, attemptId: item.attemptId };
  }

  /**
   * Неудачная сборка конверта не оставляет действующий бесхозный секрет.
   * Отзывается только ещё не использованный код текущей выдачи.
   */
  cancelPhone(code: string): void {
    const item = this.codes.get(code);

    if (item?.attemptId && !item.result) {
      this.codes.delete(code);
    }
  }

  /**
   * Незнакомая либо истёкшая попытка не раскрывает сведения о чужом устройстве.
   * Pair остаётся pending до hello сертификата, связанного с результатом кода.
   */
  phoneProgress(attemptId: string) {
    const item = [...this.codes.values()].find((value) => value.attemptId === attemptId);

    if (!item || item.exp <= this.now()) {
      return { status: 'expired' };
    }

    return item.connected && item.result
      ? { status: 'connected', device: { id: item.result.id, name: item.result.name } }
      : { status: 'pending' };
  }

  /**
   * Подтверждение допускается только для результата ещё действующего телефонного кода.
   * Вызвавший модуль передаёт id из TLS principal, а не из тела клиента.
   */
  confirmPhone(deviceId: string): void {
    for (const item of this.codes.values()) {
      if (item.attemptId && item.result?.id === deviceId && item.exp > this.now()) {
        item.connected = true;
      }
    }
  }

  /**
   * Связывает код с сертификатом текущего TLS только после устойчивой записи устройства.
   * Конкурентные повторы тем же ключом получают прежний результат без второго устройства.
   */
  pair(code: string, fp: string, name: unknown, scope: DeviceScope = 'mobile-v1',
    peer = fp): Promise<Device> {
    return serialized(`pair:${code}`, async () => {
      this.sweep();

      const failed = this.failures.get(peer);

      if ((failed?.count ?? 0) >= 5) {
        throw new MobileInputError(
          'pair_locked',
          'Слишком много попыток привязки. Повторите позже.',
          429,
        );
      }

      const item = this.codes.get(code);

      if (!item || item.scope !== scope || (item.fp && item.fp !== fp)) {
        if (!failed && this.failures.size >= 4096) {
          this.failures.delete(this.failures.keys().next().value!);
        }

        this.failures.set(peer, {
          count: (failed?.count ?? 0) + 1,
          exp: failed?.exp ?? this.now() + 600000,
        });

        throw new MobileInputError(
          'pair_code_invalid',
          'Код привязки недействителен или истёк.',
          401,
        );
      }

      if (item.result) {
        return item.result;
      }

      const device = await this.devices.add({
        name: item.name ?? name,
        fp,
        scope,
      });

      item.fp = fp;
      item.result = device;

      return device;
    });
  }
}
