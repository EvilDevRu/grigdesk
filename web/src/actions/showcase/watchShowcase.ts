import { sseSubscribe } from '../../composables/useSse.js';
import { parseShowcaseProgressEvent } from '../../../../shared/showcaseContracts';
import { loadShowcase } from './loadShowcase';
import { loadShowcaseVoices } from './setupShowcaseVoice';
import { runtimeOf } from './showcaseRuntime';
import type { ShowcaseStore } from './showcaseRuntime';

/**
 * Подписка на события раздела. Прогресс задания применяется точечно — шаги идут
 * минутами, и перечитывать весь обзор на каждый незачем. Изменение ролика и
 * переподключение потока перечитывают обзор целиком: пропущенные за разрыв
 * события догонять нечем, и склеенное из обрывков состояние было бы выдумкой.
 */
export function watchShowcase(store: ShowcaseStore): () => void {
  const runtime = runtimeOf(store);

  if (runtime.off) {
    return runtime.off;
  }

  const off = sseSubscribe((name: string, data: unknown) => {
    if (name === 'showcase-progress') {
      try {
        const event = parseShowcaseProgressEvent(data);
        const known = store.jobs.find((job) => job.id === event.jobId);

        // Событие несёт только сводку: полное задание берётся из обзора. Пока
        // задания нет в состоянии, точечно применять нечего — перечитываем список.
        if (!known) {
          void loadShowcase(store);

          return;
        }

        store.applyJob({
          ...known,
          state: event.state,
          sequence: event.sequence,
        });
      } catch {
        void loadShowcase(store);
      }

      return;
    }

    // Установка голоса идёт своим чередом и роликов не касается: перечитывается
    // только каталог голосов, а список роликов остаётся нетронутым.
    if (name === 'showcase-voice') {
      void loadShowcaseVoices(store);

      return;
    }

    if (name === 'showcase-changed' || name === 'hello') {
      void loadShowcase(store);
      void loadShowcaseVoices(store);
    }
  });

  runtime.off = () => {
    off();
    runtime.off = null;
  };

  return runtime.off;
}
