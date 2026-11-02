import { isPlainRecord } from '../lib/objects.ts';

export const SPEECH_INSTALL_OPERATIONS = ['install', 'update', 'uninstall'] as const;

export type SpeechInstallOperation = typeof SPEECH_INSTALL_OPERATIONS[number];

export const SPEECH_INSTALL_DEPENDENCIES = ['ffmpeg', 'python_venv'] as const;

export type SpeechInstallDependency = typeof SPEECH_INSTALL_DEPENDENCIES[number];

export interface SpeechInstallJob {
  id: string;
  operation: SpeechInstallOperation;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  stage: 'environment' | 'packages' | 'gpu' | 'model' | 'verification' | 'removal' | 'done';
  output: string;
  error: string;
  dependency?: SpeechInstallDependency;
}

export interface SpeechInstallation {
  managed: boolean;
  installed: boolean;
  job: SpeechInstallJob | null;
}

/**
 * Ответ установки проверяется отдельно от настроек и моделей речи.
 * Неизвестное состояние не открывает кнопки файловых операций.
 */
export function decodeSpeechInstallation(value: unknown): SpeechInstallation {
  if (!isPlainRecord(value) || typeof value.managed !== 'boolean'
    || typeof value.installed !== 'boolean' || !('job' in value)) {
    throw new TypeError('Некорректный ответ установщика речи');
  }

  const job = value.job;

  if (job !== null && (!isPlainRecord(job) || typeof job.id !== 'string'
    || !SPEECH_INSTALL_OPERATIONS.includes(job.operation as SpeechInstallOperation)
    || !['running', 'succeeded', 'failed', 'interrupted'].includes(String(job.status))
    || !['environment', 'packages', 'gpu', 'model', 'verification', 'removal', 'done']
      .includes(String(job.stage))
    || typeof job.output !== 'string' || typeof job.error !== 'string'
    || (job.dependency !== undefined
      && !SPEECH_INSTALL_DEPENDENCIES.includes(job.dependency as SpeechInstallDependency)))) {
    throw new TypeError('Некорректное состояние установки речи');
  }

  return {
    managed: value.managed,
    installed: value.installed,
    job: job as SpeechInstallJob | null,
  };
}
