<template>
  <div class="video">
    <header class="video-hero" :class="{ compact: job?.status === 'done' }">
      <div class="hero-copy">
        <p class="eyebrow">Разбор встреч</p>
        <h2 class="ttl">Видео → задачи</h2>
        <p class="lead">
          Загрузи запись — Cockpit расшифрует разговор, выделит договорённости
          и подготовит черновики для Битрикс24.
        </p>
      </div>
      <div class="hero-route" aria-hidden="true">
        <span class="route-node active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 8l6-4v16l-6-4V8z M3 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
          </svg>
        </span>
        <i></i>
        <span class="route-node">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 5h16 M4 10h10 M4 15h16 M4 20h8" />
          </svg>
        </span>
        <i></i>
        <span class="route-node good">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </span>
      </div>
    </header>

    <div v-if="pluginOff" class="empty-state">
      <span class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3v4 M16 3v4 M5 7h14v4a7 7 0 0 1-14 0z M12 18v3" />
        </svg>
      </span>
      <div>
        <h3>Плагин выключен</h3>
        <p>Включи «Видео → задачи» в разделе «Настройки → Плагины», чтобы снова разбирать записи.</p>
      </div>
    </div>
    <template v-else>
      <div v-if="doctorOk === false" class="notice danger">
        <span class="notice-icon" aria-hidden="true">!</span>
        <div>
          <b>Медиа-конвейер не готов</b>
          <p>Проверь окружение сервера: для разбора нужны ffmpeg, venv и whisper.</p>
        </div>
      </div>

      <section class="upload-card" :class="{ busy: uploading || job?.status === 'running', compact: job?.status === 'done' }">
        <!-- multiple: инструменты записи режут длинный созвон на файлы, и встреча
             законно лежит в нескольких частях. Выбранные склеиваются в одну встречу
             по времени файла — порядок каталога у браузера произвольный. -->
        <UiFilePicker
          accept="video/*,audio/*"
          multiple
          presentation="dropzone"
          :density="job?.status === 'done' ? 'compact' : 'default'"
          :disabled="Boolean(job && job.status === 'running')"
          :busy="uploading"
          :show-summary="false"
          :show-reset="false"
          @change="onFiles"
        >
          <template #leading>
            <span class="upload-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 16V4 M8 8l4-4 4 4 M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
              </svg>
            </span>
          </template>
          {{ uploading
            ? 'Загружаю запись…'
            : job?.status === 'done'
              ? 'Разобрать другую запись'
              : 'Выбрать видео или аудио' }}
          <template #hint>
            <template v-if="job?.status !== 'done'">
              Сама запись останется в Cockpit — на портал уйдут только подтверждённые задачи и их кадры
            </template>
            <template v-else>
              Текущий разбор останется на экране до выбора нового файла
            </template>
          </template>
          <template #trailing>
            <span class="upload-action">{{ uploading ? 'Подожди' : 'Выбрать файл' }}</span>
          </template>
        </UiFilePicker>
      </section>

      <div v-if="error" class="notice danger err">
        <span class="notice-icon" aria-hidden="true">!</span>
        <p>{{ error }}</p>
      </div>

      <!-- Прогресс распознавания -->
      <section v-if="job && job.status === 'running'" class="progress">
        <div class="progress-head">
          <span class="progress-mark"><UiSpinner decorative /></span>
          <div>
            <b>Распознаю речь</b>
            <p>Разбиваю запись на реплики и восстанавливаю таймкоды.</p>
          </div>
          <span v-if="job.progress" class="mono progress-count">{{ job.progress.done }}/{{ job.progress.total }}</span>
        </div>
        <div class="pbar"><span :style="{ width: job.progress ? (job.progress.done / job.progress.total * 100) + '%' : '10%' }"></span></div>
      </section>

      <div v-if="job && job.status === 'done'" class="result">
      <!-- Что именно разобрано. Строка обязательна: файлы записи называются почти
           одинаково и лежат рядом, а без имени, размера и длительности на экране
           «я выбирал другой» и «раздел обрезал» неотличимы. Живой случай: инструмент
           разбил встречу на два файла (17:04 и 1:18), уехал второй. -->
        <section class="meeting-summary">
          <div class="meeting-file">
            <span class="meeting-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12l4 4L19 6" />
              </svg>
            </span>
            <div>
              <span class="summary-kicker">Распознавание завершено</span>
              <p class="filenote">
                <template v-if="parts.length > 1">Разобрано частей: <b>{{ parts.length }}</b></template><!--
                --><template v-else>Разобран файл<template v-if="uploaded">:&nbsp;<b>{{ uploaded.name }}</b></template><!--
                --><template v-if="uploaded && mb(uploaded.size)"> · {{ mb(uploaded.size) }}</template></template><!--
                --><template v-if="mediaDuration"> · запись {{ mmss(mediaDuration) }}</template><!--
                --><template v-if="segments.length"> · {{ segments.length }} реплик</template>
              </p>
              <!-- Части перечислены поимённо и по порядку: склейка меняет таймкоды,
                   и человек должен видеть, что и в каком порядке в неё вошло. -->
              <ul v-if="parts.length > 1" class="partlist">
                <li v-for="(p, i) in parts" :key="p.jobId || i">
                  <span class="mono">{{ i + 1 }}.</span> {{ p.name }}
                  <span v-if="p.job?.result?.duration" class="muted">· {{ mmss(p.job.result.duration) }}</span>
                </li>
              </ul>
            </div>
          </div>
          <div class="summary-metrics">
            <span v-if="mediaDuration"><b class="mono">{{ mmss(mediaDuration) }}</b><small>запись</small></span>
            <span><b>{{ segments.length }}</b><small>реплик</small></span>
            <span><b>{{ drafts.length }}</b><small>черновиков</small></span>
          </div>
        </section>

      <!-- Черновики задач -->
      <section class="drafts">
        <div class="dhead">
          <div class="section-title">
            <span class="section-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </span>
            <div>
              <p class="section-kicker">Шаг 2</p>
              <h3 class="h">Проверь задачи <span class="count-pill">{{ drafts.length }}</span></h3>
            </div>
          </div>
          <UiButton class="btn icon-btn" @click="addDraft">
            + ещё задача
          </UiButton>
        </div>

        <!-- Разбор моделью -->
        <div class="plan">
          <div class="plan-head">
            <span class="plan-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1 M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" />
              </svg>
            </span>
            <div>
              <b>Авторазбор встречи</b>
              <small v-if="planModel">{{ planModel.model || planModel }}</small>
              <small v-else>Модель пока не выбрана</small>
            </div>
          </div>
          <template v-if="planModel">
            <div class="planrow">
              <UiInput
                v-model="planHint"
                class="hint"
                placeholder="Что учесть при разборе (необязательно)"
                :disabled="planning"
              />
              <UiButton
                class="btn analyze"
                variant="solid"
                tone="accent"
                :disabled="planning"
                :loading="planning"
                loading-label="Разбираю встречу на задачи"
                @click="planTasks"
              >
                <template #leading>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3v3 M12 18v3 M3 12h3 M18 12h3 M7 7l2 2 M15 15l2 2 M17 7l-2 2 M9 15l-2 2" />
                  </svg>
                </template>
                {{ planning ? 'Разбираю…' : 'Разобрать на задачи' }}
              </UiButton>
            </div>
            <p class="muted note">Модель прочитает расшифровку и предложит черновики. Проверь их: формулировку собрала она, а ставишь задачи ты.</p>
          </template>
          <p v-else class="muted note">
            Автоматический разбор выключен: модель не выбрана в «Настройки → Плагины → Видео&nbsp;→&nbsp;задачи».
            Задачи можно собрать вручную — клик по реплике добавляет её в последний черновик.
          </p>
          <p v-if="planError" class="err note">{{ planError }}</p>
          <p v-if="planInfo" class="muted note">
            <template v-if="planInfo.count">Модель {{ planInfo.model }} предложила задач: {{ planInfo.count }}.</template>
            <template v-else>Модель {{ planInfo.model }} не нашла задач в этой встрече.</template>
            <template v-if="planInfo.truncated"> Прочитаны первые {{ planInfo.shown }} реплик — остальное разбери сам.</template>
          </p>
        </div>

        <!-- Кому и куда: общий выбор на всю встречу -->
        <div class="common">
          <div class="common-head">
            <b>По умолчанию для новых задач</b>
            <span>Можно изменить в каждом черновике</span>
          </div>
          <label class="fld">
            <span class="lbl">Постановщик
              <UiTooltip text="От чьего имени создать задачу. Пусто — от тебя: задачу ставит владелец портальной сессии. На встрече поводы приносят разные люди, и «от того, кто просил» читается иначе, чем «от меня»." />
            </span>
            <UiSelect v-model="defCreator">
              <option value="">— от меня —</option>
              <option v-for="u in b24users" :key="u.id" :value="u.id">{{ u.name }}</option>
            </UiSelect>
          </label>
          <label class="fld">
            <span class="lbl">Исполнитель
              <UiTooltip text="Кому делать. Не выбран — задача уйдёт на владельца сессии, то есть на тебя." />
            </span>
            <UiSelect v-model="defResponsible">
              <option value="">— на себя —</option>
              <option v-for="u in b24users" :key="u.id" :value="u.id">{{ u.name }}</option>
            </UiSelect>
          </label>
          <label class="fld">
            <span class="lbl">Проект</span>
            <UiSelect v-model="defGroup">
              <option value="">— без проекта —</option>
              <option v-for="g in b24groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </UiSelect>
          </label>
          <label class="fld">
            <span class="lbl">Приоритет</span>
            <UiSelect v-model.number="defPriority">
              <option :value="0">низкий</option>
              <option :value="1">средний</option>
              <option :value="2">высокий</option>
            </UiSelect>
          </label>
        </div>

        <div v-for="(d, i) in drafts" :key="i" class="draft" :class="{ done: d.createdId }">
          <div class="draft-head">
            <span class="draft-index mono">{{ String(i + 1).padStart(2, '0') }}</span>
            <span v-if="d.confidence !== null" class="conf" :class="{ low: d.confidence < 0.6 }" :title="d.reason">
              модель: {{ Math.round(d.confidence * 100) }}%
            </span>
            <span v-else class="draft-kind">ручной черновик</span>
            <UiIconButton
              v-if="!d.createdId"
              class="del"
              role="embedded"
              tone="danger"
              label="Удалить черновик"
              title="Удалить черновик"
              @click="removeDraft(i)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12 M18 6L6 18" />
              </svg>
            </UiIconButton>
          </div>
          <!-- Превью: задачу пришли ПРОЧИТАТЬ перед постановкой, а не заполнить.
               Поля формы на этом месте заставляли вычитывать заголовок из инпута и
               описание из textarea со своей полосой прокрутки. Правка — по кнопке. -->
          <template v-if="!d.editing">
            <h4 class="ptitle">{{ d.title || 'Без заголовка' }}</h4>
            <p class="pdesc">{{ d.description }}</p>
          </template>
          <template v-else>
            <UiInput
              v-model="d.title"
              class="dtitle"
              placeholder="Заголовок задачи"
              :disabled="Boolean(d.createdId)"
            />
            <UiTextarea
              v-model="d.description"
              rows="5"
              :disabled="Boolean(d.createdId)"
              placeholder="Описание (клик по реплике добавит её текст)"
            />
          </template>
          <!-- Кадр записи на том же таймкоде, что и ссылка в описании. Он и есть
               ответ на «о чём вообще шла речь»: формулировку собрала модель по чужой
               речи, а кадр показывает место, откуда она её взяла. Клик открывает
               полный размер — на превью в 420 px текст на экране не прочитать. -->
          <figure v-if="d.frame" class="shot" :class="{ off: d.frameOff }">
            <a :href="frameUrl(d.frame.name)" target="_blank" rel="noopener">
              <!-- Пропавший кадр (истёк TTL, начат новый разбор) убираем молча:
                   показывать нечего, а задача от этого не портится. -->
              <img :src="frameUrl(d.frame.name)" :alt="`Кадр записи на ${mmss(d.frame.at)}`"
                   loading="lazy" @error="d.frame = null" />
            </a>
            <figcaption>
              <span class="tc mono">{{ mmss(d.frame.at) }}</span>
              <span class="shot-note">{{ d.frameOff ? 'к задаче не приложится' : 'приложится к задаче' }}</span>
              <UiToggleButton
                v-if="!d.createdId"
                v-model="d.frameOff"
                class="btn compact-action"
              >
                {{ d.frameOff ? 'Приложить' : 'Не прикладывать' }}
              </UiToggleButton>
            </figcaption>
          </figure>
          <div class="drow">
            <UiSelect
              v-model="d.createdById"
              compact
              title="постановщик — от кого задача"
              :disabled="Boolean(d.createdId)"
            >
              <option value="">от меня</option>
              <option v-for="u in b24users" :key="u.id" :value="u.id">от: {{ u.name }}</option>
            </UiSelect>
            <UiSelect
              v-model="d.responsibleId"
              compact
              title="исполнитель"
              :disabled="Boolean(d.createdId)"
            >
              <option value="">на себя</option>
              <option v-for="u in b24users" :key="u.id" :value="u.id">{{ u.name }}</option>
            </UiSelect>
            <UiSelect
              v-model="d.groupId"
              compact
              title="проект"
              :disabled="Boolean(d.createdId)"
            >
              <option value="">без проекта</option>
              <option v-for="g in b24groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </UiSelect>
            <UiSelect
              v-model.number="d.priority"
              compact
              title="приоритет"
              :disabled="Boolean(d.createdId)"
            >
              <option :value="0">низкий</option>
              <option :value="1">средний</option>
              <option :value="2">высокий</option>
            </UiSelect>
            <!-- Своя кнопка у каждой задачи: человек решает по каждой отдельно, а не
                 удаляет лишние черновики ради того, чтобы уехал нужный. -->
            <span class="dact">
              <span v-if="d.createdId" class="ok">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M5 12l4 4L19 6" />
                </svg>
                задача {{ d.createdId }}
              </span>
              <template v-else>
                <UiToggleButton v-model="d.editing" class="btn compact-action">
                  {{ d.editing ? 'Готово' : 'Править' }}
                </UiToggleButton>
                <UiButton
                  class="btn compact-action"
                  variant="solid"
                  tone="success"
                  :disabled="d.creating || creating || !d.title.trim()"
                  :loading="d.creating"
                  loading-label="Ставлю задачу"
                  @click="createOne(d)"
                >
                  {{ d.creating ? 'Ставлю…' : 'Поставить' }}
                </UiButton>
              </template>
            </span>
          </div>
          <p v-if="d.error" class="err small">{{ d.error }}</p>
        </div>

        <div v-if="ready.length > 1" class="actions">
          <UiButton
            class="btn"
            :disabled="creating"
            :loading="creating"
            loading-label="Ставлю все задачи"
            @click="createAll"
          >
            {{ creating ? 'Ставлю…' : `Поставить все (${ready.length})` }}
          </UiButton>
        </div>
      </section>
      <!-- Расшифровка: свёрнута, потому что раздел отвечает на «какие задачи». -->
      <section class="transcript" :class="{ folded: !showTranscript }">
        <div class="thead">
          <UiDisclosureButton
            v-model:open="showTranscript"
            class="fold"
            controls="video-transcript-content"
          >
            <span class="section-mark transcript-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 12v3 M8 8v11 M12 5v14 M16 8v11 M20 12v3" />
              </svg>
            </span>
            <span class="fold-copy">
              <span class="section-kicker">Исходник</span>
              <span class="h">Расшифровка</span>
            </span>
            <span class="transcript-meta">
              <span>{{ segments.length }} реплик</span>
              <span v-if="mediaDuration">запись {{ mmss(mediaDuration) }}</span>
            </span>
          </UiDisclosureButton>
          <UiSegmentedControl
            v-if="showTranscript"
            v-model="view"
            class="tabs"
            label="Вид расшифровки"
            :options="TRANSCRIPT_VIEW_OPTIONS"
          />
        </div>

        <!-- Речь кончилась сильно раньше конца записи. Это законно (в конце молчали),
             поэтому оговорка, а не ошибка: она отвечает на «почему реплик так мало»
             до того, как вопрос превратится в подозрение к разбору. -->
        <p v-if="speechTail" class="muted note">
          Речь заканчивается на {{ mmss(speechTail.last) }}, дальше до конца записи тишина
          ({{ mmss(speechTail.silence) }}). Если ждал большего — проверь, тот ли файл загружен.
        </p>

        <div v-if="showTranscript" id="video-transcript-content" class="transcript-content">
        <div v-if="view === 'turns'" class="segs">
          <UiPressable
            v-for="(s, i) in segments"
            :key="i"
            class="seg"
            data-role="transcript-segment"
            title="Добавить в черновик задачи"
            :aria-label="`Добавить реплику ${mmss(s.start)} в черновик задачи: ${s.text}`"
            @click="appendSegment(s)"
          >
            <span class="tc mono">{{ mmss(s.start) }}</span>
            <span class="txt">{{ s.text }}</span>
            <span class="seg-add" aria-hidden="true">+</span>
          </UiPressable>
        </div>
        <div v-else class="plain">
          <p v-for="(p, i) in paragraphs" :key="i" class="para">
            <span class="tc mono">{{ mmss(p.start) }}</span> {{ p.text }}
          </p>
        </div>

        <div class="tools">
          <UiButton class="btn" @click="copyText">
            <template #leading>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 8h11v11H8z M5 16H4V5h11v1" />
              </svg>
            </template>
            {{ copied ? 'Скопировано' : 'Скопировать текст' }}
          </UiButton>
          <UiButton class="btn" @click="downloadText">
            <template #leading>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 4v11 M8 11l4 4 4-4 M5 20h14" />
              </svg>
            </template>
            Скачать .txt
          </UiButton>
          <UiButton class="btn" @click="useFullText">
            <template #leading>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 5h16 M4 10h16 M4 15h10 M18 14v6 M15 17h6" />
              </svg>
            </template>
            Весь текст в задачу
          </UiButton>
        </div>
        </div>
      </section>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import {
  UiButton,
  UiDisclosureButton,
  UiFilePicker,
  UiIconButton,
  UiInput,
  UiPressable,
  UiSegmentedControl,
  UiSelect,
  UiSpinner,
  UiTextarea,
  UiTooltip,
  UiToggleButton,
} from '../ui';
import { api } from '../shared/api-client.js';
import { writeClipboardText } from '../shared/clipboard.js';
import { usePluginsStore } from '../stores/plugins.js';

// Раздел — плагин «Видео → задачи»: выключенный показывает заглушку вместо формы.
const plugins = usePluginsStore();
if (!plugins.loaded) plugins.load();
const pluginOff = computed(() => plugins.loaded && !plugins.enabled('video'));
// Модель разбора — своя настройка этого плагина. Нет её — раздел работает как раньше,
// вручную: кнопка авторазбора просто не предлагается.
const planModel = computed(() => plugins.byId('video')?.values?.triageModel || null);

const BASE = (import.meta.env?.VITE_BRAIN_URL || '').replace(/\/$/, '');

const doctorOk = ref(null);
const uploading = ref(false);
const jobId = ref(null);
const job = ref(null);       // { status, progress, result }
const error = ref(null);
const drafts = ref([]);      // черновики задач
const creating = ref(false);
const created = ref([]);
const uploaded = ref(null);  // { name, size } выбранного файла — до отправки
// Расшифровка свёрнута по умолчанию: раздел отвечает на «какие задачи», а реплики
// нужны, когда формулировку хочется сверить с записью.
const showTranscript = ref(false);
let poll = null;

/** Байты в человеческом виде — для строки о разобранном файле. */
function mb(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 1048576 ? `${(value / 1048576).toFixed(1)} МБ` : `${Math.round(value / 1024)} КБ`;
}

api.get('/api/media/doctor').then((d) => { doctorOk.value = d.ok; }).catch(() => { doctorOk.value = false; });

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
/** Байты кадра. Имя собрал сервер, путь на диске наружу не выходит вовсе. */
function frameUrl(name) { return `${BASE}/api/media/frame/${name}`; }
/**
 * Части одной встречи. Инструменты записи режут длинный созвон на файлы, и разбирать
 * их по отдельности значит терять поводы, начатые в одной части и договорённые в
 * другой. Пока файл один, `parts` — список из одного элемента и ничего не меняет.
 */
const parts = ref([]);         // [{ name, size, jobId, job }]
const partsDone = computed(() => parts.value.filter((p) => p.job?.status === 'done'));

/**
 * Реплики всех частей со СКВОЗНЫМИ таймкодами. Сдвиг берём по длительности записи,
 * а не по концу последней реплики: молчание в хвосте части — обычное дело, и по речи
 * следующая часть наехала бы на предыдущую. Ровно так же склеивает сервер перед
 * обращением к модели — иначе «04:31» в задаче и в ленте указывали бы на разные места.
 */
const segments = computed(() => {
  const out = [];
  let offset = 0;
  for (const part of parts.value) {
    if (part.job?.status !== 'done') break;
    const result = part.job.result || {};
    for (const segment of result.transcript?.segments || []) {
      out.push({
        ...segment,
        start: Number(segment.start || 0) + offset,
        end: Number(segment.end ?? segment.start ?? 0) + offset,
      });
    }
    const duration = Number(result.duration);
    offset += Number.isFinite(duration) && duration > 0
      ? duration
      : Number(result.transcript?.segments?.at(-1)?.end || 0);
  }
  return out;
});
const fullText = computed(() => segments.value.map((s) => s.text).join(' ').trim());

/**
 * Длительность ЗАПИСИ, а не расшифровки. Показывать обязательно: без неё короткий
 * разбор читается как «кокпит обрезал», хотя на самом деле загружен другой файл.
 * Живой случай: вместо 17-минутной встречи уехал соседний ролик на 1:19 — двадцать
 * минут ушло на выяснение, что резать было нечего.
 */
const mediaDuration = computed(() => {
  // Сумма по частям: встреча из двух файлов длится столько же, сколько сам созвон,
  // и показывать длительность только первой части значило бы снова обещать не то.
  let total = 0;
  for (const part of partsDone.value) {
    const value = Number(part.job?.result?.duration);
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total > 0 ? total : null;
});

/**
 * Речь кончилась заметно раньше конца записи. Само по себе это законно (в конце
 * молчали), поэтому оговорка, а не ошибка: она отвечает на вопрос «почему реплик мало»
 * до того, как он превратится в подозрение к разбору.
 */
const speechTail = computed(() => {
  const total = mediaDuration.value;
  const last = segments.value.length ? Number(segments.value.at(-1).end) : null;
  if (!total || !Number.isFinite(last)) return null;
  const silence = total - last;
  return silence > 60 && silence / total > 0.2 ? { last, silence } : null;
});

// --- Расшифровка: реплики или сплошной текст ---

const view = ref('turns');   // turns | text
const TRANSCRIPT_VIEW_OPTIONS = [
  { value: 'turns', label: 'Реплики' },
  { value: 'text', label: 'Сплошной текст' },
];
const PAUSE_SEC = 2.5;       // пауза, после которой начинается новый абзац
const PARA_CHARS = 700;      // и потолок на случай непрерывной речи без пауз

/**
 * Сплошной текст абзацами. Границу ставим по ПАУЗЕ между репликами: у распознавания
 * нет разделения по голосам, поэтому «кто говорит» показать нечем, а пауза — честный
 * и заметный признак смены мысли. Потолок символов нужен на монолог без пауз: без
 * него абзац вырастает в нечитаемую простыню.
 */
const paragraphs = computed(() => {
  const out = [];
  let current = null;
  let prevEnd = null;
  for (const seg of segments.value) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    const gap = prevEnd == null ? 0 : (seg.start || 0) - prevEnd;
    if (!current || gap > PAUSE_SEC || current.text.length > PARA_CHARS) {
      current = { start: seg.start || 0, text };
      out.push(current);
    } else {
      current.text += ` ${text}`;
    }
    prevEnd = seg.end ?? seg.start ?? prevEnd;
  }
  return out;
});
const plainText = computed(() => paragraphs.value
  .map((p) => `[${mmss(p.start)}] ${p.text}`)
  .join('\n\n'));

const copied = ref(false);
let copiedTimer = null;
async function copyText() {
  const ok = await writeClipboardText(plainText.value);

  if (!ok) {
    error.value = 'Скопировать не удалось — выдели текст и нажми Ctrl+C.';

    return;
  }

  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = false; }, 1600);
}

function downloadText() {
  const blob = new Blob([plainText.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `расшифровка-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Ростер портала: от кого, кому и в какой проект ---
//
// Постановщик по умолчанию — владелец портальной сессии: пустой выбор уезжает как
// `null`, и `CREATED_BY` порталу не передаётся вовсе (docs/cockpit/b24.md). Но на
// встрече поводы приносят разные люди, и задача «от того, кто просил» читается иначе,
// чем «от меня»; портал такое поле принимает, поэтому выбор отдан человеку.

const b24users = ref([]);
const b24groups = ref([]);
api.get('/api/b24/users').then((d) => { b24users.value = d.users || []; }).catch(() => {});
api.get('/api/b24/groups').then((d) => { b24groups.value = d.groups || []; }).catch(() => {});

// От кого, кому и куда ставим по умолчанию — выбирается один раз на всю встречу:
// у задач одного созвона они обычно общие, и повторять выбор в каждом черновике
// значит делать руками то же самое N раз.
const defCreator = ref('');
const defResponsible = ref('');
const defGroup = ref('');
const defPriority = ref(1);

function emptyDraft() {
  return {
    title: '',
    description: '',
    createdById: defCreator.value,
    responsibleId: defResponsible.value,
    groupId: defGroup.value,
    priority: defPriority.value,
    confidence: null,
    reason: '',
    // Кадр записи на том же таймкоде, что стоит в описании: показывается до постановки
    // и уезжает на портал вложением. `frameOff` — отказ человека от конкретного кадра;
    // сам кадр при этом остаётся на экране, потому что решение обратимо.
    frame: null,
    frameOff: false,
    // Состояние постановки живёт В САМОМ черновике: задачи ставятся по одной, и общий
    // флаг на секцию не сказал бы, какая именно уехала, а какая ждёт.
    creating: false,
    createdId: null,
    error: null,
    // Предложенная моделью задача открывается ПРЕВЬЮ: её пришли прочитать, а не
    // заполнить. Пустой черновик, наоборот, сразу в правке — читать в нём нечего.
    editing: true,
  };
}

// Смена общего выбора догоняет только те черновики, которые человек не трогал сам.
watch(defCreator, (value, prev) => {
  for (const d of drafts.value) if (d.createdById === prev) d.createdById = value;
});
watch(defResponsible, (value, prev) => {
  for (const d of drafts.value) if (d.responsibleId === prev) d.responsibleId = value;
});
watch(defGroup, (value, prev) => {
  for (const d of drafts.value) if (d.groupId === prev) d.groupId = value;
});
watch(defPriority, (value, prev) => {
  for (const d of drafts.value) if (d.priority === prev) d.priority = value;
});

async function onFiles(files) {
  const picked = [...files];
  if (!picked.length) return;
  uploading.value = true; error.value = null; job.value = null; drafts.value = []; created.value = [];
  planError.value = null; planInfo.value = null;
  // Инструменты записи режут длинный созвон на части, и встреча законно лежит в
  // нескольких файлах (живой случай: 17:04 и 1:18 подряд). Части сортируем по времени
  // файла: записаны они последовательно, а браузер отдаёт выбор в порядке каталога.
  // Имя — только тай-брейк: оно не контракт, у другого инструмента формат свой.
  picked.sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0)
    || String(a.name).localeCompare(String(b.name), 'ru'));
  parts.value = picked.map((file) => ({
    name: file.name, size: file.size, jobId: null, job: null,
  }));
  // Что именно выбрано — запоминаем ДО отправки и показываем рядом с разбором.
  // Файлы записи называются почти одинаково и лежат рядом; без имени и размера на
  // экране «я выбирал другой» и «раздел обрезал» неотличимы друг от друга.
  uploaded.value = { name: picked[0].name, size: picked[0].size };
  try {
    // Последовательно: распознавание всё равно идёт по одному, а параллельная
    // отправка сотен мегабайт только отбирает канал у самой первой части.
    for (const [i, file] of picked.entries()) {
      const fd = new FormData();
      fd.append('file', file);
      // Авторизация — сессионной cookie (у fetch она уходит по умолчанию на своём origin).
      // Заголовка `X-Cockpit-Token` здесь быть не должно: он теперь принадлежит локальным CLI,
      // а из клиентского кода его значение пришлось бы класть в публичный бандл.
      const res = await fetch(`${BASE}/api/media/upload`, {
        method: 'POST', body: fd, credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      parts.value[i].jobId = data.jobId;
    }
    jobId.value = parts.value[0].jobId;
    startPoll();
  } catch (err) { error.value = err.message; } finally { uploading.value = false; }
}

function startPoll() {
  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      // Опрашиваем ВСЕ части: разбор запускается, только когда готова каждая, иначе
      // модель прочитала бы половину встречи и выдала бы это за целую.
      for (const part of parts.value) {
        if (!part.jobId || part.job?.status === 'done' || part.job?.status === 'failed') continue;
        part.job = await api.get(`/api/media/ingest/${part.jobId}`);
      }
      job.value = parts.value[0]?.job || null;
      const failed = parts.value.find((p) => p.job?.status === 'failed');
      if (failed) {
        clearInterval(poll);
        error.value = failed.job.error || 'распознавание не удалось';
        return;
      }
      if (parts.value.length && parts.value.every((p) => p.job?.status === 'done')) {
        clearInterval(poll);
        // Разбор запускается САМ: человек пришёл за задачами, а не за расшифровкой,
        // и лишний клик между «готово» и единственным осмысленным следующим шагом
        // ничего не решает. Ручная кнопка остаётся — для повтора с уточнением.
        if (planModel.value && !drafts.value.length) planTasks();
      }
    } catch { /* продолжаем поллинг */ }
  }, 2000);
}

// --- Разбор расшифровки моделью ---

const planning = ref(false);
const planHint = ref('');
const planError = ref(null);
const planInfo = ref(null);

const PLAN_ERRORS = {
  no_model: 'Модель для разбора не выбрана — «Настройки → Плагины → Видео → задачи».',
  unknown_model: 'Выбранной модели нет в реестре исполнителей: проверь настройку плагина.',
  unsafe_model_provider: 'У выбранного исполнителя нет безопасного режима для чужого текста. Подходят Claude и модели Ollama.',
  registry_failed: 'Не удалось прочитать реестр моделей.',
  executor_unavailable: 'Исполнитель выбранной модели недоступен.',
  run_failed: 'Модель не ответила. Можно повторить или собрать задачи вручную.',
  bad_plan: 'Модель ответила не по формату — задачи не разобраны. Можно повторить.',
  empty_transcript: 'В расшифровке нет ни одной реплики.',
  not_ready: 'Расшифровка ещё не готова.',
};

async function planTasks() {
  planning.value = true; planError.value = null; planInfo.value = null;
  try {
    // Все части одной посылкой: сервер склеит их со сквозными таймкодами до модели.
    // Разбор по частям порознь терял бы поводы, начатые в одной и договорённые в другой.
    const r = await api.post('/api/media/plan-tasks', {
      jobIds: partsDone.value.map((p) => p.jobId),
      hint: planHint.value,
    });
    // Черновики модели ДОПОЛНЯЮТ уже набранные руками, а не заменяют их: человек мог
    // начать разбирать сам, и стереть его работу кнопкой «разобрать» — потеря данных.
    for (const task of r.tasks || []) {
      drafts.value.push({
        ...emptyDraft(),
        title: task.title,
        description: task.description,
        confidence: task.confidence,
        reason: task.reason,
        // Кадра может не быть вовсе (аудиозапись, отказ ffmpeg) — это не ошибка разбора.
        frame: task.frame || null,
        editing: false,
      });
    }
    planInfo.value = {
      count: (r.tasks || []).length,
      model: r.model,
      truncated: r.truncated,
      shown: r.count,
    };
  } catch (err) {
    // Машинный код лежит в `data.error`; фразу для человека собираем здесь, потому что
    // сервер отдаёт только код — у «модель не выбрана» и «модель не ответила» разные выходы.
    planError.value = PLAN_ERRORS[err?.data?.error] || err.message || 'Разбор не удался.';
  } finally { planning.value = false; }
}

function addDraft() { drafts.value.push(emptyDraft()); }
function removeDraft(i) { drafts.value.splice(i, 1); }
// Перенести реплику в описание последнего черновика (ручной разбор).
function appendSegment(seg) {
  if (!drafts.value.length) drafts.value.push(emptyDraft());
  const d = drafts.value[drafts.value.length - 1];
  const line = `[${mmss(seg.start)}] ${seg.text.trim()}`;
  d.description = (d.description ? `${d.description}\n` : '') + line;
}
function useFullText() {
  drafts.value.push({ ...emptyDraft(), description: plainText.value });
}

/** Черновик, который ещё можно поставить: есть заголовок и он не уехал раньше. */
const ready = computed(() => drafts.value.filter((d) => d.title.trim() && !d.createdId));

/**
 * Ставит ОДИН черновик. Отдельная кнопка у каждого — не удобство: формулировку собрала
 * модель по чужой речи, и человек принимает решение по каждой задаче отдельно. Общая
 * кнопка заставляла бы удалять лишние черновики только затем, чтобы поставить нужный.
 */
async function createOne(d) {
  if (d.creating || d.createdId || !d.title.trim()) return null;
  d.creating = true; d.error = null;
  try {
    // Пустой выбор уезжает как null, а НЕ как 0: нулевой responsibleId портал
    // понимает буквально и отвечает ошибкой о несуществующем исполнителе
    // (docs/cockpit/b24.md). Пропуск же означает «поставить на владельца сессии».
    const r = await api.post('/api/b24/tasks', {
      title: d.title.trim(),
      description: d.description,
      // Постановщик: пусто — значит владелец сессии, и `CREATED_BY` порталу не уезжает
      // вовсе. Тот же запрет на ноль, что и у исполнителя.
      createdById: d.createdById ? Number(d.createdById) : null,
      responsibleId: d.responsibleId ? Number(d.responsibleId) : null,
      groupId: d.groupId ? Number(d.groupId) : null,
      priority: Number(d.priority),
      // Кадр уезжает ИМЕНЕМ: путь на диске подставит сервер. Отказ человека от кадра
      // и его отсутствие выглядят для портала одинаково — вложений просто нет.
      frames: d.frame && !d.frameOff ? [d.frame.name] : [],
    });
    d.createdId = r.id || '✓';
    created.value.push(d.createdId);
    return d.createdId;
  } catch (err) {
    // Ошибка остаётся У СВОЕГО черновика: при постановке пачкой общая плашка не
    // говорила бы, какая именно задача не уехала.
    d.error = err.message;
    return null;
  } finally { d.creating = false; }
}

async function createAll() {
  creating.value = true; error.value = null;
  try {
    // Последовательно: у B24Client одна портальная сессия, и параллельные вызовы её рвут.
    // Уже поставленные пропускаются сами — `ready` их не содержит.
    for (const d of [...ready.value]) await createOne(d);
  } finally { creating.value = false; }
}

onUnmounted(() => { clearInterval(poll); clearTimeout(copiedTimer); });
</script>

<style scoped>
.video {
  width: min(100%, 1160px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.video-hero {
  position: relative;
  min-height: 176px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  padding: 30px 34px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background:
    radial-gradient(circle at 84% 10%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 31%),
    linear-gradient(135deg, color-mix(in srgb, var(--surface) 94%, var(--accent)) 0%, var(--surface) 72%);
  box-shadow: var(--shadow);
}
.video-hero::after {
  content: '';
  position: absolute;
  right: -72px;
  bottom: -145px;
  width: 390px;
  height: 280px;
  border: 1px solid color-mix(in srgb, var(--accent) 16%, transparent);
  border-radius: 50%;
  pointer-events: none;
}
.hero-copy { position: relative; z-index: 1; max-width: 650px; }
.eyebrow, .section-kicker, .summary-kicker {
  margin: 0 0 7px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 750;
  letter-spacing: .1em;
  line-height: 1.2;
  text-transform: uppercase;
}
.ttl { margin: 0; font-size: clamp(26px, 2.5vw, 34px); line-height: 1.16; letter-spacing: -.035em; }
.lead { max-width: 64ch; margin: 10px 0 0; color: var(--ink-mid); font-size: 14px; line-height: 1.55; }
.hero-route { position: relative; z-index: 1; display: flex; align-items: center; flex: none; }
.route-node {
  display: grid;
  place-items: center;
  width: 50px;
  height: 50px;
  border: 1px solid var(--line-2);
  border-radius: 15px;
  background: color-mix(in srgb, var(--ground) 82%, transparent);
  color: var(--ink-mid);
  box-shadow: inset 0 1px 0 #ffffff08;
}
.route-node svg { width: 23px; height: 23px; }
.route-node.active { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); color: var(--accent); }
.route-node.good { border-color: color-mix(in srgb, var(--good) 50%, var(--line)); color: var(--good); }
.hero-route i { width: 30px; height: 1px; background: linear-gradient(90deg, var(--line-2), color-mix(in srgb, var(--accent) 45%, var(--line-2))); }

.empty-state, .notice {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
}
.empty-state { padding: 24px; }
.empty-state h3 { margin: 0; font-size: 15px; }
.empty-state p { margin: 4px 0 0; color: var(--ink-mid); font-size: 13px; }
.empty-icon, .notice-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: var(--surface-2);
  color: var(--ink-mid);
}
.empty-icon svg { width: 19px; height: 19px; }
.notice { padding: 13px 15px; }
.notice p { margin: 2px 0 0; font-size: 12.5px; }
.notice.danger { border-color: color-mix(in srgb, var(--bad) 36%, var(--line)); background: color-mix(in srgb, var(--bad) 7%, var(--surface)); }
.notice.danger .notice-icon { background: color-mix(in srgb, var(--bad) 15%, var(--surface-2)); color: var(--bad); font-weight: 800; }
.notice.danger p, .err { color: color-mix(in srgb, var(--bad) 80%, var(--ink)); }

.upload-card {
  padding: 8px;
  border: 1px dashed color-mix(in srgb, var(--accent) 42%, var(--line));
  border-radius: 17px;
  background: color-mix(in srgb, var(--accent) 4%, var(--surface));
  transition: border-color .18s ease, background .18s ease;
}
.upload-card:hover:not(.busy) { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
.upload-icon {
  display: grid;
  place-items: center;
  width: 50px;
  height: 50px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line));
  border-radius: 14px;
  background: color-mix(in srgb, var(--accent) 10%, var(--ground));
  color: var(--accent);
}
.upload-icon svg { width: 23px; height: 23px; }
.upload-action {
  min-width: 112px;
  padding: 9px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 48%, var(--line));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 650;
  text-align: center;
}
.upload-card.compact .upload-icon { width: 42px; height: 42px; border-radius: 12px; }
.upload-card.busy { opacity: .7; }

.progress {
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  border-radius: 15px;
  background: var(--surface);
  box-shadow: inset 0 1px 0 #ffffff08;
}
.progress-head { display: flex; align-items: center; gap: 12px; }
.progress-head > div { min-width: 0; flex: 1; }
.progress-head b { font-size: 14px; }
.progress-head p { margin: 2px 0 0; color: var(--ink-mid); font-size: 12.5px; }
.progress-mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 11px; background: color-mix(in srgb, var(--accent) 10%, var(--surface-2)); }
.progress-count { color: var(--accent); font-size: 12px; }
.pbar { height: 7px; overflow: hidden; border-radius: 999px; background: var(--surface-2); }
.pbar span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 68%, #fff)); transition: width .3s; }

/* Одна колонка: раскладка «расшифровка слева, задачи справа» отдавала половину
   ширины реплик, ради которых сюда не приходят, и резала превью задачи вдвое.
   Свёрнутая расшифровка занимает строку, раскрытая — всю ширину над задачами. */
.result { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.result > * { width: 100%; }
.meeting-summary {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px 18px;
  border: 1px solid color-mix(in srgb, var(--good) 30%, var(--line));
  border-radius: 15px;
  background: linear-gradient(100deg, color-mix(in srgb, var(--good) 7%, var(--surface)), var(--surface));
}
.meeting-file { min-width: 0; display: flex; align-items: center; gap: 12px; }
.meeting-file > div { min-width: 0; }
.meeting-check { flex: none; display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; background: color-mix(in srgb, var(--good) 14%, var(--surface-2)); color: var(--good); }
.meeting-check svg { width: 19px; height: 19px; }
.summary-kicker { margin-bottom: 3px; color: var(--good); font-size: 9.5px; }
.summary-metrics { display: flex; align-items: stretch; flex: none; }
.summary-metrics > span { min-width: 76px; display: grid; gap: 1px; padding: 2px 15px; border-left: 1px solid var(--line); text-align: center; }
.summary-metrics b { font-size: 14px; font-weight: 650; }
.summary-metrics small { color: var(--ink-mid); font-size: 10.5px; }
.h { margin: 0; font-size: 15px; font-weight: 660; letter-spacing: -.01em; }
/* min-width: 0 — длинная реплика без пробелов не имеет права раздувать колонку. */
.transcript, .drafts {
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 17px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, #fff) 0%, var(--surface) 100%);
  box-shadow: inset 0 1px 0 #ffffff08;
}
.thead, .dhead { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.dhead { margin-bottom: 16px; }
.section-title { min-width: 0; display: flex; align-items: center; gap: 11px; }
.section-mark { flex: none; display: grid; place-items: center; width: 39px; height: 39px; border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line)); border-radius: 11px; background: color-mix(in srgb, var(--accent) 9%, var(--ground)); color: var(--accent); }
.section-mark svg { width: 19px; height: 19px; }
.section-kicker { margin-bottom: 3px; font-size: 9px; }
.count-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 19px; margin-left: 4px; padding: 0 6px; border: 1px solid var(--line-2); border-radius: 999px; background: var(--ground); color: var(--ink-mid); font-family: var(--mono); font-size: 10.5px; vertical-align: 1px; }
.tabs { display: flex; gap: 4px; }
.segs, .plain { max-height: 480px; overflow-y: auto; overflow-wrap: anywhere; }
.segs { display: grid; gap: 3px; margin-top: 14px; padding-right: 4px; }
.seg { display: grid; width: 100%; grid-template-columns: 52px minmax(0, 1fr) 24px; align-items: start; gap: 11px; text-align: left; }
.seg-add { display: grid; place-items: center; width: 21px; height: 21px; border: 1px solid var(--line-2); border-radius: 6px; color: var(--ink-mid); opacity: 0; transition: opacity .15s, color .15s; }
.segs > :hover .seg-add { color: var(--accent); opacity: 1; }
.plain { margin-top: 15px; }
.para { margin: 0; padding: 11px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; line-height: 1.65; }
.para:last-child { border-bottom: 0; }
.tc { flex: none; color: var(--accent); font-size: 11.5px; }
.tools { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.plan { margin-bottom: 14px; padding: 14px; border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); border-radius: 13px; background: color-mix(in srgb, var(--accent) 5%, var(--ground)); }
.plan-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.plan-head > div { min-width: 0; display: grid; gap: 1px; }
.plan-head b { font-size: 13px; }
.plan-head small { overflow: hidden; color: var(--ink-mid); font-family: var(--mono); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.plan-icon { display: grid; place-items: center; width: 31px; height: 31px; border-radius: 9px; background: color-mix(in srgb, var(--accent) 11%, var(--surface-2)); color: var(--accent); }
.plan-icon svg { width: 16px; height: 16px; }
.planrow { display: flex; gap: 8px; }
.hint { flex: 1; min-width: 0; }
.note { margin: 8px 0 0; font-size: 12px; line-height: 1.5; }
.common { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; padding: 13px; border: 1px solid var(--line); border-radius: 12px; background: var(--ground); }
.common-head { grid-column: 1 / -1; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.common-head b { font-size: 12.5px; }
.common-head span { color: var(--ink-mid); font-size: 11px; }
.fld { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.lbl { display: inline-flex; align-items: center; gap: 4px; color: var(--ink-mid); font-size: 11.5px; }
.draft { position: relative; display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; padding: 15px; border: 1px solid var(--line); border-radius: 13px; background: color-mix(in srgb, var(--ground) 74%, var(--surface)); transition: border-color .15s, background .15s; }
.draft:hover { border-color: var(--line-2); }
.draft-head { min-width: 0; display: flex; align-items: center; gap: 8px; padding-right: 28px; }
.draft-index { color: var(--ink-mid); font-size: 10.5px; }
.draft-index::after { content: ''; display: inline-block; width: 18px; height: 1px; margin: 0 2px 3px 8px; background: var(--line-2); }
.draft-kind, .conf { padding: 2px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-mid); font-size: 10.5px; }
.conf { border-color: color-mix(in srgb, var(--good) 32%, var(--line)); background: color-mix(in srgb, var(--good) 7%, transparent); color: var(--good); }
.conf.low { border-color: color-mix(in srgb, var(--warn) 36%, var(--line)); background: color-mix(in srgb, var(--warn) 7%, transparent); color: var(--warn); }
.dtitle { width: 100%; }
.drow { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding-top: 2px; }
/* Кнопка задачи прижата вправо: она решение, а не ещё один селект в ряду. */
.dact { margin-left: auto; display: flex; align-items: center; gap: 8px; }
/* Превью читают глазами: заголовок — заголовком, описание — текстом с переносами.
   `pre-wrap` обязателен: модель разделяет постановку и строку «На записи: 04:31»
   пустой строкой, и без него всё слипается в один абзац. */
.ptitle { margin: 0; padding-right: 30px; font-size: 15.5px; font-weight: 650; line-height: 1.35; letter-spacing: -.01em; }
.pdesc { margin: -2px 0 1px; color: var(--ink-mid); font-size: 13.5px; line-height: 1.58; white-space: pre-wrap; overflow-wrap: anywhere; }
/* Кадр — превью, а не иллюстрация во всю карточку: решение принимают по заголовку и
   описанию, кадр только подтверждает место записи. Полный размер — по клику. */
.shot { margin: 0; display: flex; align-items: center; gap: 12px; }
.shot a { display: block; flex: none; line-height: 0; border-radius: 10px; overflow: hidden; border: 1px solid var(--line); }
.shot img { display: block; width: 100%; max-width: 260px; height: auto; }
.shot figcaption { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.shot-note { color: var(--ink-mid); font-size: 11.5px; }
/* Отказ от кадра ОБЕСЦВЕЧИВАЕТ его, а не убирает: решение обратимо, и человек должен
   видеть, от чего именно отказался. */
.shot.off a { opacity: .45; filter: grayscale(1); }
.shot.off .shot-note { color: var(--warn); }
.filenote { overflow: hidden; margin: 0; color: var(--ink-mid); font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
.filenote b { color: var(--ink); font-weight: 560; }
.partlist { margin: 4px 0 0; padding: 0 0 0 2px; list-style: none; font-size: 12.5px; color: var(--ink-mid); }
.partlist li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Свёрнутая расшифровка — одна строка-заголовок, а не пустая коробка. */
.transcript.folded { padding-block: 16px; }
.fold { min-width: 0; flex: 1; text-align: left; }
.fold-copy { display: grid; gap: 1px; }
.fold-copy .section-kicker { margin: 0; }
.transcript-mark { color: var(--ink-mid); }
.transcript-meta { display: flex; gap: 6px; margin-left: auto; }
.transcript-meta span { padding: 3px 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--ground); color: var(--ink-mid); font-size: 10.5px; white-space: nowrap; }
.transcript:not(.folded) .thead { padding-bottom: 12px; border-bottom: 1px solid var(--line); }
/* Поставленная задача остаётся видимой, но приглушённой: править её уже нечем,
   а убирать с экрана нельзя — по ней сверяют, что именно уехало на портал. */
.draft.done { border-color: color-mix(in srgb, var(--good) 40%, var(--line)); background: color-mix(in srgb, var(--good) 4%, var(--ground)); }
.err.small { font-size: 12px; margin: 0; }
.drow > .ui-select-wrap--compact { flex: 0 1 auto; }
.del { position: absolute; top: 11px; right: 11px; }
.actions { display: flex; align-items: center; gap: 12px; margin-top: 4px; flex-wrap: wrap; }
.ok { display: inline-flex; align-items: center; gap: 5px; color: var(--good); font-size: 12px; }
.ok svg { width: 15px; height: 15px; }

@media (max-width: 760px) {
  .video-hero { min-height: 0; padding: 23px; border-radius: 17px; }
  .hero-route { display: none; }
  .ttl { font-size: 25px; }
  .upload-action { display: none; }
  .meeting-summary { align-items: flex-start; flex-direction: column; }
  .meeting-file { width: 100%; }
  .summary-metrics { width: 100%; }
  .summary-metrics > span { flex: 1; }
  .summary-metrics > span:first-child { border-left: 0; }
  .common { grid-template-columns: minmax(0, 1fr); }
  .common-head { grid-column: auto; align-items: flex-start; flex-direction: column; gap: 2px; }
  .planrow { align-items: stretch; flex-direction: column; }
  .planrow .btn { width: 100%; }
  .thead { align-items: stretch; flex-direction: column; }
  .transcript-meta span:nth-child(2) { display: none; }
}

@media (max-width: 520px) {
  .video { gap: 12px; }
  .video-hero { padding: 20px; }
  .video-hero.compact .lead { display: none; }
  .upload-icon { width: 43px; height: 43px; border-radius: 12px; }
  .meeting-summary, .transcript, .drafts { padding: 15px; border-radius: 14px; }
  .dhead { align-items: flex-start; }
  .draft { padding: 13px; }
  .shot { align-items: stretch; flex-direction: column; }
  .shot a { align-self: flex-start; }
  .drow { align-items: stretch; }
  .drow > .ui-select-wrap--compact { flex: 1 1 30%; width: 100%; }
  .dact { width: 100%; margin-left: 0; padding-top: 3px; }
  .dact .btn { flex: 1; }
  .transcript-meta { display: none; }
  .seg { grid-template-columns: 45px minmax(0, 1fr); }
  .seg-add { display: none; }
  .tools .btn { flex: 1 1 auto; }
}

@media (prefers-reduced-motion: reduce) {
  .upload-card, .pbar span, .seg-add { transition: none; }
}
</style>
