// Нереактивная обвязка операций раздела: сокет терминала, его поколение, сам xterm,
// последний размер окна и подписка на события. В состоянии им не место — Pinia сделала
// бы реактивными сокет и функцию отписки, а привязка к экземпляру стора нужна, чтобы
// свежий стор (например, в тесте) начинал с чистой обвязки, а не наследовал чужую.
import type { useSshStore } from '../../stores/ssh.ts';

export type SshStore = ReturnType<typeof useSshStore>;

export interface TerminalSink {
  write?: (data: string | Uint8Array) => void;
}

export interface TerminalSocket {
  readyState?: number;
  close?: () => void;
  send?: (payload: string) => void;
  onopen?: (() => void) | null;
  onmessage?: ((event: { data?: unknown }) => void) | null;
  onclose?: (() => void) | null;
}

export type TerminalSocketFactory = new (url: string) => TerminalSocket;

export interface TerminalSize {
  t: 'resize';
  cols: number;
  rows: number;
}

export interface SshRuntime {
  WebSocket: TerminalSocketFactory | undefined;
  socket: TerminalSocket | null;
  generation: number;
  terminal: TerminalSink | null;
  size: TerminalSize | null;
  off: (() => void) | null;
}

const runtimes = new WeakMap<object, SshRuntime>();

/**
 * Обвязка своего экземпляра стора; заводится при первом обращении к нему. Живёт в
 * WeakMap, поэтому вместе со стором исчезает и она — забытый сокет не переживёт свой
 * стор и не начнёт писать в терминал закрытой вкладки.
 */
export function runtimeOf(store: SshStore): SshRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = {
      WebSocket: globalThis.WebSocket as unknown as TerminalSocketFactory | undefined,
      socket: null,
      generation: 0,
      terminal: null,
      size: null,
      off: null,
    };
    runtimes.set(store, runtime);
  }

  return runtime;
}
