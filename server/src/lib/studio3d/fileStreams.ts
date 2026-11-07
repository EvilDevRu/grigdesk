// Потоки заимствуют descriptor: FileHandle остаётся у вызывающей операции.
// Даже destroy при ошибке не закрывает fd повторно и не маскирует исходный отказ.
import { createReadStream, createWriteStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/**
 * Чтение учитывает активные операции FileHandle, а close потока не закрывает inode.
 * Caller проверяет ревизию и закрывает handle после завершения pipeline.
 */
export function borrowedReadStream(handle: FileHandle, name: string) {
  return createReadStream(name, {
    fd: handle.fd,
    autoClose: false,
    start: 0,
    fs: {
      read(_fd, buffer, offset, length, position, callback) {
        void handle.read(buffer, offset, length, position)
          .then((result) => callback(null, result.bytesRead, buffer), (error) => callback(error, 0, buffer));
      },
      close(_fd, callback) {
        callback(null);
      },
    },
  });
}

/**
 * Запись оставляет descriptor открытым для fsync после EOF и уборки после ошибки.
 * Все write проходят через владельца FileHandle, повторный native close отсутствует.
 */
export function borrowedWriteStream(handle: FileHandle, name: string) {
  return createWriteStream(name, {
    fd: handle.fd,
    autoClose: false,
    fs: {
      write(_fd, buffer, offset, length, position, callback) {
        void handle.write(buffer, offset, length, position)
          .then((result) => callback(null, result.bytesWritten, buffer), (error) => callback(error,
            0, buffer));
      },
      close(_fd, callback) {
        callback(null);
      },
    },
  });
}
