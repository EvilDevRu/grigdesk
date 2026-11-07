import { defineStore } from 'pinia';

export const useHelpStore = defineStore('help', {
  state: () => ({
    isOpen: false,
    articleId: 'overview',
    fragment: ''
  }),
  actions: {
    open(id = 'overview', fragment = ''): void {
      this.articleId = id;
      this.fragment = fragment;
      this.isOpen = true;
    },
    /**
     * Закрытие сбрасывает выбор прежней машины перед следующим входом.
     * Загрузчик отдельно отменяет поколение своих данных.
     */
    close(): void {
      this.isOpen = false;
      this.articleId = 'overview';
      this.fragment = '';
    },
  },
});
