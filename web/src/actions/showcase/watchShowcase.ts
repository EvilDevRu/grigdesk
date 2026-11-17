import { sseSubscribe } from '../../composables/useSse.ts';
import {
  parseShowcaseBuildProgressEvent,
  parseShowcaseChangedEvent,
  parseShowcaseProgressEvent,
} from '../../../../shared/plugins/showcase/showcaseContracts';
import { loadShowcase } from './loadShowcase';
import { openShowcaseProject } from './openShowcaseProject';
import { loadShowcaseVoices } from './setupShowcaseVoice';
import { runtimeOf, showcaseProjectOwner } from './showcaseRuntime';
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

  /**
   * Событие перечитывает только карточку владельца. Owner захвачен до GET,
   * а для hello — до ожидания обзора, поэтому intent B отменяет его ещё при opened=A.
   */
  function refreshOpened(projectId: string, current: () => boolean): void {
    if (current()) {
      void openShowcaseProject(store, projectId, current);
    }
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

        // Подпись, счётчик и причина отказа применяются вместе с состоянием: строку
        // хода человек читает прямо сейчас, а отказ без причины — красная точка с
        // прежней подписью, по которой нечего решать.
        if (!store.applyJob({
          ...known,
          state: event.state,
          sequence: event.sequence,
          progress: {
            index: event.index ?? known.progress.index,
            total: event.total ?? known.progress.total,
            label: event.label,
          },
          error: event.error ?? known.error,
        })) {
          void loadShowcase(store);
        }
      } catch {
        void loadShowcase(store);
      }

      return;
    }

    if (name === 'showcase-build-progress') {
      try {
        const event = parseShowcaseBuildProgressEvent(data);

        if (!store.applyBuildProgress(event)) {
          void loadShowcase(store);
        }

        if (
          event.state === 'awaiting_review'
          || event.state === 'succeeded'
          || event.state === 'failed'
          || event.state === 'interrupted'
          || event.state === 'cancelled'
        ) {
          const openedId = store.opened?.id;
          const current = showcaseProjectOwner(store, openedId ?? null);

          void loadShowcase(store);

          if (openedId === event.projectId) {
            refreshOpened(openedId, current);
          }
        }
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
      const current = showcaseProjectOwner(store, openedId);

      try {
        const event = parseShowcaseChangedEvent(data);

        if (openedId && event.projectId === openedId) {
          refreshOpened(openedId, current);
        }
      } catch {
        // Событие не по форме — обзор ниже всё равно перечитается целиком.
      }
    }

    // Каталог целей включает ручные песочницы. После их подъёма или сноса форма
    // должна обновиться сама, даже если ни один ролик при этом не менялся.
    if (name === 'showcase-changed' || name === 'sandboxes-changed'
      || name === 'projects-changed' || name === 'hello') {
      const openedId = store.opened?.id ?? null;
      const current = showcaseProjectOwner(store, openedId);
      const refreshed = loadShowcase(store, { fresh: name === 'projects-changed' || name === 'hello' });

      if (name === 'hello' && openedId) {
        void refreshed.then(() => refreshOpened(openedId, current));
      }

      void loadShowcaseVoices(store);
    }
  });

  runtime.off = () => {
    off();
    runtime.off = null;
  };

  return runtime.off;
}
