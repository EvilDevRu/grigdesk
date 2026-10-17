// Контракт базы агентов: карточка роли конвейера.
//
// Агент здесь — не запускаемая сущность, а описание этапа: как он подписан на схеме,
// какого класса модель ему рекомендуется и с чего начинается его задание. Файлы базы
// пишут люди и правят руками, поэтому перечислениями закрыто только то, что реально
// управляет показом, а свободные поля остаются текстом.

import { contractDecoders } from '../lib/contractDecoders.ts';

export class AgentsContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ базы агентов: поле ${path}`);
    this.name = 'AgentsContractError';
  }
}

const {
  boolean,
  listOf,
  numeric,
  objectOf,
  optional,
  text,
} = contractDecoders((path) => {
  throw new AgentsContractError(path);
});

// Карточка агента. `kind` НЕ перечисление: сервер принимает любой род из файла, а
// незнакомый род должен доехать до экрана как есть — иначе рукописная карточка
// исчезнет из списка молча, и человек не поймёт, куда делся его агент.
const agentCard = objectOf({
  id: text,
  kind: text,
  label: text,
  sub: text,
  key: text,
  tier: text,
  effort: text,
  timeout: numeric,
  budget: numeric,
  readonly: boolean,
  optional: boolean,
  prompt: text,
});

const agentList = objectOf({ agents: listOf(agentCard) });

// Итог доустановки стандартного набора. Пустой `created` — не отказ: это «всё уже есть».
const installResult = objectOf({
  ok: boolean,
  created: optional(listOf(text)),
  skipped: optional(listOf(text)),
});

export type AgentCard = ReturnType<typeof agentCard>;
export type AgentInstallResult = ReturnType<typeof installResult>;

// Что уходит НА сервер при сохранении. `id` в теле читает только создание: у правки
// он берётся из адреса, и присланный второй раз он ничего не меняет.
export type AgentDraft = Omit<AgentCard, 'id'> & { id: string };

export function parseAgentList(value: unknown): AgentCard[] {
  return agentList(value, 'agents').agents;
}

export function parseAgentCard(value: unknown): AgentCard {
  return agentCard(value, 'agent');
}

export function parseAgentInstallResult(value: unknown): AgentInstallResult {
  return installResult(value, 'agentsInstall');
}
