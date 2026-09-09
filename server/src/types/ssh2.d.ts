// Библиотека ssh2 своих типов не поставляет, а отдельного пакета типов в зависимостях
// сервера нет. Здесь объявлено ровно то, чем пользуется кокпит: канал оболочки, канал
// команды, SFTP и прямой туннель. Это описание НАШЕГО использования, а не всей ssh2 —
// новый вызов библиотеки придётся сначала объявить здесь, и это к лучшему: рубеж
// сетевого доступа не должен расширяться незаметно.

declare module 'ssh2' {
  import type { EventEmitter } from 'node:events';
  import type { Duplex, Readable, Writable } from 'node:stream';

  export interface ConnectConfig {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    readyTimeout?: number;
    hostHash?: string;
    hostVerifier?: (key: Buffer | string) => boolean;
    [option: string]: unknown;
  }

  export interface ClientChannel extends Duplex {
    stderr?: Readable;
    close?: () => void;
    setWindow?: (rows: number, cols: number, height: number, width: number) => void;
  }

  export interface FileEntry {
    filename: string;
    attrs?: {
      size?: number;
      mtime?: number;
      isDirectory?: () => boolean;
    };
  }

  export interface SFTPWrapper extends EventEmitter {
    readdir: (
      path: string,
      callback: (error: Error | undefined, list: FileEntry[]) => void,
    ) => void;
    createReadStream: (path: string) => Readable;
    createWriteStream: (path: string) => Writable;
    end?: () => void;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): this;
    shell(
      settings: Record<string, unknown>,
      callback: (error: Error | undefined, channel: ClientChannel) => void,
    ): void;
    exec(
      command: string,
      options: Record<string, unknown>,
      callback: (error: Error | undefined, channel: ClientChannel) => void,
    ): void;
    sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): void;
    forwardOut(
      sourceHost: string,
      sourcePort: number,
      targetHost: string,
      targetPort: number,
      callback: (error: Error | undefined, channel: ClientChannel) => void,
    ): void;
    end(): void;
    destroy?(): void;
  }
}
