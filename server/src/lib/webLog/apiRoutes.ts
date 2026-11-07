// Живой каталог шаблонов /api для журнала окна. Его наполняет хук onRoute
// самого Fastify, поэтому новый маршрут узнаётся без правки списков.

export type ApiRouteRegistry = {
  add(url: string): void;
  has(template: string): boolean;
  list(): string[];
};

/**
 * Реестр принимает только адреса /api. Журнал хранит найденный здесь шаблон,
 * а шаблон, которого сервер не регистрировал, приёмник заменит на `other`.
 */
export function createApiRouteRegistry(): ApiRouteRegistry {
  const templates = new Set<string>();

  return {
    add(url) {
      if (url === '/api' || url.startsWith('/api/')) {
        templates.add(url);
      }
    },
    has: (template) => templates.has(template),
    list: () => [...templates].sort(),
  };
}
