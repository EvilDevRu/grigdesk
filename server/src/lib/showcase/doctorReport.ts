// Готовность раздела: что можно делать прямо сейчас и чего не хватает.
//
// Отчёт не обещает возможностей заранее. Каждая операция называет своё состояние
// и причину словами, а недоступная — не исчезает из списка: пропавший пункт
// человек читает как «всё в порядке», и это худшая из возможных неправд.
//
// Пробы, которые ходят в сеть или стоят денег, помечены как ручные и сами по
// себе не запускаются.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

import type { ShowcaseDoctor, ShowcaseTarget, ShowcaseTargetRef } from '../../../../shared/showcaseContracts.ts';
import type { VoiceEngineStatus } from './voice/registry.ts';

const run = promisify(execFile);

export interface DoctorDeps {
  browserPath: string | null;
  showcaseDir: string;
  // Состояние голосовых движков берётся у реестра: у раздела не должно быть
  // второго мнения о том, чем он умеет говорить.
  voiceStatuses: () => Promise<VoiceEngineStatus[]>;
  // Расшифровка приходит из общего речевого runtime кокпита. Её отсутствие не
  // закрывает раздел, но и проверка речи тогда не выдаётся за пройденную.
  transcribeAvailable: boolean;
  resolveTarget: (ref: ShowcaseTargetRef, profile: string) => Promise<ShowcaseTarget>;
}

type Operation = ShowcaseDoctor['operations'][number];

/**
 * Пункт цели и вход на стенд. Оба зависят от того, объявил ли профиль контракт,
 * поэтому считаются вместе — иначе «цель готова» и «входа нет» разъехались бы по
 * разным причинам.
 */
function targetOperations(target: ShowcaseTarget | null): Operation[] {
  const loginReady = target?.status === 'ready' && target.scope.capabilities.includes('login');

  return [
    {
      id: 'target',
      title: 'Цель показа',
      status: target === null ? 'unknown' : (target.status === 'ready' ? 'ready' : 'blocked'),
      reason: target === null
        ? 'Цель не выбрана.'
        : (target.status === 'ready' ? 'Адрес и экраны объявлены профилем.' : target.reason),
      manual: false,
    },
    {
      id: 'login',
      title: 'Вход на стенд',
      status: loginReady ? 'ready' : 'unknown',
      reason: loginReady
        ? 'Профиль объявил вход тестовой учётки.'
        : 'Профиль не объявил вход: запись пойдёт без него.',
      manual: false,
    },
  ];
}

async function mediaOperation(): Promise<Operation> {
  const media = await Promise.all(['ffmpeg', 'ffprobe'].map(async (tool) => {
    try {
      await run(tool, ['-version']);

      return true;
    } catch {
      return false;
    }
  }));
  const ready = media.every(Boolean);

  return {
    id: 'media',
    title: 'Сборка видео',
    status: ready ? 'ready' : 'blocked',
    reason: ready ? 'ffmpeg и ffprobe доступны.' : 'Нет ffmpeg или ffprobe: собрать ролик нечем.',
    manual: false,
  };
}

/**
 * Пункт голоса. Готовым он считается по ГОТОВОМУ движку, а не по наличию
 * адаптеров: подключённый, но неустановленный движок озвучить ничего не может,
 * и обещать это нельзя.
 */
function voiceOperation(statuses: VoiceEngineStatus[]): Operation {
  const ready = statuses.find((status) => status.doctor.status === 'ready');

  if (ready) {
    return {
      id: 'voice',
      title: 'Голос',
      status: 'ready',
      reason: `Озвучка идёт движком «${ready.name}» на этой машине.`,
      manual: false,
    };
  }

  const named = statuses.find((status) => status.doctor.install) ?? statuses[0];

  return {
    id: 'voice',
    title: 'Голос',
    status: 'blocked',
    reason: named
      ? `${named.doctor.reason} ${named.doctor.install}`.trim()
      : 'Голосовой движок не подключён: доступна загрузка готового звука по сценам.',
    manual: false,
  };
}

export function createDoctorReport(deps: DoctorDeps) {
  async function doctor(ref?: ShowcaseTargetRef, profile?: string): Promise<ShowcaseDoctor> {
    const target = ref && profile ? await deps.resolveTarget(ref, profile) : null;
    const browserReady = deps.browserPath
      ? await fs.access(deps.browserPath).then(() => true).catch(() => false)
      : false;
    const storage = await fs.stat(deps.showcaseDir).then(() => true).catch(() => false);
    const voices = await deps.voiceStatuses().catch(() => [] as VoiceEngineStatus[]);

    return {
      operations: [
        ...targetOperations(target),
        {
          id: 'network',
          title: 'Ограничение сети',
          status: 'unknown',
          reason: 'Проверка границы запускается отдельно: она обращается к адресу показа.',
          manual: true,
        },
        {
          id: 'browser',
          title: 'Браузер записи',
          status: browserReady ? 'ready' : 'blocked',
          reason: browserReady
            ? 'Исполняемый файл браузера на месте.'
            : 'Браузер записи не установлен. Установка — отдельное действие настройки.',
          manual: false,
        },
        await mediaOperation(),
        voiceOperation(voices),
        {
          id: 'speech',
          title: 'Проверка речи',
          status: deps.transcribeAvailable ? 'ready' : 'unknown',
          reason: deps.transcribeAvailable
            ? 'Синтезированная речь сверяется с текстом распознаванием кокпита.'
            : 'Распознавание недоступно: проверка речи будет помечена как пропущенная.',
          manual: false,
        },
        {
          id: 'storage',
          title: 'Хранилище',
          status: storage ? 'ready' : 'warning',
          reason: storage
            ? 'Каталог роликов доступен для записи.'
            : 'Каталог роликов ещё не создан — он появится с первым роликом.',
          manual: false,
        },
      ],
      checkedAt: new Date().toISOString(),
    };
  }

  return { doctor };
}
