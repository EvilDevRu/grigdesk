import type { MediaJob, MediaPlanTask } from '../../shared/media/mediaContracts.ts';
import { parseMediaJob } from '../../shared/media/mediaContracts.ts';
import { mediaApi } from '../../web/src/shared/mediaApi.ts';
import type { VideoDraft } from '../../web/src/stores/videoSession.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type JobIsChecked = Checked<IsUnchecked<MediaJob>>;
export type TaskIsChecked = Checked<IsUnchecked<MediaPlanTask>>;
export type ApiPlanIsChecked = Checked<IsUnchecked<Awaited<ReturnType<typeof mediaApi.planTasks>>>>;

/**
 * Примеры запускает только компилятор. Черновик задачи собран моделью по чужой речи,
 * и непроверенный ответ не имеет права доехать до сеанса разбора молча.
 */
function checkContracts(input: unknown, draft: VideoDraft): void {
  // @ts-expect-error Непроверенный JSON не является состоянием разбора.
  const unchecked: MediaJob = input;
  // @ts-expect-error Состояние разбора ограничено объявленным перечислением.
  const status: MediaJob['status'] = 'queued';
  // @ts-expect-error Части встречи всегда едут списком: один id склеить не с чем.
  mediaApi.planTasks({ jobId: 'job-1', hint: '' });
  // @ts-expect-error Секунда фрагмента является числом.
  mediaApi.clip({ jobIds: ['job-1'], at: '271', window: 15 });
  // @ts-expect-error Кадр приходит именем внутри каталога, а не путём на диске.
  draft.frame = { path: '/tmp/frame.jpg', at: 271 };

  const job = parseMediaJob(input);

  // @ts-expect-error Результат появляется только у законченного разбора.
  job.result.transcript.segments.length.toFixed();

  void [unchecked, status];
}

void checkContracts;
