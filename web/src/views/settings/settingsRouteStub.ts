import { defineComponent } from 'vue';

// Маршрут существует ради guard: сама страница настроек всегда остаётся модалом.
// Пустой render не создаёт вторую оболочку при начальной навигации.
export default defineComponent({
  name: 'SettingsRouteStub',
  render: () => null,
});
