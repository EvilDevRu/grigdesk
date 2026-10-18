// Микрофон браузера обычно работает с частотой 44,1/48 кГц и блоками по 128
// samples. Серверный streaming-контракт принимает непрерывный mono PCM16 16 кГц;
// ресемплинг выполняем здесь, вне main thread, и отдаём кадры примерно по 100 мс.
const PROCESSOR_NAME = 'grigdesk-speech-pcm16';
const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_FRAME_SAMPLES = 1600;

function pcm16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0
    ? Math.round(clamped * 0x8000)
    : Math.round(clamped * 0x7fff);
}

class GrigDeskSpeechPcmProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const processorOptions = options.processorOptions || {};
    this.targetRate = Number(processorOptions.targetSampleRate) || DEFAULT_TARGET_RATE;
    this.frameSamples = Number(processorOptions.frameSamples) || DEFAULT_FRAME_SAMPLES;
    this.step = sampleRate / this.targetRate;
    this.input = new Float32Array(0);
    this.sourcePosition = 0;
    this.frame = new Int16Array(this.frameSamples);
    this.frameLength = 0;
    this.active = true;
    this.port.onmessage = (event) => {
      if (event?.data?.type !== 'flush') return;
      this.active = false;
      this.#flushInput();
      this.#emitFrame();
      this.port.postMessage({ type: 'flushed' });
    };
  }

  #pushSample(sample) {
    this.frame[this.frameLength] = pcm16(sample);
    this.frameLength += 1;
    if (this.frameLength === this.frame.length) this.#emitFrame();
  }

  #emitFrame() {
    if (!this.frameLength) return;
    const pcm = this.frameLength === this.frame.length
      ? this.frame
      : this.frame.slice(0, this.frameLength);
    this.port.postMessage({ type: 'pcm', pcm: pcm.buffer }, [pcm.buffer]);
    this.frame = new Int16Array(this.frameSamples);
    this.frameLength = 0;
  }

  #appendInput(channels) {
    const sampleCount = channels[0]?.length || 0;
    if (!sampleCount) return;
    const next = new Float32Array(this.input.length + sampleCount);
    next.set(this.input);
    const offset = this.input.length;
    for (let i = 0; i < sampleCount; i += 1) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[i] || 0;
      next[offset + i] = mixed / channels.length;
    }
    this.input = next;
  }

  #resampleAvailable() {
    while (this.sourcePosition + 1 < this.input.length) {
      const left = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - left;
      const sample = this.input[left]
        + (this.input[left + 1] - this.input[left]) * fraction;
      this.#pushSample(sample);
      this.sourcePosition += this.step;
    }

    // Сохраняем последний sample: он нужен для линейной интерполяции с первым
    // sample следующего render quantum.
    const consumed = Math.min(
      Math.floor(this.sourcePosition),
      Math.max(0, this.input.length - 1),
    );
    if (consumed > 0) {
      this.input = this.input.slice(consumed);
      this.sourcePosition -= consumed;
    }
  }

  #flushInput() {
    if (!this.input.length) return;
    // На остановке следующего render quantum уже не будет. Повтор последнего
    // sample закрывает единственную недостающую точку интерполяции.
    const extended = new Float32Array(this.input.length + 1);
    extended.set(this.input);
    extended[extended.length - 1] = this.input[this.input.length - 1];
    this.input = extended;
    this.#resampleAvailable();
    this.input = new Float32Array(0);
    this.sourcePosition = 0;
  }

  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!this.active) return true;
    const channels = inputs[0] || [];
    if (!channels.length) return true;
    this.#appendInput(channels);
    this.#resampleAvailable();
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, GrigDeskSpeechPcmProcessor);
