import { randomBytes } from 'node:crypto';
import tls from 'node:tls';

/**
 * Замороженный минимальный peer исходного v1 не импортирует новый parser или relay server.
 * Он знает только прежние роли, ACK и incoming; capability намеренно игнорируется.
 */
export function legacyRelay({ key, cert, brainToken, deviceToken }) {
  const sockets = new Set();
  const pending = new Map();
  let control;

  /**
   * Обрабатывается только первая ограниченная LF-строка, затем передаются непрочитанные байты.
   * Проверка версии предшествует role/token, как в исходном relay v1.
   */
  function accept(socket) {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));

    let saved = Buffer.alloc(0);

    /**
     * В v1 первая строка определяет единственную роль соединения до любых туннельных байтов.
     * Неизвестная версия отклоняется без согласования нового client target.
     */
    function receive(chunk) {
      saved = Buffer.concat([saved, chunk]);

      const end = saved.indexOf(10);

      if (end < 0 && saved.length <= 2048) {
        return;
      }

      socket.off('data', receive);
      socket.pause();

      if (end < 0 || end > 2048) {
        socket.end('{"ok":false,"error":"bad_hello"}\n');

        return;
      }

      let hello;

      try {
        hello = JSON.parse(saved.subarray(0, end));
      } catch {
        socket.end('{"ok":false,"error":"bad_hello"}\n');

        return;
      }

      if (hello.v !== 1) {
        socket.end('{"ok":false,"error":"bad_version"}\n');

        return;
      }

      if (hello.role === 'health') {
        socket.end('{"ok":true}\n');

        return;
      }

      const expected = hello.role === 'device' ? deviceToken : brainToken;

      if (hello.token !== expected) {
        socket.end('{"ok":false,"error":"unauthorized"}\n');

        return;
      }

      if (hello.role === 'brain-control') {
        control?.destroy();
        control = socket;
        socket.write('{"ok":true}\n');

        return;
      }

      if (hello.role === 'device' && control && !control.destroyed) {
        const id = randomBytes(16).toString('hex');

        pending.set(id, socket);
        control.write(`${JSON.stringify({ t: 'incoming', id })}\n`);

        return;
      }

      const device = hello.role === 'brain-data' ? pending.get(hello.id) : null;

      if (!device) {
        socket.end('{"ok":false,"error":"unknown_id"}\n');

        return;
      }

      pending.delete(hello.id);
      socket.write('{"ok":true}\n');
      device.write('{"ok":true}\n');

      if (saved.length > end + 1) {
        socket.unshift(saved.subarray(end + 1));
      }

      socket.pipe(device);
      device.pipe(socket);
      socket.once('close', () => device.destroy());
      device.once('close', () => socket.destroy());
      socket.resume();
      device.resume();
    }

    socket.on('data', receive);
  }

  const server = tls.createServer({
    key,
    cert,
    minVersion: 'TLSv1.3'
  }, accept);

  return {
    listen(host, port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }

      return new Promise((resolve) => server.close(resolve));
    },
  };
}
