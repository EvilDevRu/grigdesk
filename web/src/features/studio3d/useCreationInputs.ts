// Входные файлы одной формы: общий upload cache, поколения и локальные preview URL.
// Смена библиотеки сохраняет прежние особенности очистки выбранных файлов.
import { ref, shallowRef } from 'vue';
import type { Ref } from 'vue';
import type { Studio3dUpload } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { StudioViewFiles } from '../../views/studio3d/ViewSlots.vue';
import { readStudioImage } from './studioImages.ts';
import { studioErrorMessage } from './presentation.ts';

interface CreationInputsPorts {
  upload(file: File): Promise<Studio3dUpload>;
  error: Ref<string>;
  isAlive(): boolean;
  readImage?: typeof readStudioImage;
}

/**
 * Владеет файлами и одним uploading ref, не регистрируя watchers или lifecycle hooks.
 * SFC вызывает обработчики на прежних местах и освобождает их после alive=false.
 */
export function useCreationInputs(ports: CreationInputsPorts) {
  const { error, isAlive } = ports;
  const readImage = ports.readImage ?? readStudioImage;
  const primaryUpload = ref<Studio3dUpload | null>(null);
  const primaryPreview = ref('');
  const primaryName = ref('');
  const ownUpload = ref<Studio3dUpload | null>(null);
  const ownName = ref('');
  const viewUploads = ref<{ role: string; uploadId: string }[]>([]);
  const viewFiles = shallowRef<StudioViewFiles>({
    front: null,
    left: null,
    back: null,
    right: null
  });
  const uploading = ref(false);
  let inputGeneration = 0;
  let uploadCache = new WeakMap<File, Promise<Studio3dUpload>>();

  /**
   * Blob upload memoized по File и library marker; перестановка видов не создаёт копий.
   * Отклонённая загрузка удаляет cache, чтобы явный повтор мог её восстановить.
   */
  function upload(file: File): Promise<Studio3dUpload> {
    let work = uploadCache.get(file);
    
    if (!work) {
      work = ports.upload(file);
      uploadCache.set(file, work);
      void work.catch(() => uploadCache.delete(file));
    }
    
    return work;
  }

  /**
   * Замена картинки освобождает локальный URL и отзывает прежний вход вместе с ценой.
   * Незавершённая загрузка после очистки не может вернуть удалённое изображение.
   */
  function clearPrimary(): void {
    inputGeneration += 1;
    primaryUpload.value = null;
    primaryName.value = '';

    if (primaryPreview.value) {
      URL.revokeObjectURL(primaryPreview.value);
      primaryPreview.value = '';
    }
  }

  /**
   * Удаление выбранного файла сбрасывает готовность бесплатного импорта, а не только подпись picker.
   * Ответ незавершённой загрузки после очистки больше не может вернуть прежний файл.
   */
  function clearOwn(): void {
    inputGeneration += 1;
    ownUpload.value = null;
    ownName.value = '';
  }

  /**
   * Выбор картинки проверяет bytes до upload и освобождает bitmap после decode.
   * Поколение исключает замену нового входа поздним ответом прежнего файла.
   */
  async function choosePrimary(input?: File): Promise<void> {
    if (!input) {
      return;
    }
    
    clearPrimary();

    const current = inputGeneration;
    
    uploading.value = true;
    error.value = '';
    
    try {
      const { file, bitmap } = await readImage(input);
      
      bitmap.close();
      
      const result = await upload(file);
      
      if (isAlive() && current === inputGeneration) {
        primaryUpload.value = result;
        primaryPreview.value = URL.createObjectURL(file);
        primaryName.value = input.name;
      }
    } catch (cause) {
      if (current === inputGeneration) {
        error.value = studioErrorMessage(cause);
      }
    } finally { if (current === inputGeneration) {
      uploading.value = false;
    } }
  }

  /**
   * Собственный файл передаётся серверу как бесплатный импорт, без run/UUID заказа.
   * GLTF с внешними ресурсами получает подсказку до HTTP, остальные контейнеры проверяет сервер.
   */
  async function chooseOwnFile(file?: File): Promise<void> {
    if (!file) {
      return;
    }
    
    ownUpload.value = null;
    ownName.value = '';
    error.value = '';

    const current = ++inputGeneration;

    uploading.value = false;
    
    const ext = file.name.split('.').at(-1)?.toLowerCase();
    
    if (ext === 'gltf') {
      error.value = 'Для импорта .gltf сохраните самостоятельный .glb.';
      
      return;
    }
    if (!['glb', 'fbx', 'obj', 'stl', 'splat'].includes(ext ?? '') || file.size > 150 * 1024 * 1024) {
      error.value = 'Поддержаны GLB, FBX, OBJ, STL, splat до 150 МиБ.';
      
      return;
    }
    
    uploading.value = true;
    
    try {
      const result = await upload(file);
      
      if (isAlive() && current === inputGeneration) {
        ownUpload.value = result;
        ownName.value = file.name;
        error.value = '';
      }
    } catch (cause) {
      if (current === inputGeneration) {
        error.value = studioErrorMessage(cause);
      }
    } finally { if (current === inputGeneration) {
      uploading.value = false;
    } }
  }

  /**
   * Виды загружаются совместно, а перестановка сохраняет identity тех же File.
   * Поколение не даёт завершившейся старой загрузке вернуть удалённый вход.
   */
  async function uploadViews(files: StudioViewFiles): Promise<void> {
    const current = ++inputGeneration;
    
    uploading.value = true;
    viewUploads.value = [];
    
    try {
      const result = await Promise.all(Object.entries(files).filter(([, file]) => file)
        .map(async ([role, file]) => ({ role, uploadId: (await upload(file!)).uploadId })));
      
      if (isAlive() && current === inputGeneration) {
        viewUploads.value = result;
      }
    } catch (cause) {
      if (current === inputGeneration) {
        error.value = studioErrorMessage(cause);
      }
    } finally { if (current === inputGeneration) {
      uploading.value = false;
    } }
  }

  /**
   * Новый marker отзывает uploads и cache; preview и имена остаются по прежнему правилу.
   * Незавершённые запросы сохраняют прежние проверки поколения.
   */
  function resetForLibrary(): void {
    inputGeneration += 1;
    uploadCache = new WeakMap();
    primaryUpload.value = null;
    ownUpload.value = null;
    viewUploads.value = [];
  }

  /**
   * Освобождение формы отзывает локальный preview и прежний выбор primary.
   * Остальные async ответы отсекаются внешним isAlive и поколением входа.
   */
  function dispose(): void {
    clearPrimary();
  }

  return {
    primaryUpload,
    primaryPreview,
    primaryName,
    ownUpload,
    ownName,
    viewUploads,
    viewFiles,
    uploading,
    choosePrimary,
    chooseOwnFile,
    clearPrimary,
    clearOwn,
    uploadViews,
    resetForLibrary,
    dispose
  };
}
