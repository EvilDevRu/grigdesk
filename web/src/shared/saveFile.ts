import { getActivePinia } from 'pinia';
import { useShellStore } from '../stores/shell.ts';

/**
 * Capability читается из уже обнаруженной оболочки текущего документа.
 * До создания Pinia сохраняется обычное поведение браузера.
 */
export function canSaveInShell(): boolean {
  const pinia = getActivePinia();

  return Boolean(pinia && useShellStore(pinia).capabilities.includes('save'));
}

/**
 * Нативная оболочка получает исходные байты без прикладного журнала API.
 * Обычный браузер использует временную ссылку и всегда освобождает её ресурс.
 */
export async function saveFile(blob: Blob, name: string): Promise<void> {
  if (canSaveInShell()) {
    const query = new URLSearchParams({ name, type: blob.type });
    const response = await fetch(`/__shell/save?${query}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: blob,
    });

    if (!response.ok) {
      throw new Error('Не удалось сохранить файл.');
    }

    return;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

/**
 * Ссылочная загрузка проходит через тот же способ сохранения, что и созданный Blob.
 * Внешние адреса не получают cookie приложения при чтении файла.
 */
export async function saveLinkedFile(href: string, name?: string): Promise<void> {
  const response = await fetch(href, { credentials: 'same-origin' });

  if (!response.ok) {
    throw new Error('Не удалось скачать файл.');
  }

  const filename = name || new URL(href, location.href).pathname.split('/').pop() || 'файл';

  await saveFile(await response.blob(), filename);
}
