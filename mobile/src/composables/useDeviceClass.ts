import { onScopeDispose } from 'vue';

/**
 * Класс устройства берётся по короткой стороне экрана, а не по размеру окна: клавиатура
 * сжимает окно планшета, и две колонки не должны схлопываться посреди набора текста.
 * Порог 600 — тот же, с которого Android сам считает устройство планшетом.
 */
export function useDeviceClass() {
  const apply = () => {
    const side = Math.min(window.screen?.width || 0, window.screen?.height || 0);

    document.documentElement.dataset.device = side >= 600 ? 'tablet' : 'phone';
  };

  apply();
  window.addEventListener('resize', apply);
  onScopeDispose(() => {
    window.removeEventListener('resize', apply);
  });
}
