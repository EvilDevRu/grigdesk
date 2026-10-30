import type { Locator, Page } from '../../../desktop/node_modules/playwright-core/index.js';

/**
 * Находим исходный индекс по адаптеру, но выбираем через видимый общий список.
 * Браузер проходит настоящие click, прокрутку, disabled и закрытие popup.
 */
export async function selectUiOption(page: Page, trigger: Locator, value: string): Promise<void> {
  const index = await trigger.evaluate((button, expected) => {
    const native = button.closest('.ui-select-wrap')?.querySelector('select');

    return native ? [...native.options].findIndex((option) => option.value === expected) : -1;
  }, value);

  if (index < 0) {
    throw new Error('Вариант отсутствует в UiSelect: ' + value);
  }

  await trigger.click();

  const popup = page.locator('.ui-select-popup');

  await popup.locator('[data-option-index="' + index + '"]').click();
  await popup.waitFor({ state: 'hidden' });
}
