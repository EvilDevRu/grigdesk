// Предложения и расчёт текущей формы используют общие refs и отдельные поколения.
// Модуль не регистрирует watch и не добавляет debounce поверх одиночного store.quote.
import type { Ref } from 'vue';
import type { parseStudio3d, Studio3dOffer, Studio3dBatchQuote,
  Studio3dQuote } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { StudioInput } from './studio3dApi.ts';
import type { batchRows } from './creationRequest.ts';
import { studioErrorMessage } from './presentation.ts';

type Quoted = ReturnType<typeof parseStudio3d.quote>;
type QuoteInput = StudioInput & {
  provider: string;
  operation: string;
  values: FieldValues;
};

interface CreationQuotePorts {
  creationOffers: Ref<Studio3dOffer[]>;
  quoted: Ref<Quoted | null>;
  batchQuoted: Ref<Studio3dBatchQuote | null>;
  changedPrice: Ref<boolean>;
  error: Ref<string>;
  offer: Readonly<Ref<Studio3dOffer | undefined>>;
  mode: Ref<string>;
  batch: Ref<boolean>;
  values: Ref<FieldValues>;
  inputs(): NonNullable<StudioInput['uploads']>;
  lines(): string[];
  batchRows(): ReturnType<typeof batchRows>;
  isAlive(): boolean;
  isActive(): boolean;
  libraryId(): string;
  loadOffers(input: StudioInput): Promise<ReturnType<typeof parseStudio3d.offers> | null>;
  quote(input: QuoteInput): Promise<Quoted | null>;
  batchQuote(rows: ReturnType<typeof batchRows>): Promise<Studio3dBatchQuote>;
}

/**
 * Сохраняет владение refs в SFC, а поколения и таймер — внутри одного экземпляра формы.
 * Освобождение вызывается SFC после очистки inputs в прежнем порядке.
 */
export function useCreationQuote(ports: CreationQuotePorts) {
  const { creationOffers, quoted, batchQuoted, changedPrice, error, offer, mode, batch, values } = ports;
  let offersGeneration = 0;
  let quoteGeneration = 0;
  let quoteTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Предложения публикуются только для текущей активной формы и библиотеки.
   * Поколение отсекает ответ предыдущего входа без нового канала подписки.
   */
  async function refreshOffers(): Promise<void> {
    const current = ++offersGeneration;

    if (ports.isActive() && ports.libraryId()) {
      const result = await ports.loadOffers({ uploads: ports.inputs() });

      if (ports.isAlive() && ports.isActive() && current === offersGeneration 
        && result?.libraryId === ports.libraryId()) {
        creationOffers.value = result.offers;
      }
    }
  }

  /**
   * Изменение формы немедленно отзывает прежнюю цену и поколение расчёта.
   * Отдельные 300 мс принадлежат только batchQuote; ports.quote уже имеет debounce.
   */
  function refreshQuote(): void {
    changedPrice.value = false;
    
    const current = ++quoteGeneration;
    
    batchQuoted.value = null;
    quoted.value = null;
    
    if (quoteTimer) {
      clearTimeout(quoteTimer);
    }
    
    const selected = offer.value;
    
    if (!ports.isActive() || !selected || mode.value === 'file') {
      return;
    }
    if (batch.value && mode.value === 'text') {
      if (!ports.lines().length || ports.lines().length > 50 || selected.quote.total === null) {
        return;
      }
      
      const rows = ports.batchRows();
      
      quoteTimer = setTimeout(() => {
        quoteTimer = null;
        void ports.batchQuote(rows).then((result) => {
          if (ports.isAlive() && current === quoteGeneration && result.libraryId === ports.libraryId()) {
            batchQuoted.value = result;
          }
        }).catch((cause) => { if (current === quoteGeneration) {
          error.value = studioErrorMessage(cause);
        } });
      }, 300);
    } else {
      void ports.quote({
        provider: selected.provider,
        operation: selected.operation,
        values: values.value,
        uploads: ports.inputs()
      }).then((result) => {
        if (ports.isAlive() && ports.isActive() && current === quoteGeneration 
        && result?.libraryId === ports.libraryId()) {
          quoted.value = result;
        }
      });
    }
  }

  /**
   * Price changed показывает новый расчёт, но не отправляет вторую оплату автоматически.
   * UUID следующего нажатия принадлежит новому подтверждённому снимку цены.
   */
  function priceChanged(quote: Studio3dQuote): void {
    changedPrice.value = true;
    
    if (quoted.value) {
      quoted.value = { ...quoted.value, quote };
    }
    if (batch.value) {
      batchQuoted.value = null;
    }
  }

  /**
   * Освобождение отзывает оба поколения перед очисткой таймера пачки.
   * Поздние ответы не могут вернуть цену размонтированной формы.
   */
  function dispose(): void {
    offersGeneration += 1;
    quoteGeneration += 1;

    if (quoteTimer) {
      clearTimeout(quoteTimer);
    }
  }

  return {
    refreshOffers,
    refreshQuote,
    priceChanged,
    dispose
  };
}
