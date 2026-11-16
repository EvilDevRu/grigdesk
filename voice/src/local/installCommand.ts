import type { VoiceIO } from '../app.ts';
import type { VoiceConfig } from '../config.ts';
import { VoiceError } from '../contract.ts';
import { localPackage } from './catalogs.ts';
import { installLocalEngine, type InstallResult, type InstallSpec } from './install.ts';

/**
 * Производственная factory связывает CLI с тем же installer, который проверяют интеграционные тесты.
 * Фикстура меняет пакет и системные порты, не заменяя staged acceptance или публикацию состояния.
 */
export function buildInstallSpec(engineId: string, config: VoiceConfig, io: VoiceIO): InstallSpec {
  const pack = localPackage(engineId, io.localPackages);

  if (!pack) {
    throw new VoiceError('Установить можно только локальный движок piper или silero.', 2);
  }

  return {
    package: pack,
    voiceDir: config.voiceDir,
    fetch: io.fetch,
    run: io.spawn,
    scriptPath: io.scriptPath,
    bootstrapPython: io.bootstrapPython,
    signal: io.signal,
    timeoutMs: io.installTimeoutMs,
    commandTimeoutMs: io.installCommandTimeoutMs,
    downloadTimeoutMs: io.downloadTimeoutMs,
    log: (message) => io.writeStderr(`${message}\n`),
  };
}

/**
 * Выполняет install без скрытых серверных настроек, готовых manifest и доступа к ключевым файлам.
 * Возвращаемый результат описывает опубликованный пакет; формат stdout выбирает общий CLI.
 */
export async function installCommand(
  engineId: string,
  config: VoiceConfig,
  io: VoiceIO,
): Promise<InstallResult> {
  return installLocalEngine(buildInstallSpec(engineId, config, io));
}
