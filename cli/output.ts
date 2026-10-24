import type { StatusSnapshot } from './status.ts';
import { runAttached } from './system.ts';

export interface PairingOutput {
  text: string;
  qr: { rows: string[] };
}

export interface DeviceOutput {
  id: string;
  name: string;
  scope: string;
  revokedAt: number | null;
}

export interface CliOutput {
  write(text: string): void;
  error(text: string): void;
  attached(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<number>;
  status?(snapshot: StatusSnapshot): void;
  pairing?(pairing: PairingOutput): void;
  devices?(devices: readonly DeviceOutput[]): void;
}

// Прямые вызовы и скрипты сохраняют свои потоки и точные байты прежнего формата.
// Экран терминала передаёт собственный приёмник, не подменяя глобальные stdout и console.
export const plainOutput: CliOutput = {
  write: (text) => {
    process.stdout.write(text);
  },
  error: (text) => {
    process.stderr.write(text);
  },
  attached: runAttached,
};
