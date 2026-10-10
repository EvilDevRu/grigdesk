import tls from 'node:tls';

const port = Number(process.env.RELAY_PORT ?? 7443);
const socket = tls.connect({
  host: '127.0.0.1',
  port,
  rejectUnauthorized: false,
  minVersion: 'TLSv1.3',
});
let complete = false;
let saved = '';

/**
 * Завершает локальную проверку без бесконечного ожидания сокета.
 * TLS без пина здесь ограничен одним контейнерным loopback-адресом.
 */
function finish(code: number) {
  if (complete) {
    return;
  }

  complete = true;
  clearTimeout(timer);
  socket.destroy();
  process.exitCode = code;
}

const timer = setTimeout(() => finish(1), 3000);

socket.once('secureConnect', () => socket.write('{"v":1,"role":"health"}\n'));
socket.once('error', () => finish(1));
socket.once('close', () => finish(1));
socket.on('data', (chunk: Buffer) => {
  saved += chunk.toString('utf8');

  if (saved.length > 2048) {
    finish(1);

    return;
  }

  if (saved.includes('\n')) {
    try {
      finish(JSON.parse(saved.trim()).ok === true ? 0 : 1);
    } catch {
      finish(1);
    }
  }
});
