import { parseBrowserAction } from '../../../../shared/browser/browserActions.ts';
import { browserUrl } from '../../../../shared/browser/browserContract.ts';

interface Grant {
  owner: string;
  tabId: string;
  grantEpoch: number;
  hostGeneration: number;
  url: string;
  paused: boolean;
  missing?: boolean;
}

interface NativeTabResult {
  tabId: string;
  grantEpoch: number;
  url: string;
  pageEpoch?: number;
}

/**
 * Владение вкладкой хранится на сервере независимо от аргументов модели.
 * Команда запоминает epoch до очереди, поэтому revoke/regrant не оживляет старый click.
 */
export function createBrowserAccess(port: {
  generation(): number;
  exists(owner: string): Promise<boolean>;
  queue(owner: string, input: unknown, options: {
    grantEpoch: number;
    authorize(): Promise<boolean>;
    signal?: AbortSignal;
  }): Promise<unknown>;
}) {
  const grants = new Map<string, Grant>();
  const closing = new Set<Grant>();
  const key = (owner: string, tabId: string) => JSON.stringify([owner, tabId]);

  /**
   * Native metadata регистрируется только после результата своего open/manual grant.
   * Отзыв всех предыдущих записей вкладки сохраняет единственного текущего grantee.
   */
  const commit = (owner: string, raw: unknown) => {
    const tab = raw as NativeTabResult;

    if (!tab || !/^[A-Za-z0-9_-]{1,160}$/u.test(tab.tabId)
      || !Number.isSafeInteger(tab.grantEpoch) || tab.grantEpoch < 1) {
      throw new Error('browser_result_invalid');
    }

    const url = browserUrl(tab.url);

    for (const [id, grant] of grants) {
      if (grant.tabId === tab.tabId) {
        grants.delete(id);
      }
    }

    grants.set(key(owner, tab.tabId), {
      owner,
      tabId: tab.tabId,
      grantEpoch: tab.grantEpoch,
      hostGeneration: port.generation(),
      url,
      paused: false,
    });
  };

  return {
    commitGrant: commit,
    /**
     * Отзыв удаляет все серверные записи одной вкладки независимо от owner.
     * Повторная выдача получит другую эпоху и не оживит ожидающую команду.
     */
    revoke(tabId: string) {
      for (const [id, grant] of grants) {
        if (grant.tabId === tabId) {
          grants.delete(id);
        }
      }
    },
    clear() {
      grants.clear();
    },
    /**
     * Heartbeat меняет эпоху/паузу только уже известного grant и никогда не назначает owner.
     * Переход origin в native снимает grant; old-origin projection не расширяет его.
     */
    reconcile(rows: {
      tabId: string;
      grantEpoch: number;
      pageEpoch: number;
      paused: boolean
    }[]) {
      for (const [id, grant] of grants) {
        const row = rows.find((item) => item.tabId === grant.tabId);

        if (!row && closing.has(grant) && grant.hostGeneration === port.generation()) {
          grant.missing = true;

          continue;
        }

        if (!row || grant.hostGeneration !== port.generation()) {
          grants.delete(id);

          continue;
        }

        if (row.grantEpoch >= grant.grantEpoch) {
          grant.grantEpoch = row.grantEpoch;
          grant.paused = row.paused;
          grant.missing = false;
        }
      }
    },
    /**
     * Proof validator принадлежит конкретному request, а не общей переменной owner.
     * Проверка повторяется в очереди, перед выдачей, authorize и при результате.
     */
    async invoke(owner: string, raw: unknown, options: {
      signal?: AbortSignal;
      authorize?: () => Promise<boolean>;
    } = {}) {
      const input = parseBrowserAction(raw);
      const generation = port.generation();
      const grant = input.tabId ? grants.get(key(owner, input.tabId)) : undefined;
      const epoch = grant?.grantEpoch ?? 0;
      let closingStarted = false;
      /**
       * Проверка связывает существующего владельца, proof и поколение host.
       * После await grant должен по-прежнему совпадать с захваченной эпохой.
       */
      const authorize = async () => {
        const exists = await port.exists(owner);
        const proof = !options.authorize || await options.authorize();

        if (!exists || !proof || generation !== port.generation()) {
          return false;
        }

        if (!input.tabId) {
          return true;
        }

        const current = grants.get(key(owner, input.tabId));

        return Boolean(current && (!current.missing || closingStarted && current === grant)
          && !current.paused && current.grantEpoch === epoch
          && current.hostGeneration === generation);
      };

      if (!await authorize()) {
        throw new Error('browser_access_denied');
      }

      /**
       * Native close удаляет вкладку до ACK, а heartbeat может прийти раньше ответа.
       * Только этот запрос сохраняет право завершения через пропавшую проекцию;
       * явный revoke, regrant, смена host и proof по-прежнему отменяют его.
       */
      if (input.action === 'close' && grant) {
        closingStarted = true;
        closing.add(grant);
      }

      let result: unknown;

      try {
        result = await port.queue(owner, input, {
          grantEpoch: epoch,
          authorize,
          signal: options.signal,
        });

        if (!await authorize()) {
          throw new Error('browser_access_denied');
        }
      } finally {
        if (closingStarted && grant) {
          closing.delete(grant);

          if (grant.missing && grants.get(key(owner, grant.tabId)) === grant) {
            grants.delete(key(owner, grant.tabId));
          }
        }
      }

      if (result && typeof result === 'object' && (result as { ok?: boolean }).ok === false) {
        return result;
      }

      if (input.action === 'open') {
        commit(owner, result);
      }

      if (input.action === 'close') {
        for (const [id, item] of grants) {
          if (item.tabId === input.tabId) {
            grants.delete(id);
          }
        }
      }

      if (input.action === 'list') {
        const source = result as { tabs?: NativeTabResult[] };

        return { ok: true, tabs: (source.tabs ?? []).filter((tab) => {
          const allowed = grants.get(key(owner, tab.tabId));

          return allowed && !allowed.paused && allowed.grantEpoch === tab.grantEpoch
            && allowed.hostGeneration === generation;
        }) };
      }

      return result;
    },
  };
}
