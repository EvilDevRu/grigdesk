import { sseSubscribe } from '../../composables/useSse.ts';
import {
  parseShowcaseChangedEvent,
  parseShowcaseProgressEvent,
} from '../../../../shared/showcaseContracts';
import { loadShowcase } from './loadShowcase';
import { openShowcaseProject } from './openShowcaseProject';
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

    // Открытый ролик перечитывается вместе с обзором: сервер меняет его и без
    // человека — задание публикует клип или звук и поднимает редакцию. Карточка с
    // прежней редакцией отвечала бы на каждую правку конфликтом.
    if (name === 'showcase-changed') {
      const openedId = store.opened?.id ?? null;

      try {
        const event = parseShowcaseChangedEvent(data);

        if (openedId && event.projectId === openedId) {
          void openShowcaseProject(store, openedId);
        }
      } catch {
        // Событие не по форме — обзор ниже всё равно перечитается целиком.
      }
    }

    // Каталог целей включает ручные песочницы. После их подъёма или сноса форма
    // должна обновиться сама, даже если ни один ролик при этом не менялся.
    if (name === 'showcase-changed' || name === 'sandboxes-changed' || name === 'hello') {
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
