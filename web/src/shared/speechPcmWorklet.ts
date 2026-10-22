// Микрофон отдаёт блоки 44,1/48 кГц; сервер принимает mono PCM16 16 кГц.
// Ресемплинг живёт в отдельном host AudioWorklet без DOM и Node.
interface WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

interface ProcessorOptions {
  processorOptions?: {
    targetSampleRate?: number;
    frameSamples?: number;
  };
}

declare class AudioWorkletProcessor {
  readonly port: WorkletPort;
}

declare const sampleRate: number;

declare function registerProcessor(
  name: string,
  processor: new (options?: ProcessorOptions) => AudioWorkletProcessor,
): void;

const PROCESSOR_NAME = 'grigdesk-speech-pcm16';
const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_FRAME_SAMPLES = 1600;

function pcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));

  return clamped < 0
    ? Math.round(clamped * 0x8000)
    : Math.round(clamped * 0x7fff);
}

class GrigDeskSpeechPcmProcessor extends AudioWorkletProcessor {
  targetRate: number;
  frameSamples: number;
  step: number;
  input = new Float32Array(0);
  sourcePosition = 0;
  frame: Int16Array<ArrayBuffer>;
  frameLength = 0;
  active = true;

  constructor(options: ProcessorOptions = {}) {
    super();

    const processorOptions = options.processorOptions || {};

    this.targetRate = Number(processorOptions.targetSampleRate) || DEFAULT_TARGET_RATE;
    this.frameSamples = Number(processorOptions.frameSamples) || DEFAULT_FRAME_SAMPLES;
    this.step = sampleRate / this.targetRate;
    this.frame = new Int16Array(this.frameSamples);
    this.port.onmessage = (event) => {
      const data = event?.data;

      if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'flush') {
        return;
      }

      this.active = false;
      this.#flushInput();
      this.#emitFrame();
      this.port.postMessage({ type: 'flushed' });
    };
  }

  /**
   * Накапливает непрерывный кадр с прежним преобразованием амплитуды.
   * Полный буфер передаётся host и сразу заменяется новым.
   */
  #pushSample(sample: number) {
    this.frame[this.frameLength] = pcm16(sample);
    this.frameLength += 1;

    if (this.frameLength === this.frame.length) {
      this.#emitFrame();
    }
  }

  /**
   * Передаёт только заполненную часть кадра, включая хвост при остановке.
   * Переданный ArrayBuffer больше не используется процессором.
   */
  #emitFrame() {
    if (!this.frameLength) {
      return;
    }

    const pcm = this.frameLength === this.frame.length
      ? this.frame
      : this.frame.slice(0, this.frameLength);

    this.port.postMessage({ type: 'pcm', pcm: pcm.buffer }, [pcm.buffer]);
    this.frame = new Int16Array(this.frameSamples);
    this.frameLength = 0;
  }

  /**
   * Сводит все входные каналы в один непрерывный буфер.
   * Граница render quantum не разрывает интерполяцию соседних samples.
   */
  #appendInput(channels: Float32Array[]) {
    const sampleCount = channels[0]?.length || 0;

    if (!sampleCount) {
      return;
    }

    const next = new Float32Array(this.input.length + sampleCount);

    next.set(this.input);

    const offset = this.input.length;

    for (let i = 0; i < sampleCount; i += 1) {
      let mixed = 0;

      for (const channel of channels) {
        mixed += channel[i] || 0;
      }

      next[offset + i] = mixed / channels.length;
    }

    this.input = next;
  }

  /**
   * Линейная интерполяция сохраняет последнюю точку для следующего quantum.
   * Число и порядок выдаваемых samples остаются независимыми от размера входных блоков.
   */
  #resampleAvailable() {
    while (this.sourcePosition + 1 < this.input.length) {
      const left = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - left;
      const sample = this.input[left]!
        + (this.input[left + 1]! - this.input[left]!) * fraction;

      this.#pushSample(sample);
      this.sourcePosition += this.step;
    }

    const consumed = Math.min(
      Math.floor(this.sourcePosition),
      Math.max(0, this.input.length - 1),
    );

    if (consumed > 0) {
      this.input = this.input.slice(consumed);
      this.sourcePosition -= consumed;
    }
  }

  /**
   * После stop следующего quantum нет: последний sample замыкает интерполяцию хвоста.
   * Буфер и позиция сбрасываются после его передачи без новых PCM-сообщений.
   */
  #flushInput() {
    if (!this.input.length) {
      return;
    }

    const extended = new Float32Array(this.input.length + 1);

    extended.set(this.input);
    extended[extended.length - 1] = this.input[this.input.length - 1]!;
    this.input = extended;
    this.#resampleAvailable();
    this.input = new Float32Array(0);
    this.sourcePosition = 0;
  }

  /**
   * Выход всегда немой: микрофон не возвращается в динамики пользователя.
   * После flush процессор остаётся живым, но больше не принимает PCM.
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const channel of outputs[0] || []) {
      channel.fill(0);
    }

    if (!this.active) {
      return true;
    }

    const channels = inputs[0] || [];

    if (!channels.length) {
      return true;
    }

    this.#appendInput(channels);
    this.#resampleAvailable();

    return true;
  }
}

registerProcessor(PROCESSOR_NAME, GrigDeskSpeechPcmProcessor);

export {};
