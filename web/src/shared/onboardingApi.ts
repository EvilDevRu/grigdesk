import { api } from './apiClient.ts';
import { contractDecoders } from '../../../shared/lib/contractDecoders.ts';
import { decodeOnboardingState, OnboardingError } from '../../../shared/runtime/onboardingContracts.ts';
import type { OnboardingState, RepositoryInspection } from '../../../shared/runtime/onboardingContracts.ts';

const { objectOf, text, nullable, listOf, boolean } = contractDecoders(() => {
  throw new OnboardingError();
});
const inspection = objectOf({
  state: text,
  currentBranch: nullable(text),
  branches: listOf(objectOf({ name: text, compatible: boolean })),
  reason: nullable(text),
});

/**
 * Сетевые ответы проходят общий decoder до попадания в реактивное состояние.
 * Этот API пользуется обычным транспортом вкладки и не открывает собственную SSE.
 */
export async function readOnboarding(): Promise<OnboardingState> {
  return decodeOnboardingState(await api.get('/api/onboarding'));
}

/**
 * Мутации подтверждаются полным серверным снимком с новой ревизией.
 * Клиент не вычисляет шаг самостоятельно, даже если запись уже отправлена.
 */
export async function writeOnboarding(
  suffix: string,
  body: unknown,
  patch = false,
): Promise<OnboardingState & { open?: boolean }> {
  const raw = patch ? await api.patch('/api/onboarding', body)
    : await api.post(`/api/onboarding${suffix}`, body);
  const state = decodeOnboardingState(raw);

  if (suffix === '/start') {
    const flags = objectOf({ open: boolean })(raw, 'start');

    return { ...state, ...flags };
  }

  return state;
}

/**
 * Проверка пути ничего не записывает и возвращает только состояние Git и локальные refs.
 * Выбор папки ОС остаётся отдельной возможностью локальной оболочки.
 */
export async function inspectOnboardingRepository(dir: string): Promise<RepositoryInspection> {
  return inspection(await api.post('/api/onboarding/repository', { dir }), 'repository');
}
