import { randomBytes } from 'node:crypto';

import { MobileInputError } from './errors.ts';
import { serialized } from './files.ts';
import type { Device, DeviceStore } from './store.ts';

type Code = {
  exp: number;
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
  issue(): {
    code: string;
    exp: number;
  } {
    this.sweep();

    if (this.codes.size >= 100) {
      throw new MobileInputError('pair_busy', 'Слишком много действующих кодов привязки.', 429);
    }

    const code = randomBytes(24).toString('base64url');
    const exp = this.now() + 600000;

    this.codes.set(code, { exp });

    return {
      code,
      exp,
    };
  }

  /**
   * Связывает код с сертификатом текущего TLS только после устойчивой записи устройства.
   * Конкурентные повторы тем же ключом получают прежний результат без второго устройства.
   */
  pair(code: string, fp: string, name: unknown): Promise<Device> {
    return serialized(`pair:${code}`, async () => {
      this.sweep();

      const failed = this.failures.get(fp);

      if ((failed?.count ?? 0) >= 5 || this.failures.size >= 4096) {
        throw new MobileInputError(
          'pair_locked',
          'Слишком много попыток привязки. Повторите позже.',
          429,
        );
      }

      const item = this.codes.get(code);

      if (!item || (item.fp && item.fp !== fp)) {
        this.failures.set(fp, {
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
        name,
        fp,
      });

      item.fp = fp;
      item.result = device;

      return device;
    });
  }
}
