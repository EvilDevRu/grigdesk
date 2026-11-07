import { projectsApi, projectsFailureText } from '../../shared/projectsApi';
import { useProjectsStore } from '../../stores/projects';
import { forgetProject, runtimeOf } from './projectsRuntime';

/**
 * Список проектов целиком — вместе с архивными: прятать их должен потребитель, а
 * список один на раздел.
 *
 * Каждый вызов получает свой номер: событие сервера и действие человека приходят почти
 * одновременно, и ответ на более старый запрос не должен затирать более свежий.
 */
export async function loadProjects(): Promise<void> {
  const store = useProjectsStore();
  const runtime = runtimeOf(store);

  runtime.listRequest += 1;

  const request = runtime.listRequest;

  store.setLoading(true);

  try {
    const response = await projectsApi.list();
    const items = response.filter((item) => !store.deletedIds.has(item.id));

    if (request !== runtime.listRequest) {
      return;
    }

    const selected = store.opened?.id || runtime.selectedId;

    if (selected && !items.some((item) => item.id === selected)) {
      store.setLoading(false);
      forgetProject(store, selected);
    }

    store.setItems(items);
    store.setError('');
  } catch (error) {
    if (request !== runtime.listRequest) {
      return;
    }

    store.setError(projectsFailureText(error, 'Не удалось прочитать список проектов.'));
  } finally {
    if (request === runtime.listRequest) {
      store.setLoading(false);
    }
  }
}
