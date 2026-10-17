<template>
  <section ref="host" class="studio-viewer" :aria-label="name || 'Просмотр модели'">
    <div class="studio-view-tools" aria-label="Инструменты просмотра">
      <UiSegmentedControl v-model="mode" data-context="studio-view-mode" label="Отображение модели"
        :options="viewModes" @update:model-value="applyMode" />
      <div class="studio-view-actions">
        <UiIconButton label="Настройки вида" v-tooltip="'Фон, освещение и структура'"
          data-context="studio-view-tool"
          :pressed="optionsOpen" :aria-expanded="optionsOpen" :aria-controls="optionsId"
          @click="optionsOpen = !optionsOpen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h8m4 0h4M4 17h2m4 0h10" />
            <circle cx="14" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg>
        </UiIconButton>
        <UiIconButton label="Вписать модель" v-tooltip="'Вписать модель в окно'" data-context="studio-view-tool"
          :disabled="!info || loading" @click="fit">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" />
            <rect x="8" y="8" width="8" height="8" rx="1" /></svg>
        </UiIconButton>
        <UiIconButton label="Снимок" v-tooltip="'Сохранить текущий ракурс как превью'"
          data-context="studio-view-tool"
          :disabled="loading || !info || Boolean(error)" @click="snapshot">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6l2-2h4l2 2h4v14H4V6z" />
            <circle cx="12" cy="13" r="4" /></svg>
        </UiIconButton>
        <UiIconButton :label="fullscreenActive ? 'Выйти из полного экрана' : 'Во весь экран'"
          v-tooltip="fullscreenActive ? 'Выйти из полного экрана' : 'Во весь экран'"
          data-context="studio-view-tool" :pressed="fullscreenActive" @click="fullscreen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" /></svg>
        </UiIconButton>
      </div>
    </div>
    <div v-show="optionsOpen" :id="optionsId" class="studio-view-options">
      <UiField label="Фон"><UiSelect v-model="background" aria-label="Фон" @update:model-value="applyBackground">
        <option value="dark">Тёмный</option><option value="light">Светлый</option>
        <option value="checker">Клетка</option>
      </UiSelect></UiField>
      <UiField label="Освещение"><UiSelect v-model="light" aria-label="Свет" @update:model-value="applyLight">
        <option value="studio">Студийное</option><option value="flat">Ровное</option>
      </UiSelect></UiField>
      <div class="studio-view-structure">
        <UiCheckbox v-model="bones" data-context="studio-bones" @update:model-value="applyBones">
          Кости
        </UiCheckbox>
        <UiCheckbox v-model="parts" @update:model-value="applyParts">Разделить части цветом</UiCheckbox>
      </div>
    </div>
    <UiProgress v-if="loading" :value="progress.total ? progress.loaded / progress.total * 100 : 0"
      :indeterminate="!progress.total" label="Загрузка модели" />
    <p v-if="loading">Загрузка и разбор модели…</p>
    <UiInlineMessage v-if="error" tone="danger">Не удалось показать модель: {{ error }}.
      <UiActionLink :href="src" download>Скачать файл</UiActionLink>
    </UiInlineMessage>
    <UiInlineMessage v-if="compareError" tone="warning">
      Не удалось показать сравнение: {{ compareError }}.</UiInlineMessage>
    <p v-if="info?.splat">Ограниченный предпросмотр splat облаком точек; гауссианы не отрисовываются.</p>
    <UiInlineMessage v-if="viewError" tone="warning">{{ viewError }}</UiInlineMessage>
    <div class="studio-canvases" :class="{ 'studio-compare': compareSrc && !compareError }">
      <div class="studio-canvas-pane">
        <span v-if="compareSrc && !compareError" class="studio-canvas-label">Текущая версия</span>
        <canvas ref="primary" aria-label="Модель" />
      </div>
      <div v-if="compareSrc && !compareError" class="studio-canvas-pane">
        <span class="studio-canvas-label">Сравнение</span>
        <canvas ref="secondary" aria-label="Сравниваемая модель" />
      </div>
    </div>
    <div v-if="info?.clips.length" class="studio-animation">
      <div class="studio-animation-clip">
        <UiSelect v-model="clip" data-context="studio-clip" aria-label="Движение"
          @update:model-value="chooseClip">
          <option value="">Без движения</option><option v-for="item in info.clips" :key="item.name"
            :value="item.name">{{ item.name }}</option>
        </UiSelect>
      </div>
      <UiIconButton :label="playing ? 'Пауза' : 'Пуск'" v-tooltip="playing ? 'Пауза' : 'Пуск'"
        data-context="studio-view-tool" :disabled="!clip" @click="playPause">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path :d="playing ? 'M8 5v14M16 5v14' : 'M7 4l14 8-14 8z'" />
        </svg>
      </UiIconButton>
      <UiRange :model-value="time" :min="0" :max="duration" :step="0.01" :disabled="!clip"
        class="studio-animation-time" aria-label="Время движения"
        @update:model-value="seek" />
      <span>{{ time.toFixed(1) }} / {{ duration.toFixed(1) }} с</span>
      <div class="studio-animation-speed">
        <UiSelect v-model="speed" data-context="studio-speed" aria-label="Скорость движения"
          @update:model-value="applySpeed">
          <option value="0.5">0,5×</option><option value="1">1×</option>
          <option value="1.5">1,5×</option><option value="2">2×</option>
        </UiSelect>
      </div>
    </div>
    <footer class="studio-view-status">
      <div class="studio-view-stats">
        <span class="studio-view-format">{{ ext.toUpperCase() }}</span>
        <span v-if="typeof info?.stats.triangles === 'number'">
          {{ info.stats.triangles.toLocaleString('ru-RU') }} треуг.
        </span>
        <span v-if="info?.stats.bones">Кости: {{ info.stats.bones }}</span>
        <span v-if="info?.clips.length">Движения: {{ info.clips.length }}</span>
      </div>
      <span class="studio-view-help">Вращение — перетаскивание · Масштаб — прокрутка</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch, onMounted, onUnmounted, nextTick, useId } from 'vue';
import { UiSegmentedControl, UiCheckbox, UiSelect, UiIconButton, UiField, UiRange, UiProgress,
  UiInlineMessage, UiActionLink, vTooltip } from '../../ui.ts';
import { loadEngine } from './viewerEngine.ts';
import type { ViewerEngine, ViewerInfo, CameraState } from './viewerEngine.ts';
import { studioErrorMessage } from '../../features/studio3d/presentation.ts';

const props = withDefaults(defineProps<{
  src: string;
  ext: string;
  name?: string;
  compareSrc?: string;
  compareExt?: string;
  autoSnapshot?: boolean
}>(),
  {
    name: '',
    compareSrc: '',
    compareExt: '',
    autoSnapshot: false
  });
const emit = defineEmits<{
  snapshot: [blob: Blob];
  loaded: [info: ViewerInfo];
  error: [message: string]
}>();

const host = ref<HTMLElement | null>(null);
const primary = ref<HTMLCanvasElement | null>(null);
const secondary = ref<HTMLCanvasElement | null>(null);
const info = shallowRef<ViewerInfo | null>(null);
const loading = ref(false);
const error = ref('');
const compareError = ref('');
const viewError = ref('');
const optionsOpen = ref(false);
const optionsId = `studio-view-options-${useId()}`;
const fullscreenActive = ref(false);
const viewModes = [
  { value: 'texture', label: 'Текстуры' },
  { value: 'clay', label: 'Глина' },
  { value: 'wire', label: 'Сетка' }
];
const progress = ref<{ loaded: number; total: number | null }>({ loaded: 0, total: null });
const mode = ref<'texture' | 'clay' | 'wire'>('texture');
const bones = ref(false);
const parts = ref(false);
const background = ref<'dark' | 'light' | 'checker'>('dark');
const light = ref<'studio' | 'flat'>('studio');
const clip = ref('');
const playing = ref(false);
const time = ref(0);
const speed = ref('1');
const duration = computed(() => info.value?.clips.find((item) => item.name === clip.value)?.duration || 0);
let engines: (ViewerEngine | null)[] = [];
let stops: (() => void)[] = [];
let generation = 0;
let alive = true;
let intersecting = true;
let resizeObserver: ResizeObserver | null = null;
let intersectionObserver: IntersectionObserver | null = null;

const each = (action: (engine: ViewerEngine) => void) => engines.forEach((engine) => { if (engine) {
  action(engine);
} });
const applyMode = () => each((engine) => engine.setMode(mode.value));
const applyBones = () => each((engine) => engine.showBones(bones.value));
const applyParts = () => each((engine) => engine.showParts(parts.value));
const applyBackground = () => each((engine) => engine.setBackground(background.value));
const applyLight = () => each((engine) => engine.setLight(light.value));
const applySpeed = () => each((engine) => engine.setSpeed(Number(speed.value)));
const fit = () => each((engine) => engine.fitView());
const visibility = () => each((engine) => engine.setVisible(intersecting && !document.hidden));

/**
 * Canvas сохраняет renderer при смене src, а лишняя compare панель освобождается сразу.
 * Loader generation скрывает поздние ответы; callbacks и camera sync не накапливаются.
 */
async function reload(): Promise<void> {
  const current = ++generation;
  
  stops.forEach((stop) => stop());
  stops = [];
  loading.value = true;
  error.value = '';
  compareError.value = '';
  info.value = null;
  clip.value = '';
  playing.value = false;
  time.value = 0;
  progress.value = { loaded: 0, total: null };
  
  try {
    await nextTick();
    
    const create = await loadEngine();
    
    if (!alive || current !== generation || !primary.value) {
      return;
    }
    
    const options = {
      onError: (message: string) => { if (alive) {
        fail(message);
      } },
      onProgress: (loaded: number, total: number | null) => {
        if (alive) {
          progress.value = { loaded, total };
        }
      },
    };
    
    if (!engines[0]) {
      engines[0] = create(primary.value, options);
    }
    if (props.compareSrc && secondary.value && !engines[1]) {
      engines[1] = create(secondary.value, {
        ...options,
        onError: (message) => {
          if (alive) {
            failComparison(message);
          }
        }
      });
    }
    if (!props.compareSrc && engines[1]) {
      engines[1].dispose();
      engines[1] = null;
    }
    
    let camera: CameraState | null = null;
    
    stops.push(engines[0].onCameraChange((state) => {
      camera = state;
      engines[1]?.syncCamera(state);
    }));
    
    if (engines[1]) {
      stops.push(engines[1].onCameraChange((state) => engines[0]?.syncCamera(state)));
    }
    
    stops.push(engines[0].onTimeChange((value) => { if (alive && current === generation) {
      time.value = value;
    } }));
    each((engine) => engine.resize());
    visibility();
    
    const comparison = engines[1]?.load(props.compareSrc, props.compareExt || props.ext).catch((cause) => {
      if (alive && current === generation) {
        failComparison(studioErrorMessage(cause));
      }
    });
    const [loaded] = await Promise.all([engines[0].load(props.src, props.ext), comparison]);
    
    if (!alive || current !== generation) {
      return;
    }
    
    info.value = loaded;
    
    if (camera && engines[1]) {
      engines[1].syncCamera(camera);
    }
    
    applyMode(); applyBones(); applyParts(); applyBackground(); applyLight(); applySpeed();
    loading.value = false;
    emit('loaded', loaded);
    
    if (props.autoSnapshot) {
      await snapshot();
    }
  } catch (cause) {
    if (alive && current === generation) {
      fail(studioErrorMessage(cause));
      each((engine) => engine.dispose());
      engines = [];
    }
  } finally { if (alive && current === generation) {
    loading.value = false;
  } }
}

/**
 * Отказ второго холста освобождает только его движок и оставляет основную модель доступной.
 * Сообщение не блокирует снимок, а новое сравнение создаст второй холст заново.
 */
function failComparison(message: string): void {
  compareError.value = message;
  engines[1]?.dispose();
  engines[1] = null;
}

/**
 * Ошибка рендера отображается обычным текстом, не оставляет spinner или тайный retry.
 * Родитель получает сообщение, но не новую оплату или изменение библиотеки.
 */
function fail(message: string): void {
  error.value = message;
  loading.value = false;
  emit('error', message);
}

/**
 * Выбранный клип проигрывается настоящим mixer; null ставит текущую позу на паузу.
 * Имя и скорость передаются обеим панелям через публичный порт.
 */
function chooseClip(): void {
  playing.value = Boolean(clip.value);
  each((engine) => engine.playClip(clip.value || null));
}

/**
 * Пуск продолжает выбранный клип, пауза сохраняет время и текущую позу.
 * Кнопка без клипа не создаёт искусственную анимацию вращения камеры.
 */
function playPause(): void {
  playing.value = !playing.value;
  each((engine) => engine.playClip(playing.value ? clip.value : null));
}

/**
 * Ползунок меняет секунды клипа, а не прогресс сети или фиктивный кадр.
 * Порт сам ограничивает время длительностью выбранной анимации.
 */
function seek(value: number): void {
  time.value = value;
  each((engine) => engine.setTime(value));
}

/**
 * Снимок отправляется только если src и поколение сохранились до конца canvas.toBlob.
 * Compare никогда не подменяет источник preview выбранной основной панели.
 */
async function snapshot(): Promise<void> {
  const current = generation;
  const source = props.src;
  const engine = engines[0];
  
  if (!engine || !info.value || loading.value) {
    return;
  }
  
  try {
    const blob = await engine.snapshot();
    
    if (alive && current === generation && props.src === source) {
      emit('snapshot', blob);
    }
  } catch (cause) {
    if (alive && current === generation) {
      fail(studioErrorMessage(cause));
    }
  }
}

/**
 * Fullscreen использует браузерный контракт с штатным Escape и не заводит новый overlay stack.
 * Размонтирование выходит только из fullscreen собственного элемента.
 */
async function fullscreen(): Promise<void> {
  viewError.value = '';

  try {
    if (document.fullscreenElement === host.value) {
      await document.exitFullscreen();
    } else {
      await host.value?.requestFullscreen();
    }
  }
  catch (cause) {
    viewError.value = `Полноэкранный режим недоступен: ${studioErrorMessage(cause)}`;
  }
}

function syncFullscreen(): void {
  fullscreenActive.value = document.fullscreenElement === host.value;
}

watch(() => [props.src, props.ext, props.compareSrc, props.compareExt], () => {
  void reload();
}, { flush: 'post' });
onMounted(() => {
  resizeObserver = new ResizeObserver(() => each((engine) => engine.resize()));
  
  if (host.value) {
    resizeObserver.observe(host.value);
  }
  if (primary.value) {
    resizeObserver.observe(primary.value);
  }
  if (typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver((entries) => {
      intersecting = Boolean(entries[0]?.isIntersecting);
      visibility();
    });
    
    if (host.value) {
      intersectionObserver.observe(host.value);
    }
  }
  
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('fullscreenchange', syncFullscreen);
  void reload();
});
onUnmounted(() => {
  alive = false;
  generation += 1;
  stops.forEach((stop) => stop());
  stops = [];
  resizeObserver?.disconnect();
  intersectionObserver?.disconnect();
  document.removeEventListener('visibilitychange', visibility);
  document.removeEventListener('fullscreenchange', syncFullscreen);
  each((engine) => engine.dispose());
  engines = [];
  
  if (document.fullscreenElement === host.value) {
    void document.exitFullscreen().catch(() => {});
  }
});
</script>

<style scoped>
.studio-viewer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 320px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--sidebar);
  container: studio-viewer / inline-size;
}

.studio-view-tools,
.studio-animation {
  display: flex;
  flex: none;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
}

.studio-view-tools {
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
}

.studio-view-actions,
.studio-view-structure,
.studio-view-stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.studio-view-actions {
  margin-left: auto;
}

.studio-view-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}

.studio-view-structure {
  grid-column: 1 / -1;
  gap: 8px 20px;
}

.studio-canvases {
  display: grid;
  min-height: 280px;
  height: clamp(280px, 53vh, 680px);
  min-width: 0;
}

.studio-canvases.studio-compare {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.studio-canvas-pane {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.studio-canvas-pane + .studio-canvas-pane {
  border-left: 1px solid var(--line);
}

.studio-canvas-label {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 1;
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--sidebar);
  color: var(--ink-mid);
  font-size: 11px;
  pointer-events: none;
}

.studio-canvases canvas {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.studio-viewer:fullscreen {
  height: 100%;
  border: 0;
  border-radius: 0;
}

.studio-viewer:fullscreen .studio-canvases {
  flex: 1;
  min-height: 0;
  height: auto;
}

.studio-animation {
  border-top: 1px solid var(--line);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.studio-animation-clip {
  flex: 0 1 140px;
  min-width: 0;
}

.studio-animation-speed {
  flex: 0 0 64px;
}

.studio-animation-time {
  flex: 1;
  min-width: 70px;
}

.studio-view-status {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 16px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.5;
}

.studio-view-stats {
  gap: 6px 12px;
  font-variant-numeric: tabular-nums;
}

.studio-view-format {
  color: var(--ink);
  font-weight: 600;
}

@container studio-viewer (max-width: 419px) {
  .studio-animation-clip {
    flex: 1 1 calc(100% - 42px);
  }

  .studio-view-help {
    display: none;
  }
}
</style>
