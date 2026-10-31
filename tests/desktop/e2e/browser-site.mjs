import http from 'node:http';

/**
 * Сайт принадлежит только этой приёмке и не обращается к реальным сервисам.
 * Форма позволяет наблюдать сохранение DOM, ввод и повторный submit.
 */
export async function browserSite() {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>
  <label>Значение <input aria-label="Значение"></label>
  <button id="submit">Отправить</button><output id="count">0</output>
  <a href="/second" target="_blank">Новая вкладка</a>
  <script>
    document.cookie = 'fixtureBrowser=one; SameSite=Lax';
    document.querySelector('#submit').onclick = () => {
      const output = document.querySelector('#count');
      output.value = String(Number(output.value) + 1);
      console.error('browser-fixture-error');
    };
  </script></body></html>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
