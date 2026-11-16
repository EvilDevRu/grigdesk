<template>
  <UiWorkspacePage>
      <template #title><h1>{{ t('core.pluginVideo') }}</h1></template>
    <div class="video">
    <p v-if="!meetingReady" class="ui-workspace-intro"> {{ t('core.videoVyberiteZapisVstrechiDlya') }} </p>

    <div v-if="pluginOff" class="empty-state">
      <span class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3v4 M16 3v4 M5 7h14v4a7 7 0 0 1-14 0z M12 18v3" />
        </svg>
      </span>
      <div>
        <h3>{{ t('core.videoPlaginVyklyuchen') }}</h3>
        <p>{{ t('core.videoVklyuchiVideoZadachiV') }}</p>
      </div>
    </div>
    <template v-else>
      <div v-if="doctorOk === false" class="notice danger">
        <span class="notice-icon" aria-hidden="true">!</span>
        <div>
          <b>{{ t('core.videoMediaKonveyerNeGotov') }}</b>
          <p>{{ t('core.videoProverOkruzhenieServeraDlya') }}</p>
        </div>
      </div>

      <div v-if="error" class="notice danger err">
        <span class="notice-icon" aria-hidden="true">!</span>
        <p>{{ error }}</p>
      </div>

      <!-- Мастер оставляет на экране только текущую работу. Шаги после записи
           заперты до готовой расшифровки, но назад можно вернуться без потери сеанса. -->
      <div class="wizard-bar">
        <UiTabs v-model="wizardStep" class="video-steps" data-ui-workspace-tabs size="compact"
                :label="t('core.videoShagiRazboraVideo')">
          <UiTab
            id="video-step-record"
            class="video-step"
            value="record"
            controls="video-step-record-panel"
          >
            {{ meetingReady ? t('core.videoZapis') : t('core.videoX1Zapis') }}
          </UiTab>
          <UiTab
            id="video-step-review"
            class="video-step"
            value="review"
            controls="video-step-review-panel"
            :disabled="!meetingReady"
          > {{ t('core.videoX2Razbor') }} </UiTab>
          <UiTab
            id="video-step-tasks"
            class="video-step"
            value="tasks"
            controls="video-step-tasks-panel"
            :disabled="!meetingReady || planning"
          >
            {{ allTasksCreated ? t('core.videoZadachi') : t('core.videoX3Zadachi') }}
          </UiTab>
        </UiTabs>
        <!-- Сохранённый сеанс переживает F5, поэтому выход доступен на любом шаге,
             а не спрятан внутри уже пройденного экрана разбора. -->
        <UiButton
          v-if="hasVideoSession"
          class="btn clear-session"
          :disabled="uploading || planning || creating"
          @click="clearSession"
        > {{ t('core.videoUbratRazbor') }} </UiButton>
      </div>

      <section
        v-if="wizardStep === 'record'"
        id="video-step-record-panel"
        class="wizard-panel"
        role="tabpanel"
        aria-labelledby="video-step-record"
      >
      <!-- Перетаскивание ведёт в тот же обработчик, что и диалог. Это не украшение:
           нативный диалог прячет запись, чьё расширение записано не тем регистром,
           и брошенный на карточку файл остаётся единственным способом её отдать. -->
      <section
        class="upload-card"
        :class="{
          busy: uploading || needsPoll,
          compact: meetingReady,
          over: dragOver,
        }"
        @dragenter.prevent="onDragEnter"
        @dragover.prevent
        @dragleave="onDragLeave"
        @drop.prevent="onDrop"
      >
        <!-- multiple: инструменты записи режут длинный созвон на файлы, и встреча
             законно лежит в нескольких частях. Выбранные склеиваются в одну встречу
             по времени файла — порядок каталога у браузера произвольный. -->
        <UiFilePicker
          :accept="MEDIA_ACCEPT"
          multiple
          presentation="dropzone"
          :density="meetingReady ? 'compact' : 'default'"
          :disabled="needsPoll"
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
            ? t('core.videoZagruzhayuZapis')
            : meetingReady
              ? t('core.videoRazobratDruguyuZapis')
              : t('core.chooseFile') }}
          <template #hint>
            <template v-if="!meetingReady"> {{ t('core.videoSamaZapisOstanetsyaV') }} </template>
            <template v-else> {{ t('core.videoTekuschiyRazborOstanetsyaNa') }} </template>
          </template>
          <template #trailing>
            <span class="upload-action">{{ uploading ? t('core.videoPodozhdi') : t('core.chooseFile') }}</span>
          </template>
        </UiFilePicker>
      </section>

      <p v-if="storageNote" class="muted storage-note">{{ storageNote }}</p>



      <!-- Прогресс распознавания. Показывается и до первого ответа сервера: разбор
           живёт на сервере, и после возврата на страницу его состояние сначала надо
           дочитать — молчащий экран в это время читается как «ничего не идёт». -->
      <section v-if="restoring || needsPoll" class="progress">
        <div class="progress-head">
          <span class="progress-mark"><UiSpinner decorative /></span>
          <div>
            <b>{{ t('core.videoRaspoznayuRech') }}</b>
            <p v-if="restoring">{{ t('core.videoVozvraschayusKRazboruSprashivayu') }}</p>
            <p v-else>{{ t('core.videoRazbivayuZapisNaRepliki') }}</p>
          </div>
          <span v-if="job?.progress" class="mono progress-count">{{ job.progress.done }}/{{ job.progress.total }}</span>
        </div>
        <div class="pbar"><span :style="{ width: job?.progress ? (job.progress.done / job.progress.total * 100) + '%' : '10%' }"></span></div>
      </section>

      <div v-if="meetingReady" class="wizard-actions">
        <span class="muted">{{ t('core.videoRasshifrovkaGotovaZapisMozhno') }}</span>
        <UiButton variant="solid" tone="accent" @click="wizardStep = 'review'"> {{ t('core.videoKRazboru') }} </UiButton>
      </div>
      </section>

      <div
        v-if="meetingReady && wizardStep !== 'record'"
        :id="`video-step-${wizardStep}-panel`"
        class="result wizard-panel"
        role="tabpanel"
        :aria-labelledby="`video-step-${wizardStep}`"
      >
      <!-- Что именно разобрано. Строка обязательна: файлы записи называются почти
           одинаково и лежат рядом, а без имени, размера и длительности на экране
           «я выбирал другой» и «раздел обрезал» неотличимы. Живой случай: инструмент
           разбил встречу на два файла (17:04 и 1:18), уехал второй. -->
        <section v-if="wizardStep === 'review'" class="meeting-summary">
          <div class="meeting-file">
            <span class="meeting-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12l4 4L19 6" />
              </svg>
            </span>
            <div>
              <span class="summary-kicker">{{ t('core.videoRaspoznavanieZaversheno') }}</span>
              <p class="filenote">
                <template v-if="parts.length > 1">{{ t('core.videoRazobranoChastey') }} <b>{{ parts.length }}</b></template><!--
                --><template v-else>{{ t('core.videoRazobranFayl') }}<template v-if="uploaded">:&nbsp;<b>{{ uploaded.name }}</b></template><!--
                --><template v-if="uploaded && mb(uploaded.size)"> · {{ mb(uploaded.size) }}</template></template><!--
                --><template v-if="mediaDuration"> {{ t('core.videoZapis2') }} {{ mmss(mediaDuration) }}</template><!--
                --><template v-if="segments.length"> · {{ segments.length }} {{ t('core.videoReplik') }}</template>
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
            <span v-if="mediaDuration"><b class="mono">{{ mmss(mediaDuration) }}</b><small>{{ t('core.videoZapis3') }}</small></span>
            <span><b>{{ segments.length }}</b><small>{{ t('core.videoReplik') }}</small></span>
            <span><b>{{ drafts.length }}</b><small>{{ t('core.videoChernovikov') }}</small></span>
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
              <p class="section-kicker">{{ t('core.videoShag') }} {{ wizardStep === 'review' ? 2 : 3 }}</p>
              <h3 v-if="wizardStep === 'review'" class="h">{{ t('core.videoRazberiVstrechu') }}</h3>
              <h3 v-else class="h"> {{ t('core.videoProverIPostavZadachi') }} <span class="count-pill">{{ drafts.length }}</span>
              </h3>
            </div>
          </div>
          <UiButton v-if="wizardStep === 'tasks'" class="btn icon-btn" @click="addDraft"> {{ t('core.videoEscheZadacha') }} </UiButton>
        </div>

        <!-- Разбор моделью -->
        <div v-if="wizardStep === 'review'" class="plan">
          <div class="plan-head">
            <span class="plan-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1 M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z" />
              </svg>
            </span>
            <div>
              <b>{{ t('core.videoAvtorazborVstrechi') }}</b>
              <small v-if="planModel">{{ modelText(planModel) }}</small>
              <small v-else>{{ t('core.videoModelPokaNeVybrana') }}</small>
            </div>
          </div>
          <template v-if="planModel">
            <div class="planrow">
              <UiInput
                v-model="planHint"
                class="hint"
                :placeholder="t('core.videoChtoUchestPriRazbore')"
                :disabled="planning"
              />
              <UiButton
                class="btn analyze"
                variant="solid"
                tone="accent"
                :disabled="planning"
                :loading="planning"
                :loading-label="t('core.videoRazbirayuVstrechuNaZadachi')"
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
                {{ planning ? t('core.videoRazbirayu') : t('core.videoRazobratNaZadachi') }}
              </UiButton>
            </div>
            <p class="muted note">{{ t('core.videoModelProchitaetRasshifrovkuI') }}</p>
          </template>
          <p v-else class="muted note"> {{ t('core.videoAvtomaticheskiyRazborVyklyuchenModel') }} </p>
          <p v-if="planError" class="err note">{{ planError }}</p>
          <p v-if="planInfo" class="muted note">
            <template v-if="planInfo.count">{{ t('core.chatOptionModel') }} {{ planInfo.model }} {{ t('core.videoPredlozhilaZadach') }} {{ planInfo.count }}.</template>
            <template v-else>{{ t('core.chatOptionModel') }} {{ planInfo.model }} {{ t('core.videoNeNashlaZadachV') }}</template>
            <template v-if="planInfo.truncated"> {{ t('core.videoProchitanyPervye') }} {{ planInfo.shown }} {{ t('core.videoReplikOstalnoeRazberiSam') }}</template>
          </p>
        </div>

        <template v-else>
        <!-- Кому и куда: общий выбор на всю встречу -->
        <div class="common">
          <div class="common-head">
            <b>{{ t('core.videoPoUmolchaniyuDlyaNovyh') }}</b>
            <span>{{ t('core.videoMozhnoIzmenitVKazhdom') }}</span>
          </div>
          <label class="fld">
            <span class="lbl">{{ t('core.taskCreator') }} <UiTooltip :text="t('core.videoOtChegoImeniSozdat')" />
            </span>
            <UiSelect v-model="defCreator">
              <option value="">{{ t('core.videoOtMenya') }}</option>
              <option v-for="u in trackerUsers" :key="u.id" :value="u.id">{{ u.name }}</option>
            </UiSelect>
          </label>
          <label class="fld">
            <span class="lbl">{{ t('core.taskEditResponsible') }} <UiTooltip :text="t('core.videoKomuDelatNeVybran')" />
            </span>
            <UiSelect v-model="defResponsible">
              <option value="">{{ t('core.videoNaSebya') }}</option>
              <option v-for="u in trackerUsers" :key="u.id" :value="u.id">{{ u.name }}</option>
            </UiSelect>
          </label>
          <label class="fld">
            <span class="lbl">{{ t('core.taskEditProject') }}</span>
            <UiSelect v-model="defGroup">
              <option value="">{{ t('core.videoBezProekta') }}</option>
              <option v-for="g in trackerGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </UiSelect>
          </label>
          <label class="fld">
            <span class="lbl">{{ t('core.taskEditPriority') }}</span>
            <UiSelect v-model.number="defPriority">
              <option :value="0">{{ t('core.videoNizkiy') }}</option>
              <option :value="1">{{ t('core.videoSredniy') }}</option>
              <option :value="2">{{ t('core.videoVysokiy') }}</option>
            </UiSelect>
          </label>
        </div>

        <div v-if="!drafts.length" class="draft-empty">
          <b>{{ t('core.videoChernovikovPokaNet') }}</b>
          <p class="muted">{{ t('core.videoVernisKRazboruIli') }}</p>
          <UiButton variant="solid" tone="accent" @click="addDraft"> {{ t('core.videoSozdatChernovik') }} </UiButton>
        </div>

        <div v-for="(d, i) in drafts" :key="i" class="draft" :class="{ done: d.createdId }">
          <div class="draft-head">
            <span class="draft-index mono">{{ String(i + 1).padStart(2, '0') }}</span>
            <span v-if="d.confidence !== null" class="conf" :class="{ low: d.confidence < 0.6 }" v-tooltip="d.reason"> {{ t('core.videoModel') }} {{ Math.round(d.confidence * 100) }}%
            </span>
            <span v-else class="draft-kind">{{ t('core.videoRuchnoyChernovik') }}</span>
            <UiIconButton
              v-if="!d.createdId"
              class="del"
              role="embedded"
              tone="danger"
              :label="t('core.videoUdalitChernovik')"
              v-tooltip="t('core.videoUdalitChernovik')"
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
            <h4 class="ptitle">{{ d.title || t('core.videoBezZagolovka') }}</h4>
            <p class="pdesc">{{ d.description }}</p>
          </template>
          <template v-else>
            <UiInput
              v-model="d.title"
              class="dtitle"
              :placeholder="t('core.videoZagolovokZadachi')"
              :disabled="Boolean(d.createdId)"
            />
            <UiTextarea
              v-model="d.description"
              rows="5"
              :disabled="Boolean(d.createdId)"
              :placeholder="t('core.videoOpisanieKlikPoReplike')"
            />
          </template>
          <!-- Кадр записи на том же таймкоде, что и ссылка в описании. Он и есть
               ответ на «о чём вообще шла речь»: формулировку собрала модель по чужой
               речи, а кадр показывает место, откуда она её взяла. Клик открывает его
               крупно в общем просмотрщике: на превью в 420 px текст экрана не прочитать,
               а уводить человека в соседнюю вкладку значит терять из виду черновики. -->
          <figure v-if="d.frame" class="shot" :class="{ off: d.frameOff }">
            <UiPressable
              class="shot-open"
              data-context="meeting-frame-preview"
              :data-muted="d.frameOff ? 'true' : undefined"
              :aria-label="t('core.videoOtkrytKadrZapisiNa', { at: mmss(d.frame.at) })"
              v-tooltip="t('core.videoOtkrytKrupno')"
              @click="showFrame(d)"
            >
              <!-- Пропавший кадр (истёк TTL, начат новый разбор) убираем молча:
                   показывать нечего, а задача от этого не портится. -->
              <img :src="frameUrl(d.frame.name)" :alt="t('core.videoKadrZapisiNaAt', { at: mmss(d.frame.at) })"
                   loading="lazy" @error="d.frame = null" />
            </UiPressable>
            <figcaption>
              <span class="tc mono">{{ mmss(d.frame.at) }}</span>
              <span class="shot-note">{{ d.frameOff ? t('core.videoKZadacheNePrilozhitsya') : t('core.videoPrilozhitsyaKZadache') }}</span>
              <UiToggleButton
                v-if="!d.createdId"
                v-model="d.frameOff"
                class="btn compact-action"
              >
                {{ d.frameOff ? t('core.videoPrilozhit') : t('core.videoNePrikladyvat') }}
              </UiToggleButton>
            </figcaption>
          </figure>
          <!-- Фрагмент записи вокруг того же места. Кадр отвечает на «о чём шла речь»,
               фрагмент — на «что именно и как человек сказал»: формулировку модели
               сверяют по звуку, и он же уезжает к исполнителю задачи вложением. -->
          <figure
            v-if="d.clip || d.clipBusy || d.clipError"
            class="clip"
            :class="{ off: d.clipOff }"
          >
            <!-- preload=metadata: кусков на экране столько же, сколько задач, и тянуть
                 их байты до нажатия «play» незачем. Пропавший файл (истёк TTL, начат
                 новый разбор) убираем молча, как и кадр. -->
            <video
              v-if="d.clip"
              class="clip-player"
              :src="clipUrl(d.clip.name)"
              controls
              playsinline
              preload="metadata"
              @error="d.clip = null"
            ></video>
            <figcaption>
              <template v-if="d.clip">
                <span class="tc mono">{{ mmss(d.clip.from) }} – {{ mmss(d.clip.to) }}</span>
                <span class="shot-note">
                  {{ d.clipOff ? t('core.videoKZadacheNePrilozhitsya') : t('core.videoPrilozhitsyaKZadache') }}
                  <template v-if="d.clip.bytes"> · {{ mb(d.clip.bytes) }}</template>
                </span>
                <UiButton
                  class="btn compact-action"
                  v-tooltip="t('core.videoOtkrytFragmentKrupno')"
                  @click="showClip(d)"
                > {{ t('core.videoKrupnee') }} </UiButton>
                <UiToggleButton
                  v-if="!d.createdId"
                  v-model="d.clipOff"
                  class="btn compact-action"
                >
                  {{ d.clipOff ? t('core.videoPrilozhit') : t('core.videoNePrikladyvat') }}
                </UiToggleButton>
                <UiButton
                  v-if="!d.createdId && canWidenClip(d)"
                  class="btn compact-action"
                  :loading="d.clipBusy"
                  :loading-label="t('core.videoRezhuFragment')"
                  v-tooltip="t('core.videoVzyatNa15Sekund')"
                  @click="widenClip(d)"
                > {{ t('core.videoShire') }} </UiButton>
              </template>
              <template v-else-if="d.clipBusy">
                <UiSpinner decorative />
                <span class="shot-note">{{ t('core.videoRezhuFragmentZapisi') }}</span>
              </template>
              <span v-else class="shot-note warn-note">{{ d.clipError }}</span>
            </figcaption>
          </figure>
          <div class="drow">
            <UiSelect
              v-model="d.createdById"
              compact
              v-tooltip="t('core.videoPostanovschikOtKogoZadacha')" :aria-description="t('core.videoPostanovschikOtKogoZadacha')"
              :disabled="Boolean(d.createdId)"
            >
              <option value="">{{ t('core.videoOtMenya2') }}</option>
              <option v-for="u in trackerUsers" :key="u.id" :value="u.id">{{ t('core.videoOt') }} {{ u.name }}</option>
            </UiSelect>
            <UiSelect
              v-model="d.responsibleId"
              compact
              v-tooltip="t('core.videoIspolnitel')" :aria-description="t('core.videoIspolnitel')"
              :disabled="Boolean(d.createdId)"
            >
              <option value="">{{ t('core.videoNaSebya2') }}</option>
              <option v-for="u in trackerUsers" :key="u.id" :value="u.id">{{ u.name }}</option>
            </UiSelect>
            <UiSelect
              v-model="d.groupId"
              compact
              v-tooltip="t('core.videoProekt')" :aria-description="t('core.showcaseProekt')"
              :disabled="Boolean(d.createdId)"
            >
              <option value="">{{ t('core.videoBezProekta2') }}</option>
              <option v-for="g in trackerGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </UiSelect>
            <UiSelect
              v-model.number="d.priority"
              compact
              v-tooltip="t('core.videoPrioritet')" :aria-description="t('core.videoPrioritet')"
              :disabled="Boolean(d.createdId)"
            >
              <option :value="0">{{ t('core.videoNizkiy') }}</option>
              <option :value="1">{{ t('core.videoSredniy') }}</option>
              <option :value="2">{{ t('core.videoVysokiy') }}</option>
            </UiSelect>
            <!-- Своя кнопка у каждой задачи: человек решает по каждой отдельно, а не
                 удаляет лишние черновики ради того, чтобы уехал нужный. -->
            <span class="dact">
              <template v-if="d.createdId">
                <span class="ok">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M5 12l4 4L19 6" />
                  </svg> {{ t('settings.diagnosticSourceTask') }} {{ d.createdId }}
                </span>
                <!-- Задача уже создана, и повторно ставить её нельзя. Вместо тупиковой
                     галочки даём перейти в общую карточку GrigDesk и проверить результат. -->
                <UiButton
                  class="btn compact-action"
                  :aria-label="t('core.videoOtkrytZadachuCreatedid', { createdId: String(d.createdId) })"
                  v-tooltip="t('core.videoOtkrytZadachuVGrigdesk')"
                  @click="ui.openTask(d.createdId)"
                > {{ t('core.open') }} </UiButton>
              </template>
              <template v-else>
                <UiToggleButton v-model="d.editing" class="btn compact-action">
                  {{ d.editing ? t('core.chatSettingsDone') : t('core.videoPravit') }}
                </UiToggleButton>
                <UiButton
                  class="btn compact-action"
                  variant="solid"
                  tone="success"
                  :disabled="d.creating || creating || !d.title.trim()"
                  :loading="d.creating"
                  :loading-label="t('core.videoStavlyuZadachu')"
                  @click="createOne(d)"
                >
                  {{ d.creating ? t('core.videoStavlyu') : t('core.usageConfirmSet') }}
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
            :loading-label="t('core.videoStavlyuVseZadachi')"
            @click="createAll"
          >
            {{ creating ? t('core.videoStavlyu') : t('core.videoPostavitVseLength', { length: ready.length }) }}
          </UiButton>
        </div>
        </template>
      </section>
      <!-- Расшифровка: свёрнута, потому что раздел отвечает на «какие задачи». -->
      <section
        v-if="wizardStep === 'review'"
        class="transcript"
        :class="{ folded: !showTranscript }"
      >
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
              <span class="section-kicker">{{ t('core.videoIshodnik') }}</span>
              <span class="h">{{ t('core.videoRasshifrovka') }}</span>
            </span>
            <span class="transcript-meta">
              <span>{{ segments.length }} {{ t('core.videoReplik') }}</span>
              <span v-if="mediaDuration">{{ t('core.videoZapis3') }} {{ mmss(mediaDuration) }}</span>
            </span>
          </UiDisclosureButton>
          <UiSegmentedControl
            v-if="showTranscript"
            v-model="view"
            class="tabs"
            :label="t('core.videoVidRasshifrovki')"
            :options="TRANSCRIPT_VIEW_OPTIONS"
          />
        </div>

        <!-- Речь кончилась сильно раньше конца записи. Это законно (в конце молчали),
             поэтому оговорка, а не ошибка: она отвечает на «почему реплик так мало»
             до того, как вопрос превратится в подозрение к разбору. -->
        <p v-if="speechTail" class="muted note"> {{ t('core.videoRechZakanchivaetsyaNa') }} {{ mmss(speechTail.last) }}{{ t('core.videoDalsheDoKontsaZapisi') }}{{ mmss(speechTail.silence) }}{{ t('core.videoEsliZhdalBolshegoProver') }} </p>

        <div v-if="showTranscript" id="video-transcript-content" class="transcript-content">
        <div v-if="view === 'turns'" class="segs">
          <UiPressable
            v-for="(s, i) in segments"
            :key="i"
            class="seg"
            data-role="transcript-segment"
            v-tooltip="t('core.videoDobavitVChernovikZadachi')"
            :aria-label="t('core.videoDobavitReplikuStartV', { start: mmss(s.start), text: s.text })"
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
            {{ copied ? t('core.videoSkopirovano') : t('core.videoSkopirovatTekst') }}
          </UiButton>
          <UiButton class="btn" @click="downloadText">
            <template #leading>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 4v11 M8 11l4 4 4-4 M5 20h14" />
              </svg>
            </template> {{ t('core.videoSkachatTxt') }} </UiButton>
          <UiButton class="btn" @click="useFullText">
            <template #leading>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 5h16 M4 10h16 M4 15h10 M18 14v6 M15 17h6" />
              </svg>
            </template> {{ t('core.videoVesTekstVZadachu') }} </UiButton>
        </div>
        </div>
      </section>

      <div class="wizard-actions">
        <UiButton @click="wizardStep = wizardStep === 'tasks' ? 'review' : 'record'">
          {{ wizardStep === 'tasks' ? t('core.videoNazadKRazboru') : t('core.videoNazadKZapisi') }}
        </UiButton>
        <UiButton
          v-if="wizardStep === 'review'"
          variant="solid"
          tone="accent"
          :disabled="planning"
          :loading="planning"
          :loading-label="t('core.videoZhduRazborModeli')"
          @click="wizardStep = 'tasks'"
        >
          {{ drafts.length ? t('core.videoKZadachamLength', { length: drafts.length }) : t('core.videoKZadacham') }}
        </UiButton>
      </div>
      </div>
    </template>
    </div>
  </UiWorkspacePage>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import {
  UiButton, UiDisclosureButton, UiFilePicker, UiIconButton, UiInput, UiWorkspacePage,
  UiPressable, UiSegmentedControl, UiSelect, UiSpinner, UiTab, UiTabs, UiTextarea, UiTooltip,
  UiToggleButton, confirmDialog, vTooltip, t, messageRef,
} from '../ui';
import { api } from '../shared/apiClient.ts';
import { mediaApi } from '../shared/mediaApi.ts';
import { saveFile } from '../shared/saveFile.ts';
import { writeClipboardText } from '../shared/clipboard.ts';
import { mmss } from '../shared/format.ts';
import { usePluginsStore } from '../stores/plugins.ts';
import { useDocumentPreviewStore } from '../stores/documentPreview.ts';
import { useUiStore } from '../stores/ui.ts';
import { canWidenClip, useVideoSessionStore } from '../stores/videoSession.ts';
import type { VideoDraft } from '../stores/videoSession.ts';
import type { MediaStorageUsage, MediaTranscriptSegment } from '../../../shared/media/mediaContracts.ts';

// Соседние сторы ещё на JavaScript: раздел объявляет ровно то, что читает у них.
interface VideoPluginsSource {
  loaded: boolean;
  load(): unknown;
  enabled(id: string): boolean;
  byId(id: string): { values?: Record<string, unknown> } | null;
}

interface VideoPreviewOptions {
  src: string;
  name?: string;
  mime?: string;
}

interface VideoPreviewSource {
  showImage(options: VideoPreviewOptions): void;
  showVideo(options: VideoPreviewOptions): void;
}

// Раздел — плагин «Видео → задачи»: выключенный показывает заглушку вместо формы.
const plugins = usePluginsStore() as unknown as VideoPluginsSource;
const preview = useDocumentPreviewStore() as unknown as VideoPreviewSource;
const ui = useUiStore();

if (!plugins.loaded) {
  plugins.load();
}

const pluginOff = computed(() => plugins.loaded && !plugins.enabled('video'));
// Модель разбора — своя настройка этого плагина. Нет её — раздел работает как раньше,
// вручную: кнопка авторазбора просто не предлагается.
const planModel = computed<unknown>(() => plugins.byId('video')?.values?.triageModel || null);

/**
 * Имя модели для строки настройки. Ссылка приходит либо парой «исполнитель и модель»,
 * либо готовой строкой: раздел показывает то, что в ней названо моделью.
 */
function modelText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const model = value !== null && typeof value === 'object'
    ? (value as { model?: unknown }).model
    : null;

  return typeof model === 'string' && model ? model : String(value ?? '');
}

// Сам разбор встречи живёт в сторе, а не здесь: страница — обычный route-компонент,
// и переход в соседний раздел уносил бы вместе с ней id уже идущего распознавания.
// Компонент остаётся отображением: расшифровка на экране, кнопки и превью.
const session = useVideoSessionStore();

session.hydrate();

const {
  parts,
  uploaded,
  uploading,
  error,
  drafts,
  creating,
  planning,
  planHint,
  planError,
  planInfo,
  defCreator,
  defResponsible,
  defGroup,
  defPriority,
  job,
  restoring,
  needsPoll,
  segments,
  mediaDuration,
  ready,
} = storeToRefs(session);

const {
  addDraft,
  appendSegment,
  createAll,
  createOne,
  onFiles,
  planTasks,
  removeDraft,
  widenClip,
} = session;

// Мастер не хранит отдельную копию данных: шаг — только способ показать одну фазу
// большого сеанса. После F5 готовность выводится из восстановленных job'ов, поэтому
// человек попадает к разбору, а не в пустую форму первого шага.
const wizardStep = ref('record');
const meetingReady = computed(() => parts.value.length > 0
  && parts.value.every((part) => part.job?.status === 'done'));
const hasVideoSession = computed(() => parts.value.length > 0 || drafts.value.length > 0);
const allTasksCreated = computed(() => drafts.value.length > 0
  && drafts.value.every((draft) => Boolean(draft.createdId)));

watch(meetingReady, (ready, wasReady) => {
  if (ready && !wasReady && wizardStep.value === 'record') {
    // После F5 уже набранные черновики важнее повторного просмотра исходника;
    // новый разбор без черновиков, наоборот, начинается с проверки расшифровки.
    wizardStep.value = drafts.value.length ? 'tasks' : 'review';
  } else if (!ready && wizardStep.value !== 'record') {
    wizardStep.value = 'record';
  }
}, { immediate: true });

// Список расширений, а не одни MIME-маски: нативный диалог разворачивает `video/*`
// в расширения и сравнивает их ПОБУКВЕННО, поэтому запись с айфона (`IMG_4793.MOV`)
// в диалоге серая — выбрать её нечем, хотя конвейер разбирает такой файл как любой
// другой. Маски оставлены для браузеров, которые фильтруют по типу, а не по имени.
const MEDIA_EXTENSIONS = [
  'mov', 'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'wmv', 'flv', 'ogv',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'wma', 'amr', 'aiff', 'aif', 'caf',
];
const MEDIA_ACCEPT = [
  'video/*',
  'audio/*',
  ...MEDIA_EXTENSIONS.flatMap((ext) => [`.${ext}`, `.${ext.toUpperCase()}`]),
].join(',');

const doctorOk = ref<boolean | null>(null);
// Сколько записей лежит на диске мозга и как долго они там живут. Раздел хранит
// исходники ради кадров и фрагментов, и без этой строки рост виден только по
// свободному месту на диске — то есть слишком поздно.
const storage = ref<MediaStorageUsage | null>(null);
// Расшифровка свёрнута по умолчанию: раздел отвечает на «какие задачи», а реплики
// нужны, когда формулировку хочется сверить с записью.
const showTranscript = ref(false);

/**
 * Байты в человеческом виде — для строки о разобранном файле. Гигабайты нужны не
 * файлу, а хранилищу: записи копятся, и «1434.6 МБ» читается хуже, чем «1.4 ГБ».
 */
function mb(bytes: unknown): string {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value <= 0) {
    return '';
  }
  if (value >= 1073741824) {
    return t('core.coreTofixed1Gb', { toFixed1: (value / 1073741824).toFixed(1) });
  }

  return value >= 1048576
    ? t('core.coreTofixed1Mb', { toFixed1: (value / 1048576).toFixed(1) })
    : t('core.coreRoundvalue1024Kb', { roundvalue1024: Math.round(value / 1024) });
}

mediaApi.doctor()
  .then((report) => {
    doctorOk.value = report.ok;
    storage.value = report.storage;
  })
  .catch(() => {
    doctorOk.value = false;
  });

/** Срок хранения записей словами: сервер отдаёт его миллисекундами вместе с размером. */
const storageNote = computed(() => {
  const value = storage.value;

  if (!value?.files) {
    return '';
  }

  const days = Math.round((Number(value.ttlMs) || 0) / 86400000);
  const kept = days ? t('core.videoKeptDays', { days }) : '';

  return t('core.videoZapisiOstayutsyaVGrigdesk', {
    kept,
    files: value.files,
    bytes: mb(value.bytes),
  });
});

// Байты кадра и фрагмента: имя собрал сервер, путь на диске наружу не выходит вовсе.
function frameUrl(name: string): string {
  return mediaApi.frameUrl(name);
}

function clipUrl(name: string): string {
  return mediaApi.clipUrl(name);
}

// Кадр и фрагмент открываются ОБЩИМ просмотрщиком GrigDesk (тем же, что показывает
// картинки чата), а не новой вкладкой. Разбор встречи — работа в одном экране: уход
// на соседнюю вкладку ради картинки уносит из виду набранные черновики, а возвращаться
// приходится руками. Escape, возврат фокуса и слой поверх страницы там уже свои.
function showFrame(d: VideoDraft) {
  if (!d.frame) {
    return;
  }

  preview.showImage({
    src: frameUrl(d.frame.name),
    name: t('core.videoKadrZapisiNaAt', { at: mmss(d.frame.at) }),
    mime: 'image/jpeg',
  });
}

function showClip(d: VideoDraft) {
  if (!d.clip) {
    return;
  }

  preview.showVideo({
    src: clipUrl(d.clip.name),
    name: t('core.coreFragmentFromTo', { from: mmss(d.clip.from), to: mmss(d.clip.to) }),
    mime: 'video/mp4',
  });
}

/**
 * Речь кончилась заметно раньше конца записи. Само по себе это законно (в конце
 * молчали), поэтому оговорка, а не ошибка: она отвечает на вопрос «почему реплик мало»
 * до того, как он превратится в подозрение к разбору.
 */
const speechTail = computed(() => {
  const total = mediaDuration.value;
  const lastSegment = segments.value.at(-1);
  const last = lastSegment ? Number(lastSegment.end) : null;

  if (!total || last === null || !Number.isFinite(last)) {
    return null;
  }

  const silence = total - last;

  return silence > 60 && silence / total > 0.2 ? { last, silence } : null;
});

// --- Расшифровка: реплики или сплошной текст ---

const view = ref('turns');   // turns | text
const TRANSCRIPT_VIEW_OPTIONS = [
  { value: 'turns', get label() {
    return t('core.videoRepliki');
  } },
  { value: 'text', get label() {
    return t('core.videoSploshnoyTekst');
  } },
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
  const out: { start: number; text: string }[] = [];
  let current: { start: number; text: string } | null = null;
  let prevEnd: number | null = null;

  for (const seg of segments.value) {
    const text = (seg.text || '').trim();

    if (!text) {
      continue;
    }

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
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Копирование расшифровки. Отказ буфера (нет разрешения, небезопасный контекст) —
 * не молчаливая пропажа: человеку называется запасной путь.
 */
async function copyText() {
  const ok = await writeClipboardText(plainText.value);

  if (!ok) {
    error.value = t('core.coreSkopirovatNeUdalosVydeli');

    return;
  }

  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, 1600);
}

/**
 * Сохраняет расшифровку общим способом для браузера и нативной оболочки.
 * Имя содержит дату, а содержимое не проходит через прикладной журнал.
 */
async function downloadText() {
  const blob = new Blob([plainText.value], { type: 'text/plain;charset=utf-8' });

  try {
    await saveFile(blob, t('core.videoTranscriptFilename', { date: new Date().toISOString().slice(0, 10) }));
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('core.coreNeUdalosSohranitRasshifrovku');
  }
}

/** Вся расшифровка одним черновиком — запасной путь, когда разбирать модели нечем. */
function useFullText() {
  session.useFullText(plainText.value);
  wizardStep.value = 'tasks';
}

/**
 * Убрать разбор с экрана. Сеанс теперь липкий: он переживает и переход в другой
 * раздел, и перезагрузку страницы, поэтому у него обязана быть своя кнопка выхода —
 * иначе вчерашняя встреча висит на экране, и убрать её нечем, кроме выбора нового
 * файла. Спрашиваем только когда есть что терять: непоставленные черновики.
 */
async function clearSession() {
  if (session.ready.length) {
    const ok = await confirmDialog(
      messageRef('core.videoUbratRazborChernovikiKotorye'),
      { danger: true, okText: t('settings.remove') },
    );

    if (!ok) {
      return;
    }
  }

  session.reset();
  wizardStep.value = 'record';
  showTranscript.value = false;
}

// --- Ростер портала: от кого, кому и в какой проект ---
//
// Постановщик по умолчанию — владелец портальной сессии: пустой выбор уезжает как
// `null`, и `CREATED_BY` порталу не передаётся вовсе (docs/grigdesk/b24.md). Но на
// встрече поводы приносят разные люди, и задача «от того, кто просил» читается иначе,
// чем «от меня»; портал такое поле принимает, поэтому выбор отдан человеку.
// Ростер и проекты принадлежат плагину B24: его контракт живёт отдельно, а разделу
// «Видео» от него нужны только имя и идентификатор для селекта.
interface B24Option {
  id: number | string;
  name?: string;
  title?: string;
}

const trackerUsers = ref<B24Option[]>([]);
const trackerGroups = ref<B24Option[]>([]);

/**
 * Список для селекта из ответа портала. Ростер принадлежит плагину B24, и раздел
 * читает из него только массив: непонятная форма превращается в пустой выбор.
 */
function optionList(value: unknown, key: string): B24Option[] {
  const source = value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : null;

  return Array.isArray(source) ? source as B24Option[] : [];
}

api.get('/api/tracker/users').then((d) => {
  trackerUsers.value = optionList(d, 'users');
}).catch(() => {});
api.get('/api/tracker/groups').then((d) => {
  trackerGroups.value = optionList(d, 'groups');
}).catch(() => {});

// Смена общего выбора догоняет только те черновики, которые человек не трогал сам.
watch(defCreator, (value, prev) => {
  for (const d of drafts.value) {
    if (d.createdById === prev) {
      d.createdById = value;
    }
  }
});
watch(defResponsible, (value, prev) => {
  for (const d of drafts.value) {
    if (d.responsibleId === prev) {
      d.responsibleId = value;
    }
  }
});
watch(defGroup, (value, prev) => {
  for (const d of drafts.value) {
    if (d.groupId === prev) {
      d.groupId = value;
    }
  }
});
watch(defPriority, (value, prev) => {
  for (const d of drafts.value) {
    if (d.priority === prev) {
      d.priority = value;
    }
  }
});

// Перетаскивание файла на карточку. Счётчик enter/leave нужен потому, что `dragleave`
// стреляет на каждом дочернем элементе, и одиночный флаг гас бы на первой же вложенной
// разметке (тот же приём, что у drag&drop чата).
const dragDepth = ref(0);
const dragOver = computed(() => dragDepth.value > 0);

function onDragEnter(event: DragEvent) {
  if (event.dataTransfer?.types?.includes('Files')) {
    dragDepth.value++;
  }
}

function onDragLeave() {
  if (dragDepth.value > 0) {
    dragDepth.value--;
  }
}

/**
 * Брошенные файлы идут тем же путём, что и выбранные в диалоге. Идущий разбор
 * перетаскивание не перебивает: у пикера в это время `disabled`, и второй путь
 * обязан вести себя так же, иначе запись подменялась бы на середине распознавания.
 */
function onDrop(event: DragEvent) {
  dragDepth.value = 0;

  if (uploading.value || needsPoll.value) {
    return;
  }

  const files = [...(event.dataTransfer?.files || [])];

  if (files.length) {
    onFiles(files);
  }
}

// Возврат в раздел дочитывает статусы частей и, если разбор ещё идёт, продолжает
// поллинг. После перезагрузки страницы у восстановленных частей есть только jobId:
// расшифровка и прогресс лежат на сервере и приезжают этим же запросом.
onMounted(() => {
  void session.resume();
});

// Уход со страницы дожимает снимок сеанса: отложенная запись пережила бы саму вью и
// сработала бы неизвестно когда. Поллинг при этом не трогаем — он принадлежит сеансу
// и обязан продолжаться, пока распознавание идёт.
onUnmounted(() => {
  clearTimeout(copiedTimer);
  session.persistNow();
});
</script>

<style scoped>
.video {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.wizard-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.video-steps { width: 100%; }
.video-step { flex: 1; justify-content: center; white-space: nowrap; }
.wizard-panel { min-width: 0; }
section.wizard-panel { display: grid; gap: 16px; }
.wizard-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.wizard-actions > .muted { margin-right: auto; font-size: 12px; }
.draft-empty {
  display: grid;
  justify-items: start;
  gap: 7px;
  padding: 18px;
  border: 1px dashed var(--line-2);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 55%, transparent);
}
.draft-empty p { margin: 0; font-size: 12px; }

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
.upload-card.over {
  border-style: solid;
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}

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
.clear-session { flex: none; margin-left: 4px; }
.storage-note { margin: -4px 0 0; font-size: 11.5px; }
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
.shot-open { flex: none; }
.shot img { display: block; width: 100%; max-width: 260px; height: auto; }
.shot figcaption { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.shot-note { color: var(--ink-mid); font-size: 11.5px; }
/* Отказ от кадра ОБЕСЦВЕЧИВАЕТ его, а не убирает: решение обратимо, и человек должен
   видеть, от чего именно отказался. */
.clip { margin: 0; display: flex; align-items: flex-start; gap: 12px; }
.clip-player {
  display: block;
  flex: none;
  width: 100%;
  max-width: 320px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #000;
}
.clip figcaption { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.clip.off .clip-player { opacity: .45; filter: grayscale(1); }
.clip.off .shot-note { color: var(--warn); }
.warn-note { color: var(--warn); }
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

  .ttl { font-size: 25px; }
  .upload-action { display: none; }
  .wizard-bar { align-items: stretch; flex-direction: column; }
  .wizard-bar .clear-session { margin-left: 0; }
  .wizard-actions { align-items: stretch; flex-direction: column-reverse; }
  .wizard-actions > .muted { margin-right: 0; }
  .wizard-actions .ui-button { width: 100%; }
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

  .upload-icon { width: 43px; height: 43px; border-radius: 12px; }
  .meeting-summary, .transcript, .drafts { padding: 15px; border-radius: 14px; }
  .dhead {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .dhead > .section-title { flex: 1 1 220px; }
  .dhead > .btn { flex: none; }
  .draft { padding: 13px; }
  .shot { align-items: stretch; flex-direction: column; }
  .shot-open { align-self: flex-start; }
  .clip { align-items: stretch; flex-direction: column; }
  .clip-player { max-width: none; }
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

@media (max-height: 500px) {
  .video { gap: 8px; }
  .upload-card { padding: 12px; }
}
</style>
