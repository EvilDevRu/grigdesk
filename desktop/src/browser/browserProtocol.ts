import { SNAPSHOT_SOURCE, RESOLVE_SOURCE, DOM_ACT_SOURCE } from './pageSnapshot.ts';

interface ProtocolResult {
  result?: { value?: unknown; objectId?: string };
  exceptionDetails?: unknown;
  frameTree?: { frame?: { id?: string } };
  executionContextId?: number;
}

/**
 * Ссылка на элемент принадлежит одному isolated world и одному наблюдению страницы.
 * Смена документа сбрасывает context до следующего успешного snapshot.
 */
export function createBrowserProtocol(port: {
  send(method: string, params?: unknown): Promise<ProtocolResult>;
  epoch(): number;
  allowed(): boolean;
}) {
  let context = 0;
  let worldGlobal = '';
  let snapshotEpoch = 0;

  const check = () => {
    if (!port.allowed()) {
      throw new Error('access_revoked');
    }
  };

  /**
   * Ссылка на isolated-world global не удерживается после смены наблюдения.
   * Уничтоженный context допускает отказ release без восстановления прежних refs.
   */
  const release = () => {
    const previous = worldGlobal;

    context = 0;
    worldGlobal = '';
    snapshotEpoch = 0;

    if (previous) {
      void port.send('Runtime.releaseObject', { objectId: previous }).catch(() => undefined);
    }
  };

  return {
    reset() {
      release();
    },
    /**
     * Snapshot строится в мире расширения, а не в JS-контексте сайта.
     * Каждое ожидание завершается проверкой текущей эпохи перед публикацией refs.
     */
    async snapshot() {
      check();
      release();

      const epoch = port.epoch();
      const frame = await port.send('Page.getFrameTree');
      const frameId = frame.frameTree?.frame?.id;

      if (!frameId) {
        throw new Error('browser_frame_missing');
      }

      const world = await port.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'grigdesk-browser',
        grantUniveralAccess: false,
      });

      context = Number(world.executionContextId);

      if (!context || epoch !== port.epoch()) {
        throw new Error('stale_page');
      }

      const global = await port.send('Runtime.evaluate', {
        expression: 'globalThis',
        contextId: context,
        returnByValue: false,
      });

      worldGlobal = global.result?.objectId ?? '';

      const value = await port.send('Runtime.evaluate', {
        expression: SNAPSHOT_SOURCE,
        contextId: context,
        returnByValue: true,
      });

      check();

      if (value.exceptionDetails || epoch !== port.epoch() || !worldGlobal) {
        throw new Error('stale_page');
      }

      snapshotEpoch = epoch;

      return {
        ...(value.result?.value as object),
        pageEpoch: epoch,
        untrusted: true
      };
    },
    /**
     * Ref передаётся протоколом как значение и не попадает в исполняемую строку.
     * Узел повторно проверяется после scroll и до отправки input events.
     */
    async resolve(ref: string) {
      check();

      if (!worldGlobal || snapshotEpoch !== port.epoch() || !/^e[1-9][0-9]{0,5}$/u.test(ref)) {
        return null;
      }

      const result = await port.send('Runtime.callFunctionOn', {
        objectId: worldGlobal,
        functionDeclaration: RESOLVE_SOURCE,
        arguments: [{ value: ref }],
        returnByValue: true,
      });

      check();

      if (result.exceptionDetails || snapshotEpoch !== port.epoch()) {
        return null;
      }

      return result.result?.value as {
        x: number;
        y: number;
        editable: boolean
      } | null;
    },
    /**
     * DOM-исполнение команды в изолированном мире снимка: путь для вкладок,
     * которых нет на экране. Ref и параметры идут значениями протокола и
     * не собираются в исполняемую строку.
     */
    async act(payload: { action: 'click' | 'fill' | 'scroll'; ref: string; text?: string; deltaY?: number }) {
      check();

      if (!worldGlobal || snapshotEpoch !== port.epoch()) {
        throw new Error('stale_page');
      }

      const result = await port.send('Runtime.callFunctionOn', {
        objectId: worldGlobal,
        functionDeclaration: DOM_ACT_SOURCE,
        arguments: [{ value: payload }],
        returnByValue: true,
      });

      check();

      if (result.exceptionDetails || snapshotEpoch !== port.epoch()) {
        return { ok: false, code: 'stale_page' };
      }

      const value = result.result?.value as { ok?: boolean; code?: string } | null;

      if (!value?.ok) {
        throw new Error(value?.code && /^[a-z_]+$/u.test(value.code) ? value.code : 'stale_element');
      }

      return { ok: true };
    },
  };
}
