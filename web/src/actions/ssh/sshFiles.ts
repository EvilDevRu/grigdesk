import { sshApi } from '../../shared/sshApi.ts';
import { useSshStore } from '../../stores/ssh.ts';

/**
 * Каталог на сервере. Пустой путь означает текущий — так его понимает и сам SFTP,
 * а показанный путь запоминается: загрузка файла кладёт его именно туда.
 */
export async function listSshFiles(remotePath?: string): Promise<void> {
  const store = useSshStore();
  const target = remotePath || store.remotePath || '.';

  store.setFiles(target, await sshApi.files(store.activeId, target));
}

/**
 * Адрес скачивания файла активной сессии. Это обычная ссылка страницы, поэтому
 * сессия в неё входит явно — на момент клика активной может стать другая.
 */
export function sshDownloadUrl(remotePath: string): string {
  return sshApi.downloadUrl(useSshStore().activeId, remotePath);
}

/**
 * Загрузка файла на сервер. Список каталога перечитывается сразу: иначе только что
 * положенного файла не видно, и человек отправляет его второй раз.
 */
export async function uploadSshFile(file: File, remotePath: string): Promise<void> {
  const store = useSshStore();

  await sshApi.uploadFile(store.activeId, file, remotePath);
  await listSshFiles();
}
