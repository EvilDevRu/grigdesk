import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Картинки dynamic tools сохраняются отдельно от короткой ленты и истории чата.
 * Одна приватная папка и квота принадлежат ходу; имена не зависят от ответа инструмента.
 */
export function createCodexToolImages(artifactsDir?: string) {
  const paths = new Map<string, string>();
  let directory: Promise<string> | undefined;
  let count = 0;

  /**
   * Общая папка берётся из конфигурации сервера, а приватная создаётся атомарно.
   * Одновременные вызовы используют одну подготовку без повторного создания папок.
   */
  async function prepareDirectory(): Promise<string> {
    await mkdir(artifactsDir!, { recursive: true, mode: 0o700 });

    const root = await realpath(artifactsDir!);

    return mkdtemp(path.join(root, 'tool-images-'));
  }

  /**
   * Принимает только JPEG data URL после проверки codexDynamicToolResponse.
   * Квота ограничивает диск, а ошибка записи не меняет ответ, который получает агент.
   */
  async function save(callId: string, imageUrl: string): Promise<void> {
    if (!artifactsDir || paths.has(callId) || count >= 32) {
      return;
    }

    count += 1;
    directory ??= prepareDirectory();

    const folder = await directory;
    const file = path.join(folder, `${randomUUID()}.jpg`);
    const data = imageUrl.slice('data:image/jpeg;base64,'.length);

    await writeFile(file, Buffer.from(data, 'base64'), { flag: 'wx', mode: 0o600 });
    paths.set(callId, file);
  }

  return {
    save,
    pathFor: (callId: string) => paths.get(callId) || '',
  };
}
