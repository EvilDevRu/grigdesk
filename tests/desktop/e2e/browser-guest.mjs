import assert from 'node:assert/strict';
import { waitFor } from './tool-window-fixture.mjs';

/**
 * WebContentsView не является BrowserWindow, поэтому ищем его WebContents в main.
 * Test-only evaluate используется только для наблюдения синтетической страницы.
 */
export async function waitForGuest(app, url) {
  let id = null;

  await waitFor(async () => {
    id = await app.evaluate(({ webContents }, prefix) => {
      return webContents.getAllWebContents().find((item) => item.getURL().startsWith(prefix))?.id ?? null;
    }, url);

    return id !== null;
  });
  assert.equal(typeof id, 'number');
  await waitFor(() => app.evaluate(async ({ webContents }, targetId) => {
    const target = webContents.fromId(targetId);

    return target && !target.isDestroyed()
      && await target.executeJavaScript('document.readyState') === 'complete';
  }, id));


  return {
    id,
    /**
     * Фикстурный source задан самим тестом, а не моделью или сайтом.
     * Отсутствие WebContents после закрытия имеет явную причину отказа.
     */
    async evaluate(source) {
      return app.evaluate(({ webContents }, value) => {
        const target = webContents.fromId(value.id);

        if (!target || target.isDestroyed()) {
          throw new Error('browser_guest_missing');
        }

        return target.executeJavaScript(value.source);
      }, { id, source });
    },
    async isVisible() {
      return app.evaluate(({ BrowserWindow }, targetId) => {
        const views = BrowserWindow.getAllWindows().flatMap((window) => window.contentView.children);
        const view = views.find((item) => item.webContents?.id === targetId);

        return view?.getVisible() ?? false;
      }, id);
    },
  };
}
