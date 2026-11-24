import { sshApi } from '../../shared/sshApi.ts';
import { useSshStore } from '../../stores/ssh.ts';
import { errorMessage } from '../../../../shared/lib/errors.ts';
import { localeTranslator } from '../../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../../shared/uiLocalePort.ts';

const translateUi = localeTranslator(uiLocalePort);

function filePath(directory: string, name: string): string {
  return `${directory.replace(/\/$/, '')}/${name}`;
}

/**
 * Запрос привязан к сессии и ревизии списка. Поздний ответ от прежней вкладки
 * или каталога не связывается с кнопками действий новой цели.
 */
export async function listSshFiles(remotePath?: string): Promise<void> {
  const store = useSshStore();
  const sessionId = store.activeId;

  if (!sessionId) {
    return;
  }

  const target = remotePath || store.remotePath || '.';
  const revision = store.startFilesRequest();

  try {
    const files = await sshApi.files(sessionId, target);

    if (store.filesRevision === revision) {
      store.setFiles(target, files);
    }
  } catch (error) {
    if (store.filesRevision === revision) {
      store.setFilesError(errorMessage(error, translateUi('core.sshFilesReadFailed')));
    }
  }
}

/**
 * Ссылка относится к файлу из последнего открытого каталога активной сессии.
 * Путь из поля ввода становится целью только после успешного чтения каталога.
 */
export function sshDownloadUrl(name: string): string {
  const store = useSshStore();

  return sshApi.downloadUrl(store.activeId, filePath(store.remotePath, name));
}

/**
 * Сессия и путь фиксируются до передачи файла. После смены вкладки завершение
 * загрузки не перечитывает каталог нового сервера и не меняет его состояние.
 */
export async function uploadSshFile(file: File): Promise<void> {
  const store = useSshStore();
  const sessionId = store.activeId;
  const directory = store.remotePath;

  if (!sessionId || store.filesStatus !== 'ready') {
    return;
  }

  const revision = store.startFilesRequest();

  try {
    await sshApi.uploadFile(sessionId, file, filePath(directory, file.name));

    if (store.filesRevision === revision) {
      await listSshFiles(directory);
    }
  } catch (error) {
    if (store.filesRevision === revision) {
      store.setFilesError(errorMessage(error, translateUi('core.sshFilesUploadFailed')));
    }
  }
}
