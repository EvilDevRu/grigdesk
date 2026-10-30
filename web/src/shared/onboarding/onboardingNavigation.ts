import type { Router } from 'vue-router';

interface OnboardingOpenPort {
  requestOpen(mode: 'manual' | 'resume'): void;
}

/**
 * Прежний адрес открывает общий мастер поверх текущего раздела без отдельной страницы.
 * Начальная ссылка заменяется доской, а запрос открытия ждёт авторизации в host.
 */
export function installOnboardingRouteGuard(router: Router, store: OnboardingOpenPort): () => void {
  return router.beforeEach((to, from) => {
    if (to.name !== 'onboarding') {
      return true;
    }

    store.requestOpen(to.query.new === '1' ? 'manual' : 'resume');

    return from.matched.length === 0 ? { name: 'board', replace: true } : false;
  });
}
