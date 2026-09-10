import { extractMediaLinks } from '../../server/src/lib/media/media.ts';
import { readIngestJob, runProcess } from '../../server/src/lib/media/ingest.ts';
import { buildMeetingFrames } from '../../server/src/lib/media/meetingFrames.ts';
import { buildMeetingClip, meetingClipPath } from '../../server/src/lib/media/meetingClips.ts';
import { runMeetingPlan } from '../../server/src/lib/media/meetingPlan.ts';
import { preflight } from '../../server/src/lib/media/preflight.ts';
import { storeUpload } from '../../server/src/lib/media/storage.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type PlanIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof runMeetingPlan>>>>;
export type JobIsChecked = Checked<IsUnchecked<ReturnType<typeof readIngestJob>>>;
export type PreflightIsChecked = Checked<IsUnchecked<ReturnType<typeof preflight>>>;

/**
 * Границу разбора видео держат четыре вещи: отказ, названный кодом, отсутствие
 * артефакта как законный исход, имя вместо пути наружу и список аргументов вместо
 * строки для внешнего процесса. Отрицательные примеры запрещают ослабить любую из
 * них: без первой человек не узнает, что чинить, без второй разбор потеряет уже
 * разобранные задачи из-за картинки, без третьей из браузера попросят любой файл
 * сервера, а без четвёртой чужой текст доедет до ffmpeg склейкой команды.
 */
async function checkMediaContracts(name: unknown, source: AsyncIterable<Buffer>): Promise<void> {
  const plan = await runMeetingPlan({});

  if (!plan.ok) {
    plan.error.toUpperCase();
    // @ts-expect-error Отказ разбора назван кодом: задач у него нет вовсе.
    plan.tasks.length;
  }

  const frames = await buildMeetingFrames({});

  // @ts-expect-error Кадра у задачи может не быть — список держит и пропуски.
  frames[0].name.toLowerCase();

  const clip = await buildMeetingClip({});

  // @ts-expect-error Фрагмент не обязан получиться: запись бывает без видеодорожки.
  clip.name.toLowerCase();

  // @ts-expect-error Наружу уходит имя `<разбор>/<файл>`, и чужого файла за ним нет.
  const clipFile: string = meetingClipPath('/media/clips', name);

  const job = readIngestJob('job-1', '/jobs');

  // @ts-expect-error Задачи распознавания может не быть на диске вовсе.
  job.status.toLowerCase();

  const stored = await storeUpload({ dir: '/uploads', filename: name, source });

  // @ts-expect-error У обрезанной загрузки пути нет — на диск она не попала.
  stored.filePath.toLowerCase();

  // @ts-expect-error Аргументы внешнего процесса — список, а не готовая строка.
  runProcess('ffmpeg', '-version');

  // @ts-expect-error Отчёт о среде — список проверок, а не одно число.
  preflight().checks.toFixed();

  for (const link of extractMediaLinks('')) {
    // @ts-expect-error Вид ссылки — перечисление, и чужого значения в нём нет.
    const kind: 'audio' = link.kind;

    void kind;
  }

  void clipFile;
}

void checkMediaContracts;
