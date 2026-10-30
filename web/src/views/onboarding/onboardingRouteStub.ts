import { defineComponent } from 'vue';

// Старый адрес обслуживает guard: мастер всегда открывается поверх рабочего раздела.
// Пустой render не создаёт отдельную страницу до готовности авторизации.
export default defineComponent({
  name: 'OnboardingRouteStub',
  render: () => null,
});
