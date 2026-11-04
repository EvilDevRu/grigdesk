import { ref } from 'vue';

// Поддержка подтверждается снимком собственной установки; отсутствие версии не разрешает
// писать own-метки через внешние ручки или бесконечно повторять неизвестные endpoints.
export const grigdeskPersonalStateVersion = ref<1 | null>(null);
