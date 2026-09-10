import { sseSubscribe } from '../../composables/useSse.ts';
import { useDbStore } from '../../stores/db.ts';
import { loadDb, refreshDbAudit, refreshDbQueries } from './loadDb.ts';
import { runtimeOf } from './dbRuntime.ts';

/**
 * Подписка на события раздела заводится один раз. Сессии открывает и закрывает
 * сервер — в том числе по таймауту простоя и вслед за упавшим туннелем, — поэтому
 * список живёт событиями; лента запросов и журнал приходят своими и не тянут
 * за собой перечитывание всего раздела.
 */
export function watchDb(): void {
  const runtime = runtimeOf(useDbStore());

  if (runtime.off) {
    return;
  }

  runtime.off = sseSubscribe((name: string) => {
    if (name === 'db-sessions') {
      void loadDb();
    }

    if (name === 'db-queries') {
      void refreshDbQueries().catch(() => {});
    }

    if (name === 'db-audit') {
      void refreshDbAudit().catch(() => {});
    }
  });
}
