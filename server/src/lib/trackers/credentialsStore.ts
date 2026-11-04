import fs from 'node:fs';
import path from 'node:path';

export class TrackerCredentialsStore {
  private driverCredentialsPath: string;

  constructor({ trackerCredentialsPath }: { trackerCredentialsPath: string }) {
    this.driverCredentialsPath = trackerCredentialsPath;
  }

  /**
   * Runtime закрепляет общий файл секретов до первого чтения драйверов.
   * Каждый host получает доступ только к записи своего подключения.
   */
  useTrackerCredentialsPath(file: string): void {
    this.driverCredentialsPath = file;
  }

  /**
   * Каждый host получает только реквизиты своего драйвера.
   * Ошибка чтения закрывает подключение, не раскрывая содержимое файла клиенту.
   */
  readFor(id: string): Record<string, unknown> | null {
    try {
      const stored = JSON.parse(fs.readFileSync(this.driverCredentialsPath, 'utf8'));

      return stored[id] ?? null;
    } catch {
      return null;
    }
  }

  hasEntry(id: string): boolean {
    return this.readFor(id) !== null;
  }

  /**
   * Черновик и запись одинаково сохраняют прежние значения для пустого ввода.
   * Проверка соединения получает копию реквизитов без записи в постоянный файл.
   */
  mergeFor(id: string, values: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...this.readFor(id) };

    for (const [key, value] of Object.entries(values)) {
      if (value !== '') {
        merged[key] = value;
      }
    }

    return merged;
  }

  /**
   * Пустое поле секрета сохраняет прежнее значение при повторном открытии формы.
   * Секреты записываются отдельно от выбора доски с правами только владельца.
   */
  writeFor(id: string, values: Record<string, unknown>): void {
    const merged = this.mergeFor(id, values);

    let stored: Record<string, unknown> = {};

    try {
      stored = JSON.parse(fs.readFileSync(this.driverCredentialsPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    stored[id] = merged;
    fs.mkdirSync(path.dirname(this.driverCredentialsPath), { recursive: true });

    const temporary = `${this.driverCredentialsPath}.tmp`;

    fs.writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.driverCredentialsPath);
  }
}
