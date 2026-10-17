// Черновики и подтверждение запуска принадлежат одному экземпляру формы создания.
// После диалога снова читается fingerprint; UUID кнопки передаётся без замены.
import type { Ref } from 'vue';
import { confirmDialog } from '../../ui.ts';
import type { useStudio3dStore } from '../../stores/studio3d.ts';
import type { parseStudio3d, Studio3dOffer, Studio3dQuote,
  Studio3dBatchQuote } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { FieldValues, UnitForms } from '../../../../shared/studio3d/studio3dOperations.ts';
import { pluralForm, formatPrice } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { StudioInput } from './studio3dApi.ts';
import { runRequest } from './creationRequest.ts';

type FormApi = Pick<ReturnType<typeof useStudio3dStore>, 'run' | 'batchRun'>;

interface CreationFormPorts {
  offer: Readonly<Ref<Studio3dOffer | undefined>>;
  disabledReason: Readonly<Ref<string>>;
  displayQuote: Readonly<Ref<Studio3dQuote | null>>;
  batch: Ref<boolean>;
  mode: Ref<string>;
  batchQuoted: Ref<Studio3dBatchQuote | null>;
  outputUnit: Readonly<Ref<UnitForms>>;
  values: Ref<FieldValues>;
  quoted: Ref<ReturnType<typeof parseStudio3d.quote> | null>;
  inputs: Readonly<Ref<NonNullable<StudioInput['uploads']>>>;
  name: Ref<string>;
  project: Ref<string>;
  category: Ref<string>;
  providerId: Ref<string>;
  selectedPreset: Ref<string>;
  presetHint: Ref<string>;
  formFingerprint(): string;
  isAlive(): boolean;
  isActive(): boolean;
  run: FormApi['run'];
  batchRun: FormApi['batchRun'];
  onTasks(): void;
  onCreated(modelId: string, versionId?: string): void;
}

/**
 * Узкие refs и callbacks сохраняют порядок подтверждения, POST и публичных событий.
 * Watch и lifecycle остаются у SFC, собственного состояния приложения здесь нет.
 */
export function useCreationForm(ports: CreationFormPorts) {
  const { offer, disabledReason, displayQuote, batch, mode, batchQuoted, outputUnit, values,
    quoted, inputs, name, project, category, providerId, selectedPreset, presetHint } = ports;
  const formFingerprint = ports.formFingerprint;
  const operationDrafts = new Map<string, FieldValues>();

  /**
   * Черновик каждого действия остаётся внутри экземпляра формы.
   * При первом входе переносится prompt, если новое действие объявляет такое поле.
   */
  function rememberDraft(key: string, previous: string | undefined): void {
    if (previous && previous !== 'undefined:undefined') {
      operationDrafts.set(previous, JSON.parse(JSON.stringify(values.value)) as FieldValues);
    }

    const prompt = values.value.prompt;
    const defaults = Object.fromEntries((offer.value?.fields ?? []).map((field) =>
      [field.id, JSON.parse(JSON.stringify(field.default ?? null))])) as FieldValues;

    values.value = operationDrafts.get(key) ?? { ...defaults,
      ...(prompt && 'prompt' in defaults ? { prompt } : {}) };
    providerId.value = offer.value?.provider ?? '';
    selectedPreset.value = '';
    presetHint.value = '';
  }

  /**
   * Batch подтверждает итог и отправляет один неизменный server snapshot.
   * Изменённая форма/marker после диалога требует нового подтверждения, без скрытого POST.
   */
  async function execute(key: string): Promise<unknown> {
    const selected = offer.value;
    
    if (!selected || disabledReason.value || !displayQuote.value || displayQuote.value.total === null) {
      throw new Error(disabledReason.value || 'Сначала проверьте цену.');
    }
    if (batch.value && mode.value === 'text') {
      const quoted = batchQuoted.value;
      
      if (!quoted) {
        throw new Error('Сначала рассчитайте пачку.');
      }
      
      const snapshot = JSON.parse(JSON.stringify(quoted.snapshot)) as typeof quoted.snapshot;
      const fingerprint = formFingerprint();
      const total = formatPrice(quoted.totalEstimated, quoted.unit);
      const modelWord = pluralForm(snapshot.rows.length, outputUnit.value);
      const confirmed = await confirmDialog(`Создать ${snapshot.rows.length} ${modelWord} — ${total}?`,
        { title: 'Подтвердить пачку', okText: 'Создать' });
      
      if (!confirmed) {
        return { cancelled: true };
      }
      if (!ports.isAlive() || !ports.isActive() || fingerprint !== formFingerprint()) {
        throw new Error('Форма изменилась. Рассчитайте пачку снова.');
      }
      
      const result = await ports.batchRun({ snapshot, snapshotHash: quoted.snapshotHash }, key);
      
      if (ports.isAlive() && ports.isActive() && fingerprint === formFingerprint()) {
        ports.onTasks();
      }
      
      return result;
    }
    
    const marker = formFingerprint();
    const result = await ports.run(runRequest({
      selected,
      values: values.value,
      normalizedValues: quoted.value?.validation.values,
      expectedPrice: displayQuote.value.total,
      uploads: inputs.value,
      name: name.value,
      project: project.value,
      category: category.value
    }), key);
    
    if (ports.isAlive() && ports.isActive() && marker === formFingerprint()
      && !('priceChanged' in result) && result.model) {
      ports.onCreated(result.model.id, result.versions[0]?.id);
    }
    
    return result;
  }

  return { rememberDraft, execute };
}
