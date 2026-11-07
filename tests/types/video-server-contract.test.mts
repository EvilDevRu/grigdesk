import { parseByteRange, toMediaJob } from '../../server/src/modules/media/index.ts';
import type { MediaModuleOptions } from '../../server/src/modules/media/index.ts';
import type { MediaJob } from '../../shared/media/mediaContracts.ts';

type IsUnchecked<Value> = 0 extends (1 & Value) ? true : false;
type Checked<Value extends false> = Value;

export type ProjectionIsChecked = Checked<IsUnchecked<ReturnType<typeof toMediaJob>>>;
export type RangeIsChecked = Checked<IsUnchecked<ReturnType<typeof parseByteRange>>>;

/**
 * Проекция джоба — граница между машиной и браузером: пути исходника и рабочего
 * каталога в неё не входят, и соседний JavaScript не должен их туда вернуть.
 */
function checkServerContracts(options: MediaModuleOptions): void {
  const projected: MediaJob = toMediaJob({ status: 'done', filePath: '/srv/record.mp4' });

  // @ts-expect-error Путь исходника наружу не отдаётся вовсе.
  projected.filePath;
  // @ts-expect-error Диапазон байт считается от известного размера файла.
  parseByteRange('bytes=0-10');
  // @ts-expect-error Статус читается по идентификатору разбора.
  options.media.status();

  const range = parseByteRange('bytes=0-10', 100);

  if (range && range !== 'invalid') {
    range.start.toFixed();
  }
}

void checkServerContracts;
