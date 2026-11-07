import assert from 'node:assert/strict';

/**
 * Каталог сравнивается с реально смонтированной страницей, а не её исходником.
 * Адреса сериализуются целиком с сегментами, чтобы не склеивать динамические ключи.
 */
export function assertSettingsFields(root, catalog, pageId) {
  const expected = catalog.filter((field) => field.address.pageId === pageId)
    .map((field) => JSON.stringify(field.address)).sort();
  const actual = [...root.querySelectorAll('[data-settings-field]')]
    .map((node) => node.getAttribute('data-settings-field'))
    .filter((address) => !JSON.parse(address).entityId).sort();

  assert.deepEqual(actual, expected);
}
