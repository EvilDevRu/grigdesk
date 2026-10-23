import tls from 'node:tls';

/**
 * Сокет остаётся открытым после первого ответа, чтобы занять реальный бюджет TLS-входа.
 * Чтение ограничено заголовком: SSE не накапливается в памяти и не требует полного ответа.
 */
export async function heldRequest(t, f, port, client, url = '/api/phone-hold') {
  const socket = tls.connect({
    host: f.host,
    port,
    key: client.keyPem,
    cert: client.certPem,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  });

  t.after(() => socket.destroy());
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });

  const status = await new Promise((resolve, reject) => {
    let saved = '';
    const timer = setTimeout(() => reject(new Error('fixture_header_timeout')), 3000);

    socket.on('data', function receive(bytes) {
      saved += bytes.toString('ascii');

      if (saved.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.off('data', receive);
        resolve(Number(saved.split(' ')[1]));
      }
    });
    socket.write(`GET ${url} HTTP/1.1\r\nHost: fixture\r\nConnection: keep-alive\r\n\r\n`);
  });

  return { socket, status };
}
