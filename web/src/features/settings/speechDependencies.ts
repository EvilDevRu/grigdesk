import type {
  SpeechInstallation,
  SpeechInstallDependency,
} from '../../../../shared/media/speechInstallation.ts';
import type { SpeechEnvironmentCheck } from './resources/speech.ts';

export interface SpeechDependencyAction {
  id: SpeechInstallDependency;
  package: string;
  command: string;
}

const ACTIONS: Record<SpeechInstallDependency, SpeechDependencyAction> = {
  ffmpeg: {
    id: 'ffmpeg',
    package: 'ffmpeg',
    command: 'sudo apt install -y ffmpeg',
  },
  python_venv: {
    id: 'python_venv',
    package: 'python3-venv',
    command: 'sudo apt install -y python3-venv',
  },
};

/**
 * Имена проверок связываются только с известной системной зависимостью ffmpeg.
 * Текст fix и произвольный вывод процессов никогда не становятся командой терминала.
 */
function isFfmpegCheck(check: SpeechEnvironmentCheck): boolean {
  return /^ff(?:mpeg|probe)(?:\s|$)/u.test(check.name);
}

/**
 * Ссылка появляется по отрицательной проверке либо структурированному отказу установщика.
 * Успешная перепроверка ffmpeg скрывает прежнюю подсказку, старые ответы без dependency допустимы.
 */
export function speechDependencyActions(
  checks: readonly SpeechEnvironmentCheck[],
  installation: SpeechInstallation | null,
): SpeechDependencyAction[] {
  const ids = new Set<SpeechInstallDependency>();
  const ffmpeg = checks.filter(isFfmpegCheck);

  if (ffmpeg.some((check) => !check.ok)) {
    ids.add('ffmpeg');
  }

  const dependency = installation?.job?.status === 'failed' ? installation.job.dependency : undefined;

  if (dependency && (dependency !== 'ffmpeg' || !ffmpeg.length)) {
    ids.add(dependency);
  }

  return [...ids].map((id) => ({ ...ACTIONS[id] }));
}
