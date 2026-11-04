export {};

declare global {
  interface Window {
    grigdeskBrowser?: {
      invoke(request: unknown): Promise<unknown>;
      hide(request: {
        operation: 'hide';
        instance: string;
        revision: number
      }): boolean;
      cover?(request: {
        operation: 'cover';
        instance: string;
        revision: number
      }): string | null;
      subscribe(callback: (value: unknown) => void): () => void;
      subscribeIntent(callback: (value: unknown) => void): () => void;
    };
  }
}
