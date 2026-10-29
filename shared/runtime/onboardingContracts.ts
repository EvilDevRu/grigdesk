import { contractDecoders } from '../lib/contractDecoders.ts';
import { PROJECT_ID_RE, PROJECT_LIMITS, REPO_KEY_RE } from './projectsContracts.ts';
import type { ProjectInput } from './projectsContracts.ts';

export class OnboardingError extends Error {
  status: number;
  code: string;

  constructor(code = 'invalid_state', status = 400) {
    super('Не удалось обработать состояние мастера');
    this.code = code;
    this.status = status;
  }
}

const {
  objectOf, text, nullable, oneOf, boolean, wholeNumber, listOf, mapOf,
} = contractDecoders(() => {
  throw new OnboardingError();
});

const repository = objectOf({
  name: text,
  source: text,
  baseBranch: nullable(text),
});
const workspace = objectOf({ mode: oneOf('isolated', 'shared') });
const draft = objectOf({
  title: text,
  repositories: listOf(repository),
  workspace,
});
const intent = objectOf({
  id: text,
  title: text,
  description: text,
  tags: listOf(text),
  repos: listOf(objectOf({ key: text, dir: text })),
  defaultRepoKey: nullable(text),
});
const session = objectOf({
  id: text,
  origin: oneOf('auto', 'manual'),
  projectId: text,
  status: oneOf('active', 'completed', 'dismissed'),
  step: oneOf('ai', 'project', 'workspace', 'summary'),
  aiSkipped: boolean,
  projectSaved: boolean,
  projectRevision: nullable(wholeNumber),
  projectIntent: nullable(intent),
  draft,
});
const answers = objectOf({
  projectId: text,
  projectRevision: wholeNumber,
  repositories: listOf(repository),
  workspace,
  aiSkipped: boolean,
  complete: boolean,
});
const document = objectOf({
  schemaVersion: oneOf(1),
  revision: wholeNumber,
  autoOpenDisabled: boolean,
  active: nullable(session),
  answersByProject: mapOf(answers),
});

export type OnboardingDraft = ReturnType<typeof draft>;
export type OnboardingSession = Omit<ReturnType<typeof session>, 'projectIntent'> & {
  projectIntent: ProjectInput | null;
};
export type OnboardingDocument = Omit<ReturnType<typeof document>, 'active'> & {
  active: OnboardingSession | null;
};
export type OnboardingState = OnboardingDocument & { shouldOpen: boolean; open?: boolean };
export interface RepositoryInspection {
  state: string;
  currentBranch: string | null;
  branches: { name: string; compatible: boolean }[];
  reason: string | null;
}

/**
 * Черновик допускает незавершённые ответы, но сохраняет границы паспорта и образца.
 * Проверка Git и обязательности полей выполняется сервером при переходе дальше.
 */
export function decodeOnboardingDraft(value: unknown): OnboardingDraft {
  const result = draft(value, 'draft');

  if (result.title.length > PROJECT_LIMITS.title || result.repositories.length < 1
    || result.repositories.length > 16) {
    throw new OnboardingError('invalid_draft');
  }

  const names = new Set<string>();

  for (const repo of result.repositories) {
    if (!REPO_KEY_RE.test(repo.name) || names.has(repo.name)
      || repo.source.length > PROJECT_LIMITS.dir || repo.source.includes('\0')
      || (repo.baseBranch !== null && repo.baseBranch.length > 80)) {
      throw new OnboardingError('invalid_draft');
    }

    names.add(repo.name);
  }

  return result;
}

/**
 * Читатель диска и клиент проверяют один контракт, включая происхождение прохода.
 * Повреждённое состояние нельзя принять за отсутствие первоначальной настройки.
 */
export function decodeOnboardingDocument(value: unknown): OnboardingDocument {
  const result = document(value, 'onboarding');

  if (result.active) {
    if (!PROJECT_ID_RE.test(result.active.projectId) || !result.active.id) {
      throw new OnboardingError();
    }

    decodeOnboardingDraft(result.active.draft);
  }

  return result;
}

/**
 * Сетевой снимок содержит явный допуск сервера, а не вывод клиента по наличию session.
 * Старый сервер без контракта не должен автоматически открывать мастер.
 */
export function decodeOnboardingState(value: unknown): OnboardingState {
  const flags = objectOf({ shouldOpen: boolean })(value, 'onboarding');

  return { ...decodeOnboardingDocument(value), ...flags };
}
