import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Диагностика подключается до навигации, чтобы не потерять ошибку загрузки приложения.
 * При отказе сохраняются сеть, консоль и ещё живая страница до очистки фикстуры.
 */
export function browserDiagnostics(page, name) {
  const started = Date.now();
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const httpErrors = [];
  const pending = new Map();
  const elapsed = () => Date.now() - started;

  page.on('console', (message) => consoleMessages.push({
    elapsed: elapsed(),
    type: message.type(),
    text: message.text(),
    location: message.location(),
  }));
  page.on('pageerror', (error) => pageErrors.push({ elapsed: elapsed(), stack: error.stack }));
  page.on('request', (request) => pending.set(request, {
    elapsed: elapsed(),
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
  }));
  page.on('requestfinished', (request) => pending.delete(request));
  page.on('requestfailed', (request) => {
    failedRequests.push({ ...pending.get(request), error: request.failure() });
    pending.delete(request);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      httpErrors.push({
        elapsed: elapsed(),
        url: response.url(),
        status: response.status(),
      });
    }
  });

  /**
   * Сначала сохраняется сеть: даже закрытая страница не должна лишить нас причины отказа.
   * Успешные повторы оставляют тот же журнал загрузки; HTML и снимок нужны только при сбое.
   */
  async function save(error) {
    const root = process.env.GRIGDESK_ARTIFACTS_DIR || os.tmpdir();
    const directory = path.join(root, 'browser-diagnostics', `${name}-${process.pid}-${Date.now()}`);
    const record = {
      name,
      elapsed: elapsed(),
      error: error ? String(error.stack || error) : null,
      consoleMessages,
      pageErrors,
      failedRequests,
      httpErrors,
      pendingRequests: [...pending.values()],
      snapshot: null,
    };

    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'diagnostics.json'), JSON.stringify(record, null, 2));
      record.snapshot = await page.evaluate(() => ({
        url: location.href,
        readyState: document.readyState,
        language: document.documentElement.lang,
        title: document.title,
        text: document.body.innerText,
        appMounted: Boolean(document.querySelector('#app')?.__vue_app__),
      }));
      await fs.writeFile(path.join(directory, 'diagnostics.json'), JSON.stringify(record, null, 2));

      if (error) {
        await fs.writeFile(path.join(directory, 'page.html'), await page.content());
        await page.screenshot({ path: path.join(directory, 'page.png'), timeout: 3000 });
      }
    } catch (diagnosticError) {
      console.error('Не удалось полностью сохранить диагностику браузера:', diagnosticError);
    }

    console.info(`Диагностика браузера: ${directory}`);
  }

  /**
   * Исходное исключение остаётся причиной RED даже при сбое снятия диагностики.
   * Запись успешного результата не заменяет ни одного ожидания самого сценария.
   */
  return async function diagnose(action) {
    try {
      const result = await action();

      await save(null);

      return result;
    } catch (error) {
      await save(error);

      throw error;
    }
  };
}
