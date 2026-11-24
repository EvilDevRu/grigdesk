import { sshApi } from '../../shared/sshApi.ts';
import { useSshStore } from '../../stores/ssh.ts';
import { runtimeOf } from './sshRuntime.ts';
import type { TerminalSink, TerminalSocketFactory } from './sshRuntime.ts';

// Сокет открыт — можно писать. Заглушка проверки состояния не объявляет вовсе, и её
// молчание значит «готов»: иначе тест не смог бы отправить ни одного кадра.
function ready(socket: { readyState?: number } | null): boolean {
  return socket?.readyState === undefined || socket.readyState === 1;
}

/**
 * Подмена конструктора сокета для проверки. Настоящему WebSocket нужен сервер, а
 * поведение переключения вкладок должно проверяться без сети.
 */
export function useSshSocketFactory(factory: TerminalSocketFactory | undefined): void {
  if (factory) {
    runtimeOf(useSshStore()).WebSocket = factory;
  }
}

/**
 * Открыть канал терминала к выбранной сессии. Поколение растёт на каждом переключении:
 * ответ прошлого сокета, пришедший после смены вкладки, не должен попасть в чужой
 * терминал — а закрытие сокета в браузере происходит не мгновенно.
 */
export function activateSshSession(id: string): void {
  const store = useSshStore();
  const sid = String(id || '');
  const runtime = runtimeOf(store);

  runtime.generation += 1;

  const generation = runtime.generation;

  runtime.socket?.close?.();
  runtime.socket = null;
  store.setActive(sid);
  store.setTerminalStatus(sid ? 'connecting' : 'idle');

  if (!sid) {
    return;
  }
  if (!runtime.WebSocket) {
    store.setTerminalStatus('detached');

    return;
  }

  const sink = runtime.terminal;
  const reset = new Promise<void>((resolve) => {
    if (sink?.reset) {
      sink.reset(resolve);
    } else {
      resolve();
    }
  });
  const socket = new runtime.WebSocket(sshApi.terminalUrl(sid));

  socket.binaryType = 'arraybuffer';
  runtime.socket = socket;

  socket.onopen = () => {
    if (runtime.generation !== generation || runtime.socket !== socket) {
      return;
    }

    if (runtime.size) {
      socket.send?.(JSON.stringify(runtime.size));
    }

    void reset.then(() => {
      if (runtime.generation === generation && runtime.socket === socket) {
        store.setTerminalStatus('ready');
      }
    });
  };

  socket.onmessage = (event) => {
    if (runtime.generation !== generation || runtime.socket !== socket) {
      return;
    }

    const data = event?.data;

    if (data instanceof Blob) {
      void data.arrayBuffer().then((value) => {
        if (runtime.generation === generation && runtime.socket === socket) {
          runtime.terminal?.write?.(new Uint8Array(value));
        }
      });

      return;
    }

    const output = data instanceof ArrayBuffer ? new Uint8Array(data) : data as string;

    runtime.terminal?.write?.(output);
  };

  socket.onclose = () => {
    if (runtime.generation === generation) {
      runtime.socket = null;
      store.setTerminalStatus('detached');
    }
  };
}

/**
 * Куда писать пришедшие байты. Терминал заводит панель — обвязка операций только
 * запоминает его и переживает переключение вкладок сессий.
 */
export function bindSshTerminal(terminal: TerminalSink | null): void {
  runtimeOf(useSshStore()).terminal = terminal;
}

/**
 * Нажатие человека уезжает в оболочку. Закрытый сокет молча теряет ввод: показать
 * его в терминале и не отправить было бы хуже, чем не показать вовсе.
 */
export function sendSshInput(data: string): void {
  const store = useSshStore();
  const socket = runtimeOf(store).socket;

  if (store.terminalStatus === 'ready' && ready(socket)) {
    socket?.send?.(JSON.stringify({ t: 'in', d: String(data) }));
  }
}

/**
 * Размер окна уезжает на сервер и запоминается: сокет мог ещё не открыться, и тогда
 * последний известный размер отправится в onopen — иначе удалённый PTY остался бы
 * с размером по умолчанию до первой ручной перетяжки границы.
 */
export function resizeSshTerminal(cols: number, rows: number): void {
  const runtime = runtimeOf(useSshStore());

  runtime.size = {
    t: 'resize',
    cols,
    rows,
  };

  const socket = runtime.socket;

  if (ready(socket)) {
    socket?.send?.(JSON.stringify(runtime.size));
  }
}

/**
 * Отпустить канал, не трогая саму сессию. Сессия принадлежит серверу: закрытая вкладка
 * или уход со страницы не должны обрывать чужую работу в терминале.
 */
export function detachSshTerminal(): void {
  const store = useSshStore();
  const runtime = runtimeOf(store);

  runtime.generation += 1;
  runtime.socket?.close?.();
  runtime.socket = null;
  store.setTerminalStatus('idle');
  store.setActive('');
}
