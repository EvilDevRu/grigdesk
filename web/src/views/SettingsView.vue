<template>
  <div class="settings" :class="{ 'settings-plugins': tab === 'plugins' }">
    <header class="settings-hero">
      <div>
        <p class="eyebrow">Центр управления</p>
        <h2>Настройте Cockpit под свой процесс</h2>
        <p>
          Подключения, исполнители и системные параметры собраны в одном месте.
          Изменения применяются только там, где это явно указано.
        </p>
      </div>
      <div class="hero-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 6h10 M18 6h2 M10 12h10 M4 12h2 M4 18h7 M15 18h5 M14 4v4 M6 10v4 M11 16v4" />
        </svg>
      </div>
    </header>

    <div class="settings-layout">
      <aside class="settings-nav-wrap">
        <nav ref="settingsNav" class="settings-nav" aria-label="Разделы настроек">
          <div v-for="group in TAB_GROUPS" :key="group.label" class="nav-group">
            <div class="nav-group-label">{{ group.label }}</div>
            <UiButton
              v-for="item in group.items"
              :key="item.id"
              class="settings-nav-item"
              variant="ghost"
              data-role="settings-nav"
              :data-settings-tab="item.id"
              :class="{ active: tab === item.id }"
              :aria-current="tab === item.id ? 'page' : undefined"
              @click="setTab(item.id)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path :d="item.icon" />
              </svg>
              <span>
                <strong>{{ item.label }}</strong>
                <small>{{ item.short }}</small>
              </span>
            </UiButton>
          </div>
        </nav>
      </aside>

      <div
        class="settings-workspace"
        :class="{ wide: ['providers', 'plugins', 'runs'].includes(tab) }"
      >
        <header class="section-intro">
          <span class="section-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path :d="currentTab.icon" />
            </svg>
          </span>
          <div>
            <p class="eyebrow">{{ currentTab.group }}</p>
            <h2>{{ currentTab.label }}</h2>
            <p>{{ currentTab.description }}</p>
          </div>
        </header>

    <!-- Приложение: локальные настройки устройства, не уезжают на другие окна -->
    <section v-if="tab === 'app'">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Экран устройства</h3>
            <p class="muted small">Локальная настройка — не влияет на другие компьютеры и планшеты.</p>
          </div>
          <span class="scope-pill">Это устройство</span>
        </div>
        <div class="mode">
          <UiSwitch
            :model-value="pwa.wakeLockEnabled"
            :disabled="pwa.wakeLockBusy || (!pwa.wakeLockSupported && !pwa.wakeLockEnabled)"
            @update:model-value="pwa.setWakeLockEnabled"
          >
            Не гасить экран
          </UiSwitch>
          <p class="muted small">
            Удерживает экран включённым на всех страницах кокпита. При сворачивании PWA
            блокировка снимается системой и автоматически возвращается после открытия.
          </p>
        </div>
        <p v-if="pwa.wakeLockActive" class="msg ok">Экран удерживается включённым.</p>
        <p v-else-if="pwa.wakeLockError" class="msg err">{{ pwa.wakeLockError }}</p>
        <p v-else-if="!pwa.wakeLockSupported" class="msg warn">
          {{ wakeLockNeedsHttps
            ? 'Функция доступна только при открытии кокпита через HTTPS.'
            : 'Этот браузер не поддерживает удержание экрана.' }}
        </p>
        <p v-else-if="pwa.wakeLockEnabled" class="muted small">
          Блокировка включится, когда приложение снова станет активным.
        </p>

        <div class="mode notification-mode">
          <div class="notification-line">
            <div>
              <b>Системные оповещения</b>
              <p class="muted small">
                Ответы агентов, вопросы и остановки конвейера, пока приложение запущено.
              </p>
            </div>
            <UiButton
              data-role="settings-action"
              :disabled="pwa.notificationBusy || !pwa.notificationSupported"
              @click="pwa.testNotification"
            >
              {{ pwa.notificationBusy
                ? 'Проверяю…'
                : (pwa.notificationPermission === 'granted' ? 'Проверить' : 'Включить и проверить') }}
            </UiButton>
          </div>
          <p v-if="pwa.notificationPermission === 'granted'" class="msg ok">
            Оповещения разрешены на этом устройстве.
          </p>
          <p v-else-if="pwa.notificationError" class="msg err">{{ pwa.notificationError }}</p>
          <p v-else-if="!pwa.notificationSupported" class="msg warn">
            {{ notificationNeedsHttps
              ? 'Оповещения доступны только при открытии кокпита через HTTPS.'
              : 'Этот браузер не поддерживает системные оповещения.' }}
          </p>
          <p v-else class="muted small">
            Разрешение спрашивается только по этой кнопке — автоматический запрос PWA браузер блокирует.
          </p>
        </div>

      </div>

      <!-- Горячие клавиши инструментов — тоже настройка устройства: клавиатуры планшета
           и рабочего компьютера разные, а состав панелей берётся из общего реестра. -->
      <div class="card">
        <ToolHotkeys />
      </div>

      <!-- Компаньон — своя карточка, а не строка в «Экране устройства»: у него три разных
           решения (показывать ли, чем отвечает, озвучивать ли), и два из них device-local,
           а одно общее для всех окон. Область каждого блока названа пилюлей: без этого
           непонятно, почему смена модели видна на планшете, а тумблер — нет. -->
      <div class="card companion-card" data-testid="companion-settings">
        <div class="card-head">
          <div>
            <h3>Голосовой компаньон</h3>
            <p class="muted small">
              Компактный аватар поверх страниц: быстрый вопрос голосом или текстом в том же
              разговоре, что открыт на странице «Чаты».
            </p>
          </div>
          <span class="status-pill" :class="{ ok: companion.deviceEnabled }"
                data-testid="companion-connection-state">
            <span class="dot"></span>
            {{ companion.deviceEnabled ? 'Подключён' : 'Отключён' }}
          </span>
        </div>

        <div class="mode" data-testid="companion-device-setting">
          <UiSwitch
            :model-value="companion.deviceEnabled"
            @update:model-value="companion.setDeviceEnabled"
          >
            Показывать компаньона на этом устройстве
          </UiSwitch>
          <p class="muted small">
            Скрывает только аватар и компактное окно на этом устройстве. Полная страница
            «Чаты», история и настройки речи продолжают работать; вернуть компаньона можно здесь.
          </p>
        </div>

        <!-- Единственная СЕРВЕРНАЯ настройка компаньона: разговор у него один на все окна,
             поэтому и модель одна. Здесь же — единственное место, где её меняют: селекты
             в самом companion-чате неактивны, иначе правд стало бы две. -->
        <div class="mode companion-run-setting" data-testid="companion-run-setting">
          <div class="companion-run-head">
            <div>
              <b>Чем отвечает</b>
              <p class="muted small">
                Исполнитель, модель и усилие быстрого хода. Настройка общая для всех окон и
                для всех разговоров компаньона — и общего, и привязанных к задачам.
                Режим у него всегда «план»: быстрый ход только читает и отвечает.
              </p>
            </div>
            <span class="scope-pill">Все окна</span>
          </div>
          <div class="plug-model-grid"
               :class="{ solo: !(companionEffortLevels.length || companionEffortLost) }">
            <div class="plugrow wide">
              <label for="companion-model">Модель</label>
              <UiSelect
                id="companion-model"
                class="inp"
                data-context="settings-field"
                data-testid="companion-model-select"
                :disabled="companionRunBusy"
                :model-value="companionModelValue"
                @change="setCompanionModel($event.target.value)"
              >
                <option value="">— по умолчанию из реестра —</option>
                <!-- Выбор мог пропасть из каталога (сменили CLI, демон молчит). Молча
                     показать «по умолчанию» нельзя: в настройках он остался, и ход
                     компаньона сейчас вообще не уйдёт. -->
                <option v-if="companionModelLost" :value="companionModelValue">
                  {{ companionModelLost }} — нет в реестре
                </option>
                <optgroup v-for="g in modelGroups" :key="g.id"
                          :label="g.name + (g.available ? '' : ' — недоступен')">
                  <option v-for="m in g.models" :key="m.id" :value="`${g.id}:${m.id}`" :disabled="!g.available">
                    {{ m.name }}
                  </option>
                </optgroup>
              </UiSelect>
            </div>
            <div v-if="companionEffortLevels.length || companionEffortLost" class="plugrow effort-row">
              <label for="companion-effort">Усилие</label>
              <UiSelect
                id="companion-effort"
                class="inp"
                data-context="settings-field"
                data-testid="companion-effort-select"
                :disabled="companionRunBusy"
                :model-value="companionRun.effort"
                @change="setCompanionEffort($event.target.value)"
              >
                <option value="">по умолчанию исполнителя</option>
                <!-- Уровень мог исчезнуть у модели после обновления CLI. Показываем его
                     прямо: перед ходом реестр такой уровень снимет, и человек должен
                     видеть, что выбор больше не действует. -->
                <option v-if="companionEffortLost" :value="companionEffortLost">
                  {{ companionEffortLost }} — нет у этой модели
                </option>
                <option v-for="e in companionEffortLevels" :key="e" :value="e">{{ e }}</option>
              </UiSelect>
            </div>
          </div>
          <p v-if="companionModelLost" class="msg warn" data-testid="companion-model-lost">
            Этой модели нет в реестре исполнителей — ход компаньона не уйдёт, пока выбор не сменят.
          </p>
          <p v-if="companionRunMsg" class="msg" :class="companionRunMsg.type">{{ companionRunMsg.text }}</p>
        </div>

        <div class="mode companion-audio-setting" data-testid="companion-audio-setting">
          <UiSwitch
            :model-value="companionTtsEnabled"
            @update:model-value="setCompanionTtsEnabled"
          >
            Озвучивать прямые голосовые ответы
          </UiSwitch>
          <p class="muted small">
            Выключено по умолчанию. Голос браузера или операционной системы может использовать
            внешний облачный сервис; ему передаётся только сокращённый текст ответа на ваш
            текущий голосовой запрос. Настройка хранится лишь на этом устройстве.
          </p>
          <p v-if="!companionOutputAvailable" class="msg warn" data-testid="companion-tts-unavailable">
            Этот браузер не предоставляет speechSynthesis — ответ останется текстом.
            Выбор сохранится на устройстве и применится, когда API станет доступен.
          </p>
          <div
            v-if="companion.ttsConsentPrompt"
            class="companion-tts-consent"
            role="group"
            aria-labelledby="settings-companion-tts-consent"
            data-testid="settings-companion-tts-consent"
          >
            <b id="settings-companion-tts-consent">Разрешить браузерную озвучку на этом устройстве?</b>
            <div class="row">
              <UiButton
                variant="solid"
                tone="accent"
                data-role="settings-action"
                @click="companion.confirmTtsConsent?.()"
              >
                Разрешить
              </UiButton>
              <UiButton
                data-role="settings-action"
                @click="companion.dismissTtsConsent?.()"
              >
                Не сейчас
              </UiButton>
            </div>
          </div>
          <div class="companion-audio-grid">
            <label>
              Голос
              <UiSelect
                class="settings-select"
                data-context="settings-field"
                data-testid="companion-voice-select"
                :model-value="companionOutputPrefs.voiceURI"
                @change="setCompanionOutputPref('voiceURI', $event.target.value)"
              >
                <option value="">Автоматически по языку</option>
                <option
                  v-for="voice in companionOutputVoices"
                  :key="voice.voiceURI"
                  :value="voice.voiceURI"
                >{{ voice.name || voice.voiceURI }}{{ voice.lang ? ` · ${voice.lang}` : '' }}</option>
              </UiSelect>
            </label>
            <label>
              Скорость · {{ Number(companionOutputPrefs.rate).toFixed(1) }}×
              <UiRange
                data-testid="companion-rate"
                :min="0.7"
                :max="1.3"
                :step="0.1"
                :model-value="Number(companionOutputPrefs.rate)"
                @input="setCompanionOutputPref('rate', Number($event.target.value))"
              />
            </label>
            <label>
              Громкость · {{ Math.round(Number(companionOutputPrefs.volume) * 100) }}%
              <UiRange
                data-testid="companion-volume"
                :min="0"
                :max="1"
                :step="0.05"
                :model-value="Number(companionOutputPrefs.volume)"
                @input="setCompanionOutputPref('volume', Number($event.target.value))"
              />
            </label>
          </div>
          <p class="muted small companion-window-mute">
            Быстрое выключение звука в окне компаньона действует только до закрытия этой вкладки
            и не меняет настройку устройства.
          </p>
        </div>
      </div>
    </section>

    <!-- Речь: настройка общая для окон, возможности браузера — фактические для этого устройства -->
    <section v-else-if="tab === 'speech'" data-testid="speech-settings">
      <div v-if="speechLoading" class="card muted">Загрузка настроек речи…</div>
      <template v-else>
        <div class="card">
          <div class="card-head">
            <div>
              <h3>Движок диктовки</h3>
              <p class="muted small">Выбор хранится на сервере и действует во всех окнах Cockpit.</p>
            </div>
            <span class="scope-pill">Все устройства</span>
          </div>
          <div class="speech-choice-grid">
            <div class="speech-choice" :class="{ active: speech.engine === 'browser' }">
              <UiRadio
                v-model="speech.engine"
                value="browser"
                data-testid="speech-engine-browser"
              >
                <span class="speech-choice-copy">
                  <b>Браузер</b>
                  <small>
                    Текст приходит по мере распознавания, если браузер отдаёт промежуточные
                    результаты.
                  </small>
                </span>
              </UiRadio>
            </div>
            <div class="speech-choice" :class="{ active: speech.engine === 'whisper' }">
              <UiRadio
                v-model="speech.engine"
                value="whisper"
                data-testid="speech-engine-whisper"
              >
                <span class="speech-choice-copy">
                  <b>Whisper</b>
                  <small>
                    Запись уходит только на сервер Cockpit и распознаётся локальной моделью.
                  </small>
                </span>
              </UiRadio>
            </div>
          </div>

          <template v-if="speech.engine === 'browser'">
            <div class="speech-subhead">Обработка браузером</div>
            <div class="speech-choice-grid">
              <div class="speech-choice" :class="{ active: speech.browserProcessing === 'auto' }">
                <UiRadio
                  v-model="speech.browserProcessing"
                  value="auto"
                  data-testid="speech-processing-auto"
                >
                  <span class="speech-choice-copy">
                    <b>На усмотрение браузера</b>
                    <small>
                      Может выполняться на устройстве или удалённым сервисом браузера.
                    </small>
                  </span>
                </UiRadio>
              </div>
              <div class="speech-choice" :class="{ active: speech.browserProcessing === 'local' }">
                <UiRadio
                  v-model="speech.browserProcessing"
                  value="local"
                  data-testid="speech-processing-local"
                >
                  <span class="speech-choice-copy">
                    <b>Только на устройстве</b>
                    <small>
                      Ставит <code>processLocally=true</code>; в облако молча не переключается.
                    </small>
                  </span>
                </UiRadio>
              </div>
            </div>
            <p v-if="speech.browserProcessing === 'auto'" class="msg warn" data-testid="speech-cloud-warning">
              До первой записи Cockpit отдельно попросит согласие: браузер может передать звук своему сервису.
              {{ speech.browserAutoConsent ? 'Согласие уже дано.' : 'Согласие ещё не дано.' }}
            </p>
            <p v-else-if="browserLocalBusy" class="muted small">Проверяю локальную модель этого браузера…</p>
          </template>
        </div>

        <div class="card" data-testid="speech-quality">
          <div class="card-head">
            <div>
              <h3>Качество Whisper</h3>
              <p class="muted small">Пресет задаёт модель и ширину поиска; ручные override имеют приоритет.</p>
            </div>
          </div>
          <div class="speech-quality-block">
            <b>Короткая диктовка</b>
            <div class="speech-quality-grid">
              <div v-for="preset in SPEECH_QUALITIES" :key="`dictation:${preset.id}`"
                   class="speech-quality" :class="{ active: speech.quality === preset.id }">
                <UiRadio
                  v-model="speech.quality"
                  :value="preset.id"
                  :data-testid="`speech-quality-${preset.id}`"
                >
                  <span class="speech-quality-copy">
                    <b>{{ preset.label }}</b>
                    <small>{{ preset.model }} · beam {{ preset.beam }}</small>
                    <small>{{ preset.hint }}</small>
                  </span>
                </UiRadio>
              </div>
            </div>
            <p v-if="speech.model" class="msg info">Пресет {{ SPEECH_QUALITIES.find((item) => item.id === speech.quality)?.label }},
              но модель переопределена вручну: {{ speechModelLabel(speech.model) }}.</p>
          </div>
          <div class="speech-quality-block">
            <b>Разбор видео</b>
            <div class="speech-quality-grid">
              <div v-for="preset in SPEECH_QUALITIES" :key="`video:${preset.id}`"
                   class="speech-quality" :class="{ active: speech.videoQuality === preset.id }">
                <UiRadio
                  v-model="speech.videoQuality"
                  :value="preset.id"
                  :data-testid="`speech-video-quality-${preset.id}`"
                >
                  <span class="speech-quality-copy">
                    <b>{{ preset.label }}</b>
                    <small>{{ preset.model }}</small>
                    <small>{{ preset.hint }}</small>
                  </span>
                </UiRadio>
              </div>
            </div>
            <p v-if="speech.videoModel" class="msg info">Модель видео переопределена: {{ speechModelLabel(speech.videoModel) }}.</p>
            <label class="speech-field">Стилевая подсказка
              <UiTextarea
                v-model="speech.videoInitialPrompt"
                rows="3"
                maxlength="600"
                data-role="settings-textarea"
                data-testid="speech-video-prompt"
                placeholder="Пусто — расшифровка выйдет сплошным потоком без знаков препинания"
              />
            </label>
            <div class="speech-field-actions">
              <UiButton
                data-role="settings-action"
                data-testid="speech-video-prompt-reset"
                @click="resetVideoInitialPrompt"
              >
                Вернуть стандартную
              </UiButton>
              <span class="muted small">{{ [...(speech.videoInitialPrompt || '')].length }} / 600 символов</span>
            </div>
            <p class="muted small">
              Задаёт стиль первому окну распознавания: с подсказкой модель ставит знаки препинания,
              без неё выдаёт сплошной поток слов до конца записи. Пишите <b>короткий заголовок</b>
              («Стенограмма рабочей встречи.»), а не указание модели: подсказку она считает уже
              сказанным текстом и продолжает его — из фразы «реплики записаны с пунктуацией»
              получается расшифровка, где эта фраза повторяется вместо разговора. Это не словарь
              терминов, для них есть поле ниже.
            </p>
          </div>
          <UiDisclosureButton
            v-model:open="speechAdvanced"
            class="speech-advanced-toggle"
            controls="speech-advanced-panel"
            data-role="settings-disclosure"
            data-testid="speech-advanced-toggle"
          >
            {{ speechAdvanced ? 'Скрыть продвинутые' : 'Показать продвинутые' }}
          </UiDisclosureButton>
          <div
            v-if="speechAdvanced"
            id="speech-advanced-panel"
            class="speech-advanced"
            data-testid="speech-advanced"
          >
            <label>Модель диктовки
              <UiSelect
                class="speech-select"
                data-context="settings-field"
                :model-value="speech.model || ''"
                @change="speech.model = $event.target.value || null"
              >
                <option value="">Как в пресете ({{ speechModelLabel(QUALITY_MODELS[speech.quality]) }})</option>
                <option v-for="model in SPEECH_MODELS" :key="model.id" :value="model.id">{{ model.label }}</option>
              </UiSelect>
            </label>
            <label>Модель видео
              <UiSelect
                class="speech-select"
                data-context="settings-field"
                :model-value="speech.videoModel || ''"
                @change="speech.videoModel = $event.target.value || null"
              >
                <option value="">Как в пресете ({{ speechModelLabel(QUALITY_MODELS[speech.videoQuality]) }})</option>
                <option v-for="model in SPEECH_MODELS" :key="model.id" :value="model.id">{{ model.label }}</option>
              </UiSelect>
            </label>
            <label>Устройство для обоих сценариев
              <UiSelect
                v-model="speech.device"
                class="speech-select"
                data-context="settings-field"
                data-testid="speech-device"
              >
                <option value="auto">Авто — GPU с CPU-fallback</option>
                <option value="cpu">CPU</option>
                <option value="cuda" :disabled="!cudaReady">CUDA / NVIDIA GPU{{ cudaReady ? '' : ' — недоступно' }}</option>
              </UiSelect>
            </label>
            <label>Compute type
              <UiSelect
                class="speech-select"
                data-context="settings-field"
                :model-value="speech.computeType || ''"
                @change="speech.computeType = $event.target.value || null"
              >
                <option value="">По устройству (CPU int8 / CUDA float16)</option>
                <option value="int8">int8</option>
                <option value="int8_float16">int8_float16</option>
                <option value="float16">float16</option>
                <option value="float32">float32</option>
              </UiSelect>
            </label>
            <label>Beam size диктовки
              <UiNumberInput
                :min="1"
                :max="10"
                :model-value="speech.beamSize ?? ''"
                data-context="settings-field"
                placeholder="Как в пресете"
                @input="setNullableInteger('beamSize', $event.target.value, 1, 10)"
              />
            </label>
            <label>Пауза VAD, мс
              <UiNumberInput
                v-model="speech.vadSilenceMs"
                :min="100"
                :max="5000"
                :step="100"
                data-context="settings-field"
              />
            </label>
            <div class="speech-check">
              <UiCheckbox v-model="speech.conditionOnPreviousText">
                <span class="speech-check-copy">
                  <b>Учитывать предыдущий текст</b>
                  <small>
                    Помогает связности, но может повторять ошибку из прежнего фрагмента.
                  </small>
                </span>
              </UiCheckbox>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <h3>Язык и термины</h3>
              <p class="muted small">Один словарь используется Whisper и браузером, когда тот поддерживает contextual biasing.</p>
            </div>
          </div>
          <label class="speech-field">Язык
            <UiSelect
              v-model="speech.language"
              class="speech-select"
              data-context="settings-field"
            >
              <option value="auto">Как язык интерфейса / авто для Whisper</option>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </UiSelect>
          </label>
          <label class="speech-field">Термины проекта
            <UiTextarea
              v-model="speech.dictionary"
              rows="6"
              maxlength="800"
              data-role="settings-textarea"
              data-testid="speech-dictionary"
              placeholder="По одному термину или фразе на строку&#10;Fastify&#10;worktree&#10;Битрикс24"
            />
          </label>
          <div class="speech-field-actions">
            <UiButton
              data-role="settings-action"
              data-testid="speech-dictionary-template"
              @click="fillCockpitDictionary"
            >
              Подставить термины кокпита
            </UiButton>
            <span class="muted small">{{ [...speech.dictionary].length }} / 800 символов</span>
          </div>
          <p class="muted small">
            В браузере список применяется только при наличии <code>SpeechRecognitionPhrase</code>;
            неподдерживаемый словарь не ломает диктовку — запуск повторяется без него.
          </p>
          <p v-if="speechCapabilities.lastDictionaryMeasure" class="msg info">
            Последний замер словаря:
            {{ speechCapabilities.lastDictionaryMeasure.hotwordsTokens ?? speechCapabilities.lastDictionaryMeasure.tokens ?? 'токены не сообщены' }}
            <template v-if="speechCapabilities.lastDictionaryMeasure.hotwordsTruncated || speechCapabilities.lastDictionaryMeasure.truncated"> · обрезан моделью</template>
          </p>
        </div>

        <div class="card" data-testid="speech-models">
          <div class="card-head">
            <div>
              <h3>Локальные модели</h3>
              <p class="muted small">Первая диктовка ничего не скачивает: веса появляются только по явной кнопке.</p>
            </div>
          </div>
          <p v-if="!speechCapabilities.models.length" class="muted small">Сервер пока не сообщил каталог моделей.</p>
          <div v-else class="speech-model-list">
            <div v-for="model in speechCapabilities.models" :key="model.modelId" class="speech-model-row">
              <div class="speech-model-main">
                <b>{{ speechModelLabel(model.modelId) }}</b>
                <span class="muted small">{{ model.repo || model.modelId }}</span>
                <span class="speech-model-state" :class="model.cached ? 'ready' : 'missing'">
                  {{ model.cached ? `в кэше${formatModelSize(model.sizeMb) ? ` · ${formatModelSize(model.sizeMb)}` : ''}` : 'не скачана' }}
                </span>
              </div>
              <div class="speech-model-actions">
                <UiButton
                  data-role="settings-action"
                  :data-testid="`speech-download-${model.modelId}`"
                  :disabled="model.cached || speechJobActive(modelJob(model.modelId)) || speechStarting[`download:${model.modelId}`]"
                  @click="startSpeechJob('download', model.modelId)"
                >
                  {{ model.cached ? 'Скачана' : 'Скачать' }}
                </UiButton>
                <UiButton
                  v-if="!model.cached"
                  data-role="settings-action"
                  :data-testid="`speech-copy-${model.modelId}`"
                  :disabled="speechJobActive(modelJob(model.modelId)) || speechStarting[`copy:${model.modelId}`]"
                  @click="startSpeechJob('copy', model.modelId)"
                >
                  Скопировать из общего кэша
                </UiButton>
              </div>
              <div v-if="modelJob(model.modelId)" class="speech-job" :class="modelJob(model.modelId).status">
                <div>
                  <span>{{ modelJob(model.modelId).kind === 'copy' ? 'Копирование' : 'Скачивание' }}: {{ speechJobLabel(modelJob(model.modelId)) }}</span>
                  <UiButton
                    v-if="speechJobActive(modelJob(model.modelId))"
                    class="speech-cancel"
                    variant="ghost"
                    tone="danger"
                    data-role="settings-compact-action"
                    :data-testid="`speech-cancel-${model.modelId}`"
                    @click="cancelSpeechJob(modelJob(model.modelId))"
                  >
                    Отменить
                  </UiButton>
                </div>
                <progress v-if="speechJobPercent(modelJob(model.modelId)) !== null" max="100" :value="speechJobPercent(modelJob(model.modelId))"></progress>
                <small v-if="modelJob(model.modelId).progress?.file" class="muted">{{ modelJob(model.modelId).progress.file }}</small>
                <p v-if="modelJob(model.modelId).error" class="msg err">{{ modelJob(model.modelId).error.message }}</p>
              </div>
            </div>
          </div>
        </div>

        <div class="card" data-testid="speech-environment">
          <div class="card-head">
            <div>
              <h3>Окружение и замер</h3>
              <p class="muted small">Проверка идёт в том же media-venv и HF-кэше, которые использует транскрипция.</p>
            </div>
            <UiButton
              data-role="settings-action"
              data-testid="speech-refresh"
              :disabled="speechRefreshing"
              @click="refreshSpeechCapabilities"
            >
              {{ speechRefreshing ? 'Проверяю…' : 'Перепроверить' }}
            </UiButton>
          </div>
          <div class="speech-env-grid">
            <div>
              <b>Whisper</b>
              <p :class="speechCapabilities.local.ready ? 'msg ok' : 'msg warn'">
                {{ speechCapabilities.local.ready ? 'Готов' : (speechCapabilities.local.reason || 'Не готов') }}
              </p>
              <ul v-if="speechCapabilities.local.checks.length" class="speech-checks">
                <li v-for="check in speechCapabilities.local.checks" :key="check.name || check.id" :class="check.ok ? 'ok' : 'err'">
                  {{ check.name || check.id }}<span v-if="!check.ok && check.fix" class="muted"> — {{ check.fix }}</span>
                </li>
              </ul>
            </div>
            <div>
              <b>CUDA</b>
              <p :class="cudaReady ? 'msg ok' : 'msg warn'">{{ cudaReason }}</p>
              <p v-if="!cudaReady" class="muted small">Доустановить воспроизводимым способом: <code data-testid="speech-cuda-command">deploy/install.sh --with-cuda</code>
              </p>
            </div>
          </div>
          <div class="speech-benchmark">
            <div>
              <b>Замер на эталонной записи</b>
              <p class="muted small">Модель {{ speechModelLabel(effectiveDictationModel) }} ·
                {{ speech.device === 'auto' ? `auto → ${benchmarkDevice}` : benchmarkDevice }} · {{ benchmarkComputeType }}.</p>
            </div>
            <UiButton
              data-role="settings-action"
              data-testid="speech-benchmark"
              :disabled="speechJobActive(benchmarkJob()) || !benchmarkAvailable || (speech.device === 'cuda' && !cudaReady)"
              @click="startBenchmark"
            >
              Замерить
            </UiButton>
          </div>
          <p v-if="!benchmarkAvailable" class="msg warn" data-testid="speech-benchmark-unavailable">
            {{ benchmarkReason }} Укажи эталонный WAV через <code>COCKPIT_SPEECH_BENCHMARK_AUDIO</code>.
          </p>
          <div v-if="benchmarkJob()" class="speech-job" :class="benchmarkJob().status">
            <div>
              <span>Замер: {{ speechJobLabel(benchmarkJob()) }}</span>
              <UiButton
                v-if="speechJobActive(benchmarkJob())"
                class="speech-cancel"
                variant="ghost"
                tone="danger"
                data-role="settings-compact-action"
                data-testid="speech-benchmark-cancel"
                @click="cancelSpeechJob(benchmarkJob())"
              >
                Отменить
              </UiButton>
            </div>
            <progress v-if="speechJobPercent(benchmarkJob()) !== null" max="100" :value="speechJobPercent(benchmarkJob())"></progress>
            <p v-if="benchmarkJob().error" class="msg err">{{ benchmarkJob().error.message }}</p>
          </div>
          <p v-if="benchmarkResult" class="msg ok" data-testid="speech-benchmark-result">{{ benchmarkText(benchmarkResult) }}</p>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <h3>Фактический путь</h3>
              <p class="muted small">Серверный выбор может быть недоступен в конкретном браузере.</p>
            </div>
            <span class="status-pill" :class="speechEffective.startsWith('Недоступно') ? 'danger' : 'ok'">
              <span class="dot"></span>{{ speechEffective.startsWith('Недоступно') ? 'Недоступно' : 'Готово' }}
            </span>
          </div>
          <p data-testid="speech-effective"><b>Выбрано:</b> {{ speech.engine === 'browser' ? 'браузер' : 'Whisper' }}</p>
          <p><b>На этом устройстве:</b> {{ speechEffective }}</p>
          <p v-if="speech.engine === 'browser' && browserSpeechReason" class="msg warn">{{ browserSpeechReason }}</p>
          <p v-if="!speech.local.ready && speech.local.reason" class="muted small">Whisper: {{ speech.local.reason }}</p>
          <p class="muted small">Диктовка: {{ speechModelLabel(effectiveDictationModel) }} · видео: {{ speechModelLabel(effectiveVideoModel) }}.</p>
          <div class="row">
            <UiButton
              variant="solid"
              tone="accent"
              data-role="settings-action"
              :disabled="speechSaving"
              data-testid="speech-save"
              @click="saveSpeech"
            >
              {{ speechSaving ? 'Сохраняю…' : 'Сохранить' }}
            </UiButton>
          </div>
          <p v-if="speechMsg" class="msg" :class="speechMsg.type">{{ speechMsg.text }}</p>
        </div>
      </template>
    </section>

    <!-- Битрикс24 -->
    <section v-else-if="tab === 'b24'">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Подключение к порталу</h3>
            <p class="muted small">Учётные данные хранятся только на сервере и не попадают в git.</p>
          </div>
          <span class="status-pill" :class="configured ? 'ok' : 'neutral'">
            <span class="dot"></span>{{ configured ? 'Настроено' : 'Не настроено' }}
          </span>
        </div>
        <div class="form-grid">
          <label class="full">Портал
            <UiInput
              v-model="form.baseUrl"
              data-context="settings-field"
              placeholder="https://ваш-портал.bitrix24.ru"
            />
          </label>
          <label>Логин
            <UiInput
              v-model="form.login"
              data-context="settings-field"
              autocomplete="username"
              placeholder="user@example.com"
            />
          </label>
          <label>Пароль
            <UiInput
              v-model="form.password"
              type="password"
              data-context="settings-field"
              autocomplete="current-password"
              :placeholder="configured ? '•••••• (задан, введите новый для замены)' : 'пароль портала'"
            />
          </label>
        </div>
        <div class="row">
          <UiButton
            variant="solid"
            tone="accent"
            data-role="settings-action"
            :disabled="saving || !form.login || !form.password"
            @click="save"
          >
            {{ saving ? 'Сохранение…' : 'Сохранить' }}
          </UiButton>
          <UiButton
            data-role="settings-action"
            :disabled="testing || !configured"
            @click="testAuth"
          >
            {{ testing ? 'Проверка…' : 'Проверить авторизацию' }}
          </UiButton>
        </div>
        <p v-if="msg" class="msg" :class="msg.type">{{ msg.text }}</p>
      </div>
    </section>

    <!-- Исполнители: реестр LLM-агентов (/api/providers) -->
    <section v-else-if="tab === 'providers'">
      <!-- Плашка на исполнителя, плашки — горизонтальной линией: у каждого ИИ свои
           ручки, и мешать их в один список нельзя. -->
      <div v-if="!prov.loaded" class="card muted">Загрузка…</div>
      <div v-else class="pvcards">
        <div v-for="p in prov.providers" :key="p.id" class="card pvcard">
          <div class="pvhead">
            <span class="pvicon" :style="{ color: p.available ? p.color : 'var(--ink-mid)' }">
              <ProviderIcon :provider="p" :size="20" />
            </span>
            <div class="pvtitle">
              <!-- Состояние версии CLI — точка у имени, а не строка в фактах: строка
                   появлялась только у отставшего исполнителя и сдвигала вниз всё, что
                   под ней, в одной карточке ряда. Текст живёт в тултипе. -->
              <div class="pvname">
                {{ p.name }}
                <UiTooltip v-if="updateHint(p)" :text="updateHint(p)" placement="top-start">
                  <span
                    class="pvupddot"
                    :class="{ hot: p.updateAvailable }"
                    data-testid="provider-update-dot"
                  ></span>
                </UiTooltip>
              </div>
              <div class="pvsub muted">{{ p.vendor }} · {{ p.kind }}</div>
            </div>
            <span class="pvstate" :class="p.available ? 'ok' : 'err'">
              <span class="dot"></span>{{ p.available ? 'доступен' : 'недоступен' }}
            </span>
          </div>
          <div class="pvfacts">
            <div class="pvsub muted">{{ p.authLabel }}<template v-if="p.version"> · {{ p.version }}</template></div>
            <div v-if="p.chatEnabled === false" class="pvsub pvsoon">
              Установка доступна; подключение к чатам пока не включено.
            </div>
            <div v-if="p.models?.length" class="pvsub muted">
              моделей в каталоге: {{ p.models.length }}<template v-if="hiddenCount(p)"> (в выборе {{ p.models.length - hiddenCount(p) }} — остальные скрыты)</template><template v-if="p.models.some((m) => m.unknown)"> · есть неизвестные CLI (помечены «?»)</template>
            </div>
          </div>
          <div v-if="!p.available && (p.setupCommand || p.install)" class="pvinstall">
            {{ p.installed ? 'Авторизация' : 'Установка' }}:
            <UiCommandButton
              data-role="settings-command"
              title="Кликни — откроется терминал с введённой командой"
              @click="installInTerminal(p)"
            >
              {{ p.setupCommand || p.install }}
            </UiCommandButton>
          </div>
          <!-- Свои настройки исполнителя. Список объявляет сам executor (поле settings),
               фронт про вендоров не знает и рисует по kind; выбор сохраняется в prefs. -->
          <div class="pvset pvsettings" data-testid="provider-settings-slot">
            <div class="pvsetttl">Настройки исполнителя</div>
            <!-- Своего tabindex тут нет намеренно: внутри живые ручки, и до нижних
                 клавиатура доезжает табом по ним, а лишняя остановка на контейнере
                 только удлиняет путь. У списка MCP фокусировать нечего — там он нужен. -->
            <div class="pvsetbody">
              <template v-if="p.settings?.length">
                <div v-for="s in p.settings" :key="s.id" class="pvsetrow">
                  <div class="pvsetline">
                    <UiSwitch
                      v-if="s.kind === 'toggle'"
                      :model-value="!!s.value"
                      :disabled="s.disabled === true || providerSettingBusy(p, s)"
                      @update:model-value="(v) => saveProviderSetting(p, s, v)"
                    >
                      {{ s.label }}
                    </UiSwitch>
                    <!-- Ползунок (num_ctx у Ollama): потолок вычисляет исполнитель.
                         Без валидного max падаем обратно в числовой инпут ниже. -->
                    <template v-else-if="s.kind === 'range' && Number(s.max) > Number(s.min)">
                      <span class="pvsetlbl">{{ s.label }}</span>
                      <UiRange
                        class="pvsetrange"
                        :min="Number(s.min)"
                        :max="Number(s.max)"
                        :step="Number(s.step || 1)"
                        :model-value="Number(s.value)"
                        :disabled="s.disabled === true || providerSettingBusy(p, s)"
                        @change="(e) => saveProviderSetting(p, s, Number(e.target.value))"
                      />
                      <span class="pvrangeval">{{ Number(s.value).toLocaleString('ru') }} / {{ Number(s.max).toLocaleString('ru') }}</span>
                    </template>
                    <template v-else-if="s.kind === 'text' || s.kind === 'number' || s.kind === 'range'">
                      <span class="pvsetlbl">{{ s.label }}</span>
                      <UiInput
                        v-if="s.kind === 'text'"
                        class="pvsetinput"
                        data-context="settings-field"
                        :model-value="String(s.value ?? '')"
                        :disabled="s.disabled === true || providerSettingBusy(p, s)"
                        @keydown.enter.prevent="(e) => { commitProviderSetting(p, s, e); e.target.blur(); }"
                        @blur="(e) => commitProviderSetting(p, s, e)"
                      />
                      <UiNumberInput
                        v-else
                        class="pvsetinput"
                        data-context="settings-field"
                        :min="Number(s.min) || 512"
                        :model-value="Number(s.value)"
                        :disabled="s.disabled === true || providerSettingBusy(p, s)"
                        @keydown.enter.prevent="(e) => { commitProviderSetting(p, s, e); e.target.blur(); }"
                        @blur="(e) => commitProviderSetting(p, s, e)"
                      />
                    </template>
                    <span v-else class="pvsetlbl">{{ s.label }}</span>
                    <span v-if="s.note" class="pvsoon">{{ s.note }}</span>
                  </div>
                  <div v-if="s.hint" class="muted small">{{ s.hint }}</div>
                  <p v-if="setMsg[`${p.id}:${s.id}`]" class="msg err">{{ setMsg[`${p.id}:${s.id}`] }}</p>
                </div>
              </template>
              <p v-else class="muted small">Своих настроек у этого исполнителя пока нет.</p>
            </div>
          </div>
          <!-- Ресурсы исполнителя (доплата, кредиты, загруженные модели): ЕДИНСТВЕННОЕ
               место, где их МЕНЯЮТ. Всплывашка топбара те же ресурсы только показывает —
               там человек смотрит на состояние, а не правит деньги аккаунта между делом. -->
          <div
            v-if="usageResourcesOf(p).length"
            class="pvset pvusage"
            data-testid="provider-usage-slot"
            :data-provider-id="p.id"
          >
            <div class="pvsetttl">Ресурсы исполнителя</div>
            <div class="pvsetbody">
              <ProviderUsageResources :provider-id="p.id" :resources="usageResourcesOf(p)" />
            </div>
          </div>
          <!-- Блок есть только у того, кто о MCP вообще сообщает: пустая рамка на
               карточке без этого понятия — не «стабильная сетка», а мусор. Высота
               задана, а не ограничена сверху: место под список занято ещё до ответа
               CLI, поэтому пришедший список не сдвигает ни кнопку, ни соседний блок. -->
          <div
            v-if="p.mcp && p.installed"
            class="pvset pvmcp provider-mcp-slot"
            :data-provider-id="p.id"
          >
            <div class="pvsetttl">
              MCP-серверы
              <UiButton
                class="mcpbtn"
                data-role="settings-compact-action"
                :disabled="mcpOf(p)?.loading"
                @click="loadMcpFor(p, true)"
              >
                {{ mcpOf(p)?.loading ? 'Обновляем…' : 'Обновить' }}
              </UiButton>
            </div>
            <div
              class="mcpbody"
              tabindex="0"
              :aria-label="`MCP-серверы ${p.name}`"
              aria-live="polite"
            >
              <p
                v-if="!mcpOf(p) || (mcpOf(p).loading && !mcpOf(p).servers)"
                class="muted small"
              >
                Получаем список от исполнителя…
              </p>
              <p v-else-if="mcpOf(p).state === 'error'" class="msg err">
                Не удалось получить список: {{ mcpOf(p).error }}
              </p>
              <template v-else>
                <p v-if="mcpOf(p).note" class="mcpnote muted small">{{ mcpOf(p).note }}</p>
                <div v-for="g in mcpGroups(p)" :key="g.id" class="mcpgrp">
                  <div class="mcpgrpttl muted">{{ g.label }} ({{ g.servers.length }})</div>
                  <div v-if="g.hint" class="mcpgrphint muted">{{ g.hint }}</div>
                  <div v-for="s in g.servers" :key="s.name" class="mcprow">
                    <div class="mcpline">
                      <span class="mcpdot" :class="mcpState(s).cls"></span>
                      <span class="mcpname" :title="s.target || undefined">{{ s.name }}</span>
                      <span class="mcpst" :class="mcpState(s).cls">{{ mcpState(s).label }}</span>
                    </div>
                    <!-- Причина/подсказка принадлежит адаптеру, поэтому Vue не знает CLI. -->
                    <div v-if="s.state !== 'ok' && s.detail" class="mcpdetail muted">
                      {{ s.detail }}
                    </div>
                    <div v-if="s.hint" class="mcpdetail muted">{{ s.hint }}</div>
                  </div>
                </div>
                <p v-if="!mcpGroups(p).length" class="muted small">Серверов не настроено.</p>
                <p v-if="mcpOf(p).checkedAt" class="muted small">
                  обновлено {{ new Date(mcpOf(p).checkedAt).toLocaleTimeString('ru') }}
                </p>
              </template>
            </div>
          </div>
          <!-- Итог обновления живёт у своей кнопки, в самом низу карточки. Над
               блоками фиксированной высоты ему места нет: строка появляется по нажатию
               и сдвинула бы вниз и настройки, и MCP — ровно в той карточке, где жмут. -->
          <div class="pvfoot">
            <p
              v-if="updMsg[p.id]"
              class="msg pvfootmsg"
              :class="updMsg[p.id].type"
              data-testid="provider-update-result"
            >{{ updMsg[p.id].text }}</p>
            <UiButton
              v-if="p.installed && p.canUpdate"
              class="upd"
              :class="{ hot: p.updateAvailable }"
              data-role="settings-action"
              :disabled="!!updating"
              title="Обновить CLI исполнителя. После обновления каталог моделей перечитается."
              @click="updateProvider(p)"
            >
              {{ updating === p.id ? 'Обновление…' : 'Обновить' }}
            </UiButton>
          </div>
        </div>
      </div>
      <!-- Общее для всех исполнителей — отдельной карточкой под плашками -->
      <div class="card narrow">
        <div class="prow first">
          <UiSwitch
            :model-value="prefs?.showAllModels === true"
            @update:model-value="toggleShowAllModels"
          >
            Показывать все модели: скрытые и старые версии
          </UiSwitch>
          <div class="muted small">
            По умолчанию в выборе — актуальные модели из каталогов установленных исполнителей.
            Скрытые, устаревающие и старые версии доступны по этому флажку; дублирующие алиасы
            схлопываются с канонической моделью.
          </div>
          <p v-if="modelsMsg" class="msg" :class="modelsMsg.type">{{ modelsMsg.text }}</p>
        </div>
        <div class="row">
          <UiButton data-role="settings-action" :disabled="refreshing" @click="refreshProv">
            {{ refreshing ? 'Проверка…' : 'Перепроверить' }}
          </UiButton>
          <UiButton
            data-role="settings-action"
            :disabled="checking"
            title="Кокпит и сам проверяет раз в 6 часов; обновление никогда не запускается автоматически"
            @click="checkUpdates"
          >
            {{ checking ? 'Смотрю…' : 'Проверить обновления' }}
          </UiButton>
        </div>
        <p class="muted small">
          Новые версии проверяются автоматически раз в 6 часов (индикатор — точка на иконке
          исполнителя в шапке). Обновление ставится только по кнопке.
        </p>
      </div>
      <div class="card narrow">
        <div>
          <b>Доверенные каталоги</b>
          <p class="muted small trusted-copy">
            Дополнительные деревья, которые Cockpit открывает новым ходам исполнителей,
            поддерживающих эту настройку. Текущий каталог проекта доступен и без этого
            списка; корень <code>/</code> добавить нельзя.
          </p>
          <p v-if="!prov.loaded" class="muted small" data-testid="trusted-directory-providers">
            Определяю исполнителей по реестру…
          </p>
          <p v-else-if="trustedDirectoryProviderNames" class="muted small" data-testid="trusted-directory-providers">
            <b>Настройку применяют:</b> {{ trustedDirectoryProviderNames }}.
          </p>
          <p v-else class="muted small" data-testid="trusted-directory-providers">
            Сейчас ни один чат-исполнитель не применяет эту настройку.
          </p>
        </div>
        <div v-if="trustedDirectories.length" class="trusted-list">
          <div v-for="(directory, index) in trustedDirectories" :key="directory" class="trusted-item">
            <code :title="directory">{{ directory }}</code>
            <UiButton
              data-role="settings-compact-action"
              :disabled="trustedDirectoriesBusy"
              @click="removeTrustedDirectory(index)"
            >
              Убрать
            </UiButton>
          </div>
        </div>
        <p v-else class="muted small">Дополнительных каталогов пока нет.</p>
        <div class="trusted-add">
          <UiInput
            v-model="trustedDirectoryInput"
            data-context="settings-field"
            :disabled="trustedDirectoriesBusy"
            placeholder="/home/user/Workspace"
            aria-label="Абсолютный путь к доверенному каталогу"
            @keyup.enter="addTrustedDirectory"
          />
          <UiButton
            data-role="settings-action"
            :disabled="trustedDirectoriesBusy || !trustedDirectoryInput.trim()"
            @click="addTrustedDirectory"
          >
            Добавить
          </UiButton>
        </div>
        <div class="row">
          <UiButton
            variant="solid"
            tone="accent"
            data-role="settings-action"
            :disabled="trustedDirectoriesBusy"
            @click="applyTrustedDirectories"
          >
            {{ trustedDirectoriesBusy ? 'Сохраняю…' : 'Сохранить каталоги' }}
          </UiButton>
        </div>
        <p class="muted small">
          Настройка действует внутри Cockpit и не переписывает глобальные конфиги CLI.
          Режим подтверждений выбранного исполнителя продолжает действовать отдельно.
        </p>
        <p v-if="trustedDirectoriesMsg" class="msg" :class="trustedDirectoriesMsg.type">
          {{ trustedDirectoriesMsg.text }}
        </p>
      </div>
    </section>

    <!-- Запуски собраны как пульт: сначала правила, затем живое состояние и наблюдение.
         Связанная настройка остаётся рядом со своим эффектом, а не в общей длинной форме. -->
    <section v-else-if="tab === 'runs'" class="runs-section">
      <p
        v-if="prefsMsg"
        class="run-feedback msg"
        :class="prefsMsg.type"
        aria-live="polite"
      >
        {{ prefsMsg.text }}
      </p>

      <div class="runs-grid" data-testid="runs-rules-grid">
        <div class="card run-card">
          <div class="card-head">
            <div>
              <p class="run-kicker">Подготовка</p>
              <h3>Старт и восстановление</h3>
              <p class="muted small">Что Cockpit делает до и сразу после запуска фабрики.</p>
            </div>
          </div>

          <div v-if="!prefs" class="muted">Загрузка…</div>
          <div v-else class="run-option-list">
            <div class="run-option">
              <UiSwitch
                :model-value="prefs.gitRefreshBeforeRun"
                @update:model-value="toggleGitRefresh"
              >
                Обновлять репозитории перед запуском
              </UiSwitch>
              <p class="muted small">
                Всегда выполняется <code>git fetch</code>; <code>git pull --ff-only</code> —
                только для чистого master. Ветки задач и локальные правки не трогаются.
              </p>
            </div>
          </div>
        </div>

        <div class="card run-card">
          <div class="card-head">
            <div>
              <p class="run-kicker">Лимиты</p>
              <h3>Контекст агентов</h3>
              <p class="muted small">Раздельные пороги для разговора и рабочего этапа.</p>
            </div>
          </div>

          <div v-if="!prefs" class="muted">Загрузка…</div>
          <div v-else class="run-threshold-list">
            <div class="run-threshold">
              <div class="run-threshold-copy">
                <b>Чат с агентом</b>
                <p class="muted small">
                  Кольцо считает до меньшей границы: этого порога или 80% окна модели.
                </p>
              </div>
              <div class="run-value-control">
                <UiNumberField
                  v-model="compactWindow"
                  class="run-number"
                  :min="0"
                  :step="10000"
                  data-context="settings-field"
                  placeholder="0 — не вмешиваться"
                  aria-label="Порог сжатия контекста чата в токенах"
                />
                <span class="run-unit">токенов</span>
                <UiButton data-role="settings-action" @click="saveCompactWindow">
                  Сохранить
                </UiButton>
              </div>
            </div>

            <div class="run-threshold">
              <div class="run-threshold-copy">
                <b>Этап конвейера</b>
                <p class="muted small">
                  Порог действует для новых заходов; уже идущий этап доработает как есть.
                </p>
              </div>
              <div class="run-value-control">
                <UiNumberField
                  v-model="stageCompactWindow"
                  class="run-number"
                  :min="0"
                  :step="10000"
                  data-context="settings-field"
                  placeholder="0 — не вмешиваться"
                  aria-label="Порог сжатия контекста этапа в токенах"
                />
                <span class="run-unit">токенов</span>
                <UiButton data-role="settings-action" @click="saveStageCompactWindow">
                  Сохранить
                </UiButton>
              </div>
            </div>
          </div>

          <p class="run-card-note">
            <b>0</b> оставляет собственный порог CLI. Кэш и тариф в расчёт не входят.
          </p>
        </div>
      </div>

      <!-- Свободную живую сессию в `ps` не отличить от разового запуска. Настройка
           жизненного цикла и сам пул поэтому показаны одной цельной областью. -->
      <div class="card live-card" data-testid="runs-live-card">
        <div class="card-head">
          <div>
            <p class="run-kicker">Процессы чата</p>
            <h3>Живые агенты</h3>
            <p class="muted small">
              Память разговора, фоновые команды и MCP-серверы между сообщениями.
            </p>
          </div>
          <div class="live-head-actions">
            <UiButton
              data-role="settings-action"
              :disabled="liveBusy"
              @click="loadLiveSessions"
            >
              Обновить
            </UiButton>
            <UiButton
              data-role="settings-action"
              :disabled="liveBusy || !liveFreeCount"
              @click="closeFreeSessions"
            >
              Погасить свободные
            </UiButton>
          </div>
        </div>

        <div v-if="!prefs" class="muted">Настройка режима загружается…</div>
        <div v-else class="run-option live-mode">
          <UiSwitch
            :model-value="prefs.chatLiveSessions !== false"
            @update:model-value="toggleLiveSessions"
          >
            Держать агента чата живым между ходами
          </UiSwitch>
          <p class="muted small">
            Процесс переживает ответ, а Claude может сам сообщить о завершении фоновой работы.
            После простоя процесс гаснет, но следующий ход продолжает прежнюю сессию.
          </p>
        </div>

        <div v-if="!liveLoaded" class="live-empty muted">Загружаю процессы…</div>
        <template v-else>
          <div
            v-if="liveSessions.length"
            class="live-stats"
            aria-label="Сводка живых процессов"
          >
            <span><b>{{ liveSessions.length }}</b><small>в пуле</small></span>
            <span class="busy"><b>{{ liveRunningCount }}</b><small>ведут ход</small></span>
            <span><b>{{ liveFreeCount }}</b><small>свободны</small></span>
          </div>

          <div v-if="!liveSessions.length" class="live-empty">
            <b>Сейчас ни одного живого процесса</b>
            <p class="muted small">
              <template v-if="!liveEnabled">
                Режим выключен: процесс поднимается на каждое сообщение и умирает с ответом.
              </template>
              <template v-else>
                Первый ход в чате поднимет процесс; здесь он останется до простоя.
              </template>
            </p>
          </div>

          <ul v-else class="live-list">
            <li
              v-for="item in liveSessions"
              :key="item.chatKey"
              class="live-row"
              :class="{ 'is-running': item.running }"
            >
              <div class="live-line">
                <div class="live-identity">
                  <span
                    class="live-dot"
                    :class="item.running ? 'busy' : 'idle'"
                    aria-hidden="true"
                  ></span>
                  <div class="live-copy">
                    <span class="live-name" :title="item.chatKey">{{ liveTitle(item) }}</span>
                    <span class="live-run">{{ liveRunLabel(item) }}</span>
                  </div>
                </div>
                <div class="live-row-actions">
                  <UiButton
                    variant="ghost"
                    data-role="settings-action"
                    :disabled="liveBusy"
                    @click="openLiveChat(item)"
                  >
                    Открыть чат
                  </UiButton>
                  <UiButton
                    data-role="settings-action"
                    :disabled="liveBusy"
                    @click="closeLiveSession(item)"
                  >
                    Погасить
                  </UiButton>
                </div>
              </div>
              <div class="live-meta muted">
                <span class="live-detail">{{ liveDetail(item) }}</span>
                <code v-if="item.cwd" class="live-path" :title="item.cwd">{{ item.cwd }}</code>
              </div>
            </li>
          </ul>

          <p class="run-card-note live-footnote">
            Лимит пула — {{ liveLimits.maxSessions }}, автогашение — через
            {{ Math.round(liveLimits.idleMs / 60000) }} мин простоя. Погашение оставляет
            разговор на месте; идущий ход требует подтверждения и теряет незаписанную работу.
          </p>
        </template>

        <p v-if="liveMsg" class="msg" :class="liveMsg.type" aria-live="polite">
          {{ liveMsg.text }}
        </p>
      </div>

      <div class="card run-card run-observe-card">
        <div class="card-head">
          <div>
            <p class="run-kicker">Наблюдение</p>
            <h3>Сигналы и диагностика</h3>
            <p class="muted small">Когда позвать человека и сколько деталей оставить в журнале.</p>
          </div>
        </div>

        <div class="run-observe-grid">
          <div class="run-observe-item">
            <div class="run-threshold-copy">
              <b>Молчание хода</b>
              <p class="muted small">
                Cockpit только оповещает о тишине и никогда сам не останавливает работу.
              </p>
            </div>
            <div class="run-value-control">
              <UiNumberField
                v-model="silenceWindowMin"
                class="run-number"
                :min="0"
                :step="5"
                data-context="settings-field"
                placeholder="0 — не звать"
                aria-label="Порог молчания хода конвейера в минутах"
              />
              <span class="run-unit">мин</span>
              <UiButton data-role="settings-action" @click="saveSilenceWindow">
                Сохранить
              </UiButton>
            </div>
            <p class="run-subnote"><b>0</b> — не звать.</p>
          </div>

          <div class="run-observe-item">
            <div class="run-threshold-copy">
              <b>Логи фабрики</b>
              <p class="muted small">
                Выбор модели, переключение ИИ и ошибки runner-а без prompt и credentials.
              </p>
            </div>
            <div v-if="!factoryDebug && !factoryDebugMsg" class="muted">Загрузка…</div>
            <div v-else class="run-debug-control">
              <UiSelect
                class="run-select"
                data-context="settings-field"
                aria-label="Уровень диагностического логирования фабрики"
                :model-value="factoryDebug?.effective || 'off'"
                :disabled="factoryDebugBusy"
                @change="saveFactoryDebug($event.target.value)"
              >
                <option
                  v-for="level in FACTORY_DEBUG_LEVELS"
                  :key="level.value"
                  :value="level.value"
                >
                  {{ level.label }}
                </option>
              </UiSelect>
              <span v-if="factoryDebug" class="debug-effective">
                действует: <b>{{ factoryDebug.effective }}</b>
                <span class="muted"> · источник: {{ factoryDebug.source }}</span>
              </span>
            </div>
            <p class="run-subnote">Обязательный короткий audit сохраняется на любом уровне.</p>
          </div>
        </div>

        <p v-if="factoryDebugMsg" class="msg" :class="factoryDebugMsg.type">
          {{ factoryDebugMsg.text }}
        </p>
      </div>

      <!-- Арбитр типизированной остановки. Тумблер отдельно от модели намеренно: кнопка
           «разобрать и продолжить» в плашке затыка работает всегда, а тумблер решает
           только то, ходит ли арбитр САМ, без человека. -->
      <div class="card run-card" data-testid="arbiter-settings">
        <div class="card-head">
          <div>
            <p class="run-kicker">Автономия</p>
            <h3>Арбитр остановок</h3>
            <p class="muted small">
              Когда возвраты между узлами перестают давать прогресс, движок останавливает
              маршрут и зовёт человека. Арбитр разбирает такой тупик вместо него: читает
              оба вердикта, проверяет спорное в рабочем дереве и возвращает узел с
              указанием. Границу задачи он менять не вправе — такое решение отдаёт человеку.
            </p>
          </div>
        </div>

        <div class="mode" data-testid="arbiter-auto">
          <UiSwitch
            :model-value="arbiterRun.auto"
            :disabled="arbiterBusy"
            @update:model-value="setArbiterAuto"
          >
            Разбирать автоматически
          </UiSwitch>
          <p class="muted small">
            Выключено — арбитр работает только по кнопке в плашке затыка. Включённый снимает
            ночные стоянки: разбор идёт сам, не дожидаясь, пока человек подойдёт. Решение в
            любом случае помечено в журнале попытки как машинное.
          </p>
        </div>

        <div class="plug-model-grid" :class="{ solo: !arbiterEffortLevels.length && !arbiterEffortLost }">
          <div class="plugrow wide">
            <label for="arbiter-model">Модель</label>
            <UiSelect
              id="arbiter-model"
              class="inp"
              data-context="settings-field"
              data-testid="arbiter-model-select"
              :disabled="arbiterBusy"
              :model-value="arbiterModelValue"
              @change="setArbiterModel($event.target.value)"
            >
              <option value="">— не выбрана —</option>
              <option v-if="arbiterModelLost" :value="arbiterModelValue">
                {{ arbiterModelLost }} — нет в реестре
              </option>
              <optgroup v-for="g in modelGroups" :key="g.id"
                        :label="g.name + (g.available ? '' : ' — недоступен')">
                <option v-for="m in g.models" :key="m.id" :value="`${g.id}:${m.id}`" :disabled="!g.available">
                  {{ m.name }}
                </option>
              </optgroup>
            </UiSelect>
          </div>
          <div v-if="arbiterEffortLevels.length || arbiterEffortLost" class="plugrow effort-row">
            <label for="arbiter-effort">Усилие</label>
            <UiSelect
              id="arbiter-effort"
              class="inp"
              data-context="settings-field"
              :disabled="arbiterBusy"
              :model-value="arbiterRun.effort"
              @change="setArbiterEffort($event.target.value)"
            >
              <option value="">по умолчанию исполнителя</option>
              <option v-if="arbiterEffortLost" :value="arbiterEffortLost">
                {{ arbiterEffortLost }} — нет у этой модели
              </option>
              <option v-for="e in arbiterEffortLevels" :key="e" :value="e">{{ e }}</option>
            </UiSelect>
          </div>
        </div>
        <p v-if="!arbiterRun.modelRef" class="run-subnote">
          Без выбранной модели арбитр не работает ни по кнопке, ни сам.
        </p>
        <p v-if="arbiterMsg" class="msg" :class="arbiterMsg.type">{{ arbiterMsg.text }}</p>
      </div>
    </section>

    <!-- Плагины: отключаемые блоки кокпита. Системные — из коробки; пользовательские —
         папки plugins/<id>/ (plugin.json + server.js), подхватываются на старте сервера. -->
    <section v-else-if="tab === 'plugins'">
      <div v-if="!pluginsStore.loaded" class="plugin-loading muted">
        <UiSpinner decorative /> Загружаю плагины…
      </div>
      <template v-else>
        <div
          class="plugin-toolbar"
          :class="{ 'mobile-detail-hidden': pluginMobileDetailOpen }"
        >
          <UiSearchInput
            v-model="pluginQuery"
            class="plugin-search"
            aria-label="Поиск плагинов"
            placeholder="Найти плагин"
          />
          <div class="plugin-filter-group">
            <UiSegmentedControl
              v-model="pluginFilter"
              class="plugin-filter"
              :options="pluginFilterOptions"
              label="Состояние плагинов"
            />
            <UiToggleButton v-model="pluginConfigurableOnly">
              С параметрами {{ pluginStats.configurable }}
            </UiToggleButton>
            <UiToggleButton
              v-if="pluginStats.custom"
              v-model="pluginCustomOnly"
              aria-label="Только пользовательские плагины"
              title="Пользовательские плагины"
            >
              Свои {{ pluginStats.custom }}
            </UiToggleButton>
          </div>
        </div>

        <div
          v-if="visiblePlugins.length"
          class="plugin-browser"
          :class="{ 'mobile-detail-open': pluginMobileDetailOpen }"
        >
          <aside
            ref="pluginCatalog"
            class="card plugin-catalog"
            aria-label="Каталог плагинов"
          >
            <div class="plugin-catalog-head">
              <div>
                <span>Каталог</span>
                <b>{{ pluginCountLabel(visiblePlugins.length) }}</b>
              </div>
              <small v-if="pluginQuery">по запросу</small>
            </div>
            <div class="plugin-catalog-list">
              <UiSelectableRow
                v-for="p in visiblePlugins"
                :key="p.id"
                class="plugin-catalog-item"
                :data-plugin-id="p.id"
                :selected="selectedPluginId === p.id"
                @select="selectPlugin(p.id)"
              >
                <span class="plugin-catalog-content">
                  <span
                    class="plugicon plugin-catalog-icon"
                    :class="{ muted: !p.enabled }"
                    aria-hidden="true"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path :d="pluginIconPath(p)" />
                    </svg>
                  </span>
                  <span class="plugin-catalog-copy">
                    <span class="plugin-catalog-name">{{ p.name }}</span>
                    <span class="plugin-catalog-meta">
                      {{ p.settings.length ? settingCountLabel(p.settings.length) : 'без параметров' }}
                    </span>
                  </span>
                  <span class="plugin-catalog-state" :class="{ on: p.enabled }">
                    <i></i>{{ p.enabled ? 'вкл' : 'выкл' }}
                  </span>
                </span>
              </UiSelectableRow>
            </div>
          </aside>

          <div
            v-if="selectedPlugin"
            :key="selectedPlugin.id"
            ref="pluginDetail"
            class="card plugin-detail"
            :class="{ off: !selectedPlugin.enabled }"
            role="region"
            :aria-label="`Плагин ${selectedPlugin.name}`"
            tabindex="-1"
          >
            <UiButton
              class="plugin-mobile-back"
              variant="ghost"
              @click="closeMobilePlugin"
            >
              ← Все плагины
            </UiButton>
            <div class="plughead">
              <div class="plugidentity">
                <span class="plugicon" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.7"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path :d="pluginIconPath(selectedPlugin)" />
                  </svg>
                </span>
                <div class="plugtitle">
                  <div class="plugname">
                    <b>{{ selectedPlugin.name }}</b>
                    <span class="plugver">v{{ selectedPlugin.version }}</span>
                  </div>
                  <div class="plugmeta">
                    <span class="plugtag" :class="{ user: !selectedPlugin.system }">
                      {{ selectedPlugin.system ? 'системный' : 'пользовательский' }}
                    </span>
                    <span v-if="selectedPlugin.nav?.label" class="plugplace">
                      раздел «{{ selectedPlugin.nav.label }}»
                    </span>
                  </div>
                </div>
              </div>
              <div class="plug-switch" :class="{ on: selectedPlugin.enabled }">
                <span>{{ selectedPlugin.enabled ? 'Включён' : 'Выключен' }}</span>
                <UiSwitch
                  :model-value="selectedPlugin.enabled"
                  :disabled="plugToggleId === selectedPlugin.id"
                  :aria-label="`${selectedPlugin.enabled ? 'Выключить' : 'Включить'} ${selectedPlugin.name}`"
                  @update:model-value="(v) => togglePlugin(selectedPlugin, v)"
                />
              </div>
            </div>
            <p class="plugdesc">{{ selectedPlugin.description }}</p>
            <p v-if="selectedPlugin.needsRestart" class="plugrestart">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7" />
              </svg>
              Изменение состояния серверной части применится после рестарта Cockpit.
            </p>
            <div v-if="!selectedPlugin.enabled" class="plugin-detail-state">
              <span class="plugin-detail-state-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M8 11V8a4 4 0 0 1 8 0v3 M6 11h12v10H6z" />
                </svg>
              </span>
              <span>
                <b>Плагин выключен</b>
                <small>
                  {{ selectedPlugin.settings.length
                    ? 'Функции неактивны, но параметры можно подготовить заранее.'
                    : 'Включите его, чтобы использовать.' }}
                </small>
              </span>
            </div>
            <div
              v-if="selectedPlugin.enabled && !selectedPlugin.settings.length"
              class="plugin-detail-state ready"
            >
              <span class="plugin-detail-state-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M5 12l4 4L19 6" />
                </svg>
              </span>
              <span>
                <b>Готов к работе</b>
                <small>У этого плагина нет отдельных параметров.</small>
              </span>
            </div>
            <div v-if="selectedPlugin.settings.length" class="plugset">
              <div class="plugset-head">
                <div>
                  <span>Параметры</span>
                  <b>Настройки плагина</b>
                </div>
                <small>{{ settingCountLabel(selectedPlugin.settings.length) }}</small>
              </div>
              <template v-for="s in selectedPlugin.settings" :key="s.key">
                <div v-if="s.type === 'checkbox'" class="plugrow plugcheck">
                  <UiCheckbox v-model="selectedPlugin.values[s.key]">
                    <span class="plugcheck-copy">
                      <b>{{ s.label }}</b>
                      <small v-if="s.hint">{{ s.hint }}</small>
                    </span>
                  </UiCheckbox>
                </div>
                <template v-else>
                  <div
                    v-if="s.type === 'model'"
                    class="plug-model-grid"
                    :class="{
                      solo: !(pluginEffortLevels(selectedPlugin.values[s.key]).length
                        || pluginEffortLost(selectedPlugin, s.key)),
                    }"
                  >
                    <!-- Модель берётся из общего реестра исполнителей — того же, что
                         рисует селект в чате. Значение хранится парой «исполнитель +
                         модель»: у локальных исполнителей id сам бывает со слэшами и
                         двоеточиями (`hf.co/user/repo:tag`). -->
                    <div class="plugrow wide">
                      <label :for="pluginSettingId(selectedPlugin, s)">{{ s.label }}</label>
                      <UiSelect
                        :id="pluginSettingId(selectedPlugin, s)"
                        class="inp"
                        data-context="settings-field"
                        :aria-describedby="s.hint
                          ? pluginSettingId(selectedPlugin, s, 'hint') : undefined"
                        :model-value="pluginModelValue(selectedPlugin, s.key)"
                        @change="setPluginModel(selectedPlugin, s.key, $event.target.value)"
                      >
                        <option value="">— не выбрана —</option>
                        <!-- Выбор мог пропасть из каталога или перестать подходить задаче.
                             Молча показать «не выбрана» нельзя: сервер всё ещё пытается
                             ходить именно этой моделью. -->
                        <option
                          v-if="pluginModelUnavailable(selectedPlugin, s)"
                          :value="pluginModelValue(selectedPlugin, s.key)"
                          disabled
                        >
                          {{ pluginModelUnavailable(selectedPlugin, s) }}
                        </option>
                        <optgroup
                          v-for="g in pluginModelGroups(s)"
                          :key="g.id"
                          :label="g.name + (g.available ? '' : ' — недоступен')"
                        >
                          <option
                            v-for="m in g.models"
                            :key="m.id"
                            :value="`${g.id}:${m.id}`"
                            :disabled="!g.available"
                          >
                            {{ m.name }}
                          </option>
                        </optgroup>
                      </UiSelect>
                    </div>
                    <!-- Усилие — свойство запуска, а не модели. Поэтому контрол остаётся
                         отдельным, но визуально стоит с моделью в одной строке. -->
                    <div
                      v-if="pluginEffortLevels(selectedPlugin.values[s.key]).length
                        || pluginEffortLost(selectedPlugin, s.key)"
                      class="plugrow effort-row"
                    >
                      <label :for="pluginSettingId(selectedPlugin, s, 'effort')">
                        Усилие
                      </label>
                      <UiSelect
                        :id="pluginSettingId(selectedPlugin, s, 'effort')"
                        class="inp"
                        data-context="settings-field"
                        :model-value="selectedPlugin.values[s.key]?.effort || ''"
                        @change="setPluginEffort(selectedPlugin, s.key, $event.target.value)"
                      >
                        <option value="">по умолчанию исполнителя</option>
                        <!-- Устаревший уровень остаётся видимым: сервер снимет его и
                             пойдёт с умолчанием, что нельзя скрывать от человека. -->
                        <option
                          v-if="pluginEffortLost(selectedPlugin, s.key)"
                          :value="pluginEffortLost(selectedPlugin, s.key)"
                        >
                          {{ pluginEffortLost(selectedPlugin, s.key) }} — нет у этой модели
                        </option>
                        <option
                          v-for="e in pluginEffortLevels(selectedPlugin.values[s.key])"
                          :key="e"
                          :value="e"
                        >
                          {{ e }}
                        </option>
                      </UiSelect>
                    </div>
                  </div>
                  <div v-else class="plugrow">
                    <label :for="pluginSettingId(selectedPlugin, s)">{{ s.label }}</label>
                    <UiNumberInput
                      v-if="s.type === 'number'"
                      :id="pluginSettingId(selectedPlugin, s)"
                      v-model="selectedPlugin.values[s.key]"
                      class="inp"
                      data-context="settings-field"
                      :aria-describedby="s.hint
                        ? pluginSettingId(selectedPlugin, s, 'hint') : undefined"
                      :min="s.min"
                      :max="s.max"
                      :step="s.step"
                    />
                    <UiSelect
                      v-else-if="s.type === 'select'"
                      :id="pluginSettingId(selectedPlugin, s)"
                      v-model="selectedPlugin.values[s.key]"
                      class="inp"
                      data-context="settings-field"
                      :aria-describedby="s.hint
                        ? pluginSettingId(selectedPlugin, s, 'hint') : undefined"
                    >
                      <option v-for="o in s.options" :key="o" :value="o">{{ o }}</option>
                    </UiSelect>
                    <UiInput
                      v-else
                      :id="pluginSettingId(selectedPlugin, s)"
                      v-model="selectedPlugin.values[s.key]"
                      class="inp"
                      data-context="settings-field"
                      :aria-describedby="s.hint
                        ? pluginSettingId(selectedPlugin, s, 'hint') : undefined"
                    />
                  </div>
                  <p
                    v-if="s.hint"
                    :id="pluginSettingId(selectedPlugin, s, 'hint')"
                    class="muted small plughint"
                  >
                    {{ s.hint }}
                  </p>
                </template>
              </template>
              <UiButton
                class="btn plugin-save"
                :class="{ saved: plugMsg === selectedPlugin.id }"
                data-role="settings-action"
                :loading="plugSavingId === selectedPlugin.id"
                loading-label="Сохраняю настройки"
                @click="savePlugin(selectedPlugin)"
              >
                <svg
                  v-if="plugMsg === selectedPlugin.id"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 12l4 4L19 6" />
                </svg>
                {{ plugMsg === selectedPlugin.id ? 'Сохранено' : 'Сохранить' }}
              </UiButton>
              <span class="ui-visually-hidden" aria-live="polite">
                {{ plugMsg === selectedPlugin.id ? 'Настройки плагина сохранены.' : '' }}
              </span>
              <p
                v-if="plugError?.id === selectedPlugin.id"
                class="msg err"
                role="alert"
              >
                {{ plugError.text }}
              </p>
            </div>
          </div>
        </div>
        <div v-else class="card plugin-empty">
          <span class="plugin-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-4-4 M8.5 11h5" />
            </svg>
          </span>
          <div>
            <b>Плагины не найдены</b>
            <p class="muted small">Измените запрос или сбросьте выбранный фильтр.</p>
          </div>
          <UiButton variant="ghost" data-role="settings-action" @click="clearPluginFilters">
            Сбросить фильтры
          </UiButton>
        </div>

        <div
          class="plugin-guide"
          :class="{ 'mobile-detail-hidden': pluginMobileDetailOpen }"
        >
          <UiDisclosureButton
            v-model:open="pluginGuideOpen"
            controls="plugin-user-guide"
            density="compact"
          >
            Как добавить пользовательский плагин
          </UiDisclosureButton>
          <p v-if="pluginGuideOpen" id="plugin-user-guide" class="section-note">
            Пользовательский модуль — папка <code>plugins/&lt;id&gt;/</code> с
            <code>plugin.json</code>. Серверная часть подключается после рестарта Cockpit.
          </p>
        </div>
      </template>
    </section>

    <!-- Сервер: демон systemd, перезапуск для применения нового кода (плагины, правки сервера) -->
    <section v-else-if="tab === 'server'">
      <p class="section-note">
        Боевой режим — демон systemd: юнит ставится один раз командой <code>deploy/install.sh</code>,
        дальше сервер живёт сам (<code>Restart=always</code>, ждёт VPN, переживает перезагрузки).
        Локальный checkout и опубликованный релиз применяются разными явными действиями:
        ни одно из них не выполняет неявный <code>git pull</code> и не затирает WIP.
      </p>
      <div class="card cockpit-release-card">
        <div class="card-head">
          <div>
            <h3>Версия Cockpit</h3>
            <p class="muted small">Запущенный процесс, текущий checkout и стабильный канал релизов.</p>
          </div>
          <span v-if="cockpitStatus" class="status-pill"
                :class="cockpitJob?.status === 'failed' ? 'danger' : cockpitStatus.updateAvailable ? 'warn' : 'ok'">
            <span class="dot"></span>
            {{ cockpitJob?.status === 'failed' ? 'Ошибка применения' : cockpitStatus.updateAvailable ? 'Есть релиз' : 'Актуально' }}
          </span>
        </div>
        <div v-if="cockpitUpdate.loading && !cockpitStatus" class="muted">Читаю локальную версию…</div>
        <template v-else-if="cockpitStatus">
          <dl class="version-facts">
            <div>
              <dt>Запущено</dt>
              <dd><b>{{ cockpitStatus.running.version }}</b> · <code>{{ shortSha(cockpitStatus.running.sha) }}</code></dd>
            </div>
            <div>
              <dt>Checkout</dt>
              <dd>
                <b>{{ cockpitStatus.checkout.version }}</b> · <code>{{ shortSha(cockpitStatus.checkout.sha) }}</code>
                · {{ cockpitStatus.checkout.branch || 'detached HEAD' }}
                <span v-if="cockpitStatus.checkout.dirty" class="dirty-mark">dirty</span>
              </dd>
            </div>
            <div>
              <dt>Стабильный канал</dt>
              <dd v-if="cockpitStatus.latest">
                <b>{{ cockpitStatus.latest.tag }}</b> · <code>{{ shortSha(cockpitStatus.latest.sha) }}</code>
                <a v-if="cockpitStatus.latest.url" :href="cockpitStatus.latest.url" target="_blank" rel="noopener noreferrer">Что изменилось ↗</a>
              </dd>
              <dd v-else>релизы пока не найдены</dd>
            </div>
            <div>
              <dt>Последняя проверка</dt>
              <dd>{{ fmtChecked(cockpitStatus.checkedAt) }}</dd>
            </div>
            <div>
              <dt>Web-бандл</dt>
              <dd>
                {{ clientBuildVersion }} · <code>{{ shortSha(clientBuildSha) }}</code>
                <span v-if="clientBuildSha !== 'dev' && clientBuildSha !== cockpitStatus.running.sha" class="dirty-mark">
                  ожидает обновления PWA
                </span>
              </dd>
            </div>
          </dl>

          <p v-if="cockpitStatus.checkoutChanged" class="msg info">
            Checkout изменился после запуска сервера. Чтобы запущенный процесс и web-бандл
            соответствовали ему, примените локальные изменения.
          </p>
          <p v-if="cockpitStatus.checkError" class="msg warn">
            {{ cockpitStatus.checkError.message }} Последний успешный результат сохранён.
          </p>

          <div v-if="cockpitJob" class="update-job" :class="cockpitJob.status">
            <b>{{ UPDATE_STAGE_LABELS[cockpitJob.stage] || cockpitJob.stage }}</b>
            <span class="muted small">
              {{ cockpitJob.kind === 'update' ? `Релиз ${cockpitJob.targetTag}` : 'Локальный checkout' }}
              · {{ shortSha(cockpitJob.targetSha) }}
            </span>
            <p v-if="cockpitJob.error" class="msg err">{{ cockpitJob.error.message }}</p>
          </div>

          <div class="row update-actions">
            <UiButton
              data-role="settings-action"
              :disabled="cockpitUpdate.checking || cockpitUpdate.active"
              @click="cockpitUpdate.check"
            >
              {{ cockpitUpdate.checking ? 'Проверяю…' : 'Проверить обновления' }}
            </UiButton>
            <UiButton
              data-role="settings-action"
              :disabled="!cockpitStatus.canApplyCheckout || cockpitUpdate.actionBusy"
              @click="startCockpitAction('apply')"
            >
              Применить локальные изменения
            </UiButton>
            <UiButton
              v-if="cockpitStatus.latest"
              variant="solid"
              tone="accent"
              data-role="settings-action"
              :disabled="!cockpitStatus.canInstallRelease || cockpitUpdate.actionBusy"
              @click="startCockpitAction('update')"
            >
              Обновить до {{ cockpitStatus.latest.tag }}
            </UiButton>
          </div>

          <ul v-if="cockpitStatus.applyBlockReasons?.length" class="block-reasons">
            <li v-for="reason in cockpitStatus.applyBlockReasons" :key="`apply-${reason}`">
              Локальное применение: {{ blockReasonLabel(reason) }}
            </li>
          </ul>
          <ul v-if="cockpitStatus.installBlockReasons?.length" class="block-reasons">
            <li v-for="reason in cockpitStatus.installBlockReasons" :key="`install-${reason}`">
              Установка релиза: {{ blockReasonLabel(reason) }}
            </li>
          </ul>
          <p v-if="cockpitUpdate.error" class="msg err">{{ cockpitUpdate.error }}</p>
        </template>
        <p v-else class="msg err">Не удалось прочитать состояние версии Cockpit.</p>
      </div>
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Процесс Cockpit</h3>
            <p class="muted small">Перезапуск применяет свежий серверный код и состав плагинов.</p>
          </div>
          <span v-if="srv" class="status-pill" :class="srv.systemd ? 'ok' : 'warn'">
            <span class="dot"></span>{{ srv.systemd ? 'Под управлением systemd' : 'Ручной запуск' }}
          </span>
        </div>
        <div v-if="!srv" class="muted">Загрузка…</div>
        <template v-else>
          <p class="srvline">
            Режим: <b>{{ srv.systemd ? 'демон systemd' : 'запущен вручную' }}</b>
            <span class="muted"> · PID {{ srv.pid }} · работает {{ fmtUptime(srv.uptimeSec) }}</span>
          </p>
          <p v-if="!srv.systemd" class="muted small">
            Ручной запуск — режим разработки. Чтобы демон поднимался сам, один раз выполни
            <code>deploy/install.sh</code>. Режимы не смешивать: ручной экземпляр держит порт,
            и юнит будет падать в цикле.
          </p>
          <div class="row">
            <UiButton
              class="btn"
              data-role="settings-action"
              :disabled="restarting || rebuilding"
              @click="restartServer"
            >
              {{ restarting ? 'Перезапускаю… жду возвращения' : 'Перезапустить сервер' }}
            </UiButton>
            <UiButton
              class="btn"
              data-role="settings-action"
              :disabled="rebuilding || restarting"
              @click="rebuildWeb"
            >
              {{ rebuilding ? 'Собираю web-бандл…' : 'Пересобрать web-бандл' }}
            </UiButton>
          </div>
          <p class="muted small">Пересборка трогает только web: npm install + vite build из рабочего дерева, включая незакоммиченные правки. Без смены checkout и перезапуска сервера.</p>
          <p v-if="srvMsg" class="msg" :class="srvMsg.type">{{ srvMsg.text }}</p>
        </template>
      </div>
    </section>

    <!-- Доступ: вход в сам кокпит (один пользователь) -->
    <section v-else-if="tab === 'access'">
      <!-- Предупреждение только когда оно по делу: на localhost соединение и так не выходит
           за пределы машины, а за шлюзом браузер идёт по https. -->
      <p v-if="!auth.secure && !auth.isLocal" class="msg err">
        Текущее соединение без HTTPS — пароль передаётся открытым текстом. В карточке
        «В домашней сети» включи локальный HTTPS.
      </p>

      <!-- Сводка строится по фактическим путям, а не по двум неравноценным prefs-флагам:
           LAN без локального TLS остаётся доступен по HTTP, а шлюз вообще живёт отдельно. -->
      <div v-if="!prefs" class="card"><span class="muted">Загрузка способов подключения…</span></div>
      <AccessOverview
        v-else
        :local-https-enabled="prefs.accessLocalHttps === true"
        :local-https-busy="accessBusy === 'accessLocalHttps'"
        :local-message="accessMsg"
        :tls="tls"
        :tls-state="tlsState"
        :tls-error="tlsLoadError"
        :gateway-setup="gwSaved"
        :gateway-job="gwJob"
        :gateway-public-domain="gwPublicDomain"
        :gateway-checks="gwChecks"
        :gateway-state="gatewaySetupState"
        :gateway-error="gatewayLoadError"
        :active-details="activeAccessDetails"
        @set-local-https="setLocalHttpsMode"
        @reload-tls="loadTls"
        @toggle-details="toggleAccessDetails"
      />

      <!-- Учётная запись остаётся доступной независимо от того, раскрыт ли длинный мастер шлюза. -->
      <section class="access-account" aria-labelledby="access-account-title">
        <h3 id="access-account-title" class="sechead">Защита входа</h3>
        <div class="card">
          <div class="card-head">
            <div>
              <h3>Учётная запись</h3>
              <p class="muted small">Один пользователь Cockpit и его активные сессии.</p>
            </div>
            <span class="scope-pill">Сервер</span>
          </div>
          <p class="muted small">
            Пароль хранится хешем на сервере (<code>.state</code>, не в git) и в браузер не
            попадает — клиент получает только сессионную cookie.
          </p>
          <div class="form-grid">
            <label class="full">Логин
              <UiInput
                v-model="acc.login"
                data-context="settings-field"
                autocomplete="username"
                placeholder="необязательно"
              />
            </label>
            <label class="full">Текущий пароль
              <UiInput
                v-model="acc.currentPassword"
                type="password"
                data-context="settings-field"
                autocomplete="current-password"
              />
            </label>
            <label>Новый пароль
              <UiInput
                v-model="acc.password"
                type="password"
                data-context="settings-field"
                autocomplete="new-password"
                placeholder="минимум 8 символов"
              />
            </label>
            <label>Новый пароль ещё раз
              <UiInput
                v-model="acc.password2"
                type="password"
                data-context="settings-field"
                autocomplete="new-password"
              />
            </label>
          </div>
          <p class="muted small">
            Смена пароля разлогинивает все устройства — украденная cookie перестаёт работать.
            Текущее устройство останется в системе.
          </p>
          <div class="row">
            <UiButton
              variant="solid"
              tone="accent"
              data-role="settings-action"
              :disabled="accBusy || !acc.currentPassword || !acc.password"
              @click="saveAccount"
            >
              {{ accBusy ? 'Сохранение…' : 'Сменить пароль' }}
            </UiButton>
            <UiButton data-role="settings-action" @click="auth.doLogout()">Выйти</UiButton>
            <UiButton
              variant="ghost"
              tone="danger"
              data-role="settings-action"
              @click="logoutAll"
            >
              Выйти со всех устройств
            </UiButton>
          </div>
          <p v-if="accMsg" class="msg" :class="accMsg.type">{{ accMsg.text }}</p>
        </div>
      </section>

      <!-- Локальный HTTPS: свой корень + сертификат на адрес мозга -->
      <template v-if="tls?.source !== 'env' && activeAccessDetails === 'local'">
      <section
        id="local-https-settings"
        class="access-detail-region"
        role="region"
        aria-labelledby="local-https-settings-title"
        tabindex="-1"
      >
      <div class="access-detail-head">
      <h3 id="local-https-settings-title" class="sechead">Локальный HTTPS</h3>
      <p class="muted">
        Дома PWA не ставится без HTTPS: <code>navigator.serviceWorker</code> существует только
        в защищённом контексте, а сертификат на домашний адрес публичный центр не выпишет.
        Кокпит выпускает свой: корень ставится на устройства один раз, дальше всё как в интернете.
        Порт <code>{{ tls?.httpPort || 8140 }}</code> остаётся как был — по нему кокпит ходит
        сам с собой (фабрика, <code>bin/b24</code>, терминал с мозга).
      </p>
      </div>

      <!-- Ошибку показываем прямо здесь: до перезапуска сервера этих эндпоинтов ещё нет,
           и «Загрузка…» навсегда выглядела бы как зависший запрос. -->
      <div v-if="!tls" class="card">
        <span v-if="!tlsMsg" class="muted">Загрузка…</span>
        <template v-else>
          <p class="msg err">{{ tlsMsg.text }}</p>
          <p class="muted small">
            Если сервер ещё не перезапускался после обновления — перезапусти его на вкладке
            «Сервер»: раздел появится вместе с новыми эндпоинтами.
          </p>
        </template>
      </div>
      <template v-else>
        <p v-if="!tls.openssl" class="msg err">
          На машине нет <code>openssl</code> — выпустить сертификат нечем.
          Поставь его (<code>sudo apt install openssl</code>) и обнови страницу.
        </p>

        <div class="card">
          <p class="tlsline">
            Состояние:
            <b v-if="tls.https.up && tls.needsRestart" class="warn">
              работает с прежней конфигурацией на порту {{ tls.https.port }}
            </b>
            <b v-else-if="tls.https.up" class="ok">работает на порту {{ tls.https.port }}</b>
            <b v-else-if="tls.enabled" class="warn">выпущен, но не поднят</b>
            <b v-else class="off">выключен</b>
            <span v-if="tls.source === 'env'" class="muted"> · сертификат задан переменными окружения</span>
          </p>
          <p v-if="tls.https.error" class="msg err">{{ tls.https.error }}</p>
          <p v-if="tls.needsRestart" class="msg warn">
            Изменения вступят в силу после перезапуска сервера — сертификат читается один раз
            при старте. Кнопка на вкладке «Сервер».
          </p>

          <p v-if="tls.leaf.exists" class="muted small">
            Выписан на {{ tls.leaf.addresses.join(', ') }} ·
            действует до {{ new Date(tls.leaf.notAfter).toLocaleDateString('ru-RU') }}
            ({{ tls.leaf.daysLeft }} дн.)
            <template v-if="tls.ca.exists">
              · корень до {{ new Date(tls.ca.notAfter).toLocaleDateString('ru-RU') }}
            </template>
          </p>
          <p v-if="tls.missingAddresses.length" class="msg warn small">
            Адрес машины изменился: {{ tls.missingAddresses.join(', ') }} нет в сертификате.
            Перевыпусти — устройства при этом трогать не нужно, корень остаётся прежним.
          </p>

          <div class="tlsaddrs">
            <span class="muted small">Адреса, по которым будешь открывать кокпит:</span>
            <div v-for="a in tls.addresses" :key="a.address" class="tlsaddr">
              <UiCheckbox
                :checked="tlsPicked.includes(a.address)"
                @change="toggleTlsAddress(a.address, $event.target.checked)"
              />
              <code>{{ a.address }}</code><span class="muted small">{{ a.iface }}</span>
            </div>
            <p v-if="!tls.addresses.length" class="muted small">
              Сетевых адресов не видно — машина не в сети?
            </p>
          </div>

          <div class="row">
            <UiButton
              variant="solid"
              tone="accent"
              data-role="settings-action"
              :disabled="tlsBusy || !tlsPicked.length || !tls.openssl"
              @click="generateTls"
            >
              {{ tlsBusy ? 'Выпускаю…' : (tls.leaf.exists ? 'Перевыпустить сертификат' : 'Выпустить сертификат') }}
            </UiButton>
            <UiButton
              v-if="tls.enabled"
              variant="ghost"
              tone="danger"
              data-role="settings-action"
              :disabled="tlsBusy"
              @click="dropTlsCertificate"
            >
              Удалить сертификат
            </UiButton>
          </div>
          <p v-if="tlsMsg" class="msg" :class="tlsMsg.type">{{ tlsMsg.text }}</p>
        </div>

        <!-- Установка корня. QR ведёт на HTTP-адрес намеренно: он работает и до перезапуска,
             и после (http отдаёт корень даже клиентам из сети). Веди он на https — файл
             пришлось бы качать через то самое предупреждение, которое он и убирает. -->
        <div v-if="tls.ca.exists && tlsAddress()" class="card">
          <p class="tlsline"><b>Поставить корень на устройство</b></p>
          <div class="tlsqr">
            <img :src="`/api/settings/tls/ca.svg?address=${tlsAddress()}`" alt="QR со ссылкой на корневой сертификат" width="180" height="180" />
            <ol class="tlssteps small">
              <li>Наведи камеру планшета — откроется скачивание <code>cockpit-ca.crt</code>.</li>
              <li>Android: «Настройки → Безопасность → Шифрование → Установить сертификат →
                Сертификат ЦС». iOS/iPadOS: профиль установится сам, потом
                «Настройки → Основные → Об устройстве → Доверие сертификатам» — включить тумблер.</li>
              <li>Открой <code>{{ tlsUrl() || `https://${tlsAddress()}:8143` }}</code> — замок без предупреждений,
                и «Установить приложение» появится в меню браузера.</li>
            </ol>
          </div>
          <p class="muted small">
            На самом мозге ставить ничего не нужно: <code>http://localhost:{{ tls.httpPort || 8140 }}</code>
            и так защищённый контекст.
            <a :href="'/api/settings/tls/ca.crt'" download>Скачать корень файлом</a> ·
            отпечаток <code class="fp">{{ (tls.ca.fingerprint || '').slice(0, 29) }}…</code>
          </p>
        </div>
      </template>
      </section>
      </template>

      <!-- Шлюз: установка формой. Руками это два идемпотентных скрипта плюс reconciliation
           двух точных DNS-имён, которых ни один скрипт сделать не может. -->
      <template v-if="activeAccessDetails === 'gateway'">
      <section
        id="gateway-settings"
        class="access-detail-region"
        role="region"
        aria-labelledby="gateway-settings-title"
        tabindex="-1"
      >
      <div class="access-detail-head">
      <h3 id="gateway-settings-title" class="sechead">Доступ снаружи (VPS-шлюз)</h3>
      <p class="muted">
        Кокпит виден по публичному домену, а домашний адрес наружу не выставлен: с мозга на VPS
        идут два исходящих SSH-туннеля (один — кокпит, второй — стенды, чтобы трафик стендов не
        придавливал SSE и терминал). Схема не зависит ни от CGNAT, ни от смены сети.
      </p>
      <p class="section-note">
        Эта панель только настраивает и проверяет шлюз. Если её скрыть, уже установленные
        туннели, публичный домен и внешний доступ продолжат работать.
      </p>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Что настраиваем</h3>
            <p class="muted small">Выделенный поддомен и временный VPS, через который кокпит виден снаружи.</p>
          </div>
          <span v-if="gwSaved" class="status-pill ok"><i class="dot"></i>{{ gwSaved.domain }}</span>
        </div>
        <div class="form-grid">
          <label>Выделенный поддомен шлюза
            <UiInput
              v-model="gw.domain"
              data-context="settings-field"
              placeholder="cockpit.example.com"
              :disabled="gwRunning"
            />
          </label>
          <label>Адрес VPS (IPv4)
            <UiInput
              v-model="gw.gateway"
              data-context="settings-field"
              placeholder="203.0.113.10"
              :disabled="gwRunning"
            />
          </label>
          <label>Пользователь SSH
            <UiInput
              v-model="gw.sshUser"
              data-context="settings-field"
              placeholder="root"
              :disabled="gwRunning"
            />
          </label>
          <label>Порт SSH
            <UiNumberInput
              v-model="gw.sshPort"
              data-context="settings-field"
              :min="1"
              :max="65535"
              :disabled="gwRunning"
            />
          </label>
        </div>
        <p class="muted small">
          Стенды поедут на поддомены <code>p&lt;порт&gt;.{{ gw.domain || 'домен' }}</code>, поэтому
          Cockpit резервирует два точных имени: этот поддомен и <code>*</code>. При каждой
          установке они заново сверяются с адресом текущего VPS.
        </p>
      </div>

      <!-- Cloudflare опционален: у другого провайдера DNS записи заводятся руками, и шаг
           честно превращается в подсказку, а не в отказ установки. -->
      <div class="card">
        <div class="card-head">
          <div>
            <h3>DNS-записи</h3>
            <p class="muted small">Единственный шаг, который ни один скрипт не сделает сам.</p>
          </div>
        </div>
        <UiSwitch v-model="gw.useCloudflare" :disabled="gwRunning">
          Домен на Cloudflare — синхронизировать записи автоматически
        </UiSwitch>
        <template v-if="gw.useCloudflare">
          <div class="form-grid">
            <label class="full">API-токен Cloudflare
              <UiInput
                v-model="gw.cloudflareToken"
                data-context="settings-field"
                type="password"
                autocomplete="off"
                placeholder="токен с Zone:Read и DNS:Edit"
                :disabled="gwRunning"
              />
            </label>
          </div>
          <p class="muted small">
            Логин и пароль аккаунта тут не годятся: API Cloudflare ими не управляется вовсе
            (а с двухфакторной — тем более). Нужен токен: кабинет → My&nbsp;Profile →
            API&nbsp;Tokens → Create&nbsp;Token → шаблон «Edit zone DNS». В Permissions должны
            получиться ровно две строки: <code>Zone → Zone → Read</code> и
            <code>Zone → DNS → Edit</code>. Во второй строке средняя колонка — именно
            <b>DNS</b>, не Zone: похожее разрешение <code>Zone → Zone → Edit</code> не даёт
            права менять DNS и закончится отказом. В Zone&nbsp;Resources выбери Include →
            Specific&nbsp;zone → родительскую зону (для <code>cockpit.example.com</code>
            обычно <code>example.com</code>). Токен уходит на сервер только для сверки и
            установки, нигде не сохраняется.
          </p>
          <p class="muted small">
            Облако у записей будет <b>серым</b> (proxied выключен). Оранжевое — это уже прокси
            Cloudflare, а с ним возвращаются 100 секунд на ответ (рвёт долгий ход агента),
            100&nbsp;МБ на тело (рубит загрузку видео) и чужая терминация TLS.
          </p>
          <p class="muted small">
            Перед подтверждением Cockpit прочитает текущие записи и покажет изменения. У двух
            управляемых имён останется ровно по одной A-записи на текущий VPS; старые A,
            AAAA и CNAME удалятся. TXT, MX, CAA и вся остальная зона не затрагиваются.
          </p>
        </template>
        <p v-else class="muted small">
          Записи заведёшь сам в панели своего провайдера — установка их дождётся и назовёт,
          что именно нужно создать.
        </p>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Доступ к VPS</h3>
            <p class="muted small">Пароль уйдёт один раз — положить туда наш ключ. Нигде не сохраняется.</p>
          </div>
        </div>
        <div class="row">
          <UiButton
            data-role="settings-action"
            :disabled="gwBusy || gwRunning || !gw.gateway.trim()"
            @click="gwProbeHost"
          >
            Проверить сервер
          </UiButton>
          <span v-if="gwBusy && !gwProbe" class="muted small">стучимся…</span>
        </div>
        <template v-if="gwProbe">
          <p class="tlsline">Отпечаток ключа: <code class="fp">{{ gwProbe.fingerprint }}</code>
            <span class="muted small"> ({{ gwProbe.fingerprintType }})</span></p>
          <div class="tlsaddr">
            <UiCheckbox v-model="gwHostOk" :disabled="gwRunning">
              Тип и SHA256-отпечаток SSH-ключа совпали с данными хостера
            </UiCheckbox>
          </div>
          <p class="muted small">
            Это отпечаток ключа самого VPS (SSH host key), а не твоего ключа для входа.
            Ищи в панели хостера поле SSH host key/fingerprint. Если его там нет, открой
            встроенную веб-консоль/VNC хостера — не подключение по SSH — и выполни
            <code>for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done</code>.
            Найди строку того же типа и сравни всё значение <code>SHA256:…</code> посимвольно.
            При несовпадении не ставь галку: сначала проверь IP и не закончилась ли
            переустановка VPS. Без сверки пароль root может уйти чужому серверу посередине.
            Подтверждённый отпечаток запомнится, и при следующем изменении установка
            остановится сама.
          </p>
          <div v-if="gwNeedsPassword" class="form-grid">
            <label class="full">Пароль {{ gw.sshUser || 'root' }} на VPS
              <UiInput
                v-model="gw.sshPassword"
                data-context="settings-field"
                type="password"
                autocomplete="off"
                placeholder="пароль из письма хостера"
                :disabled="gwRunning"
              />
            </label>
          </div>
          <p v-else class="msg ok">Сервер уже пускает по нашему ключу — пароль не нужен.</p>
          <p v-if="gwNeedsPassword" class="muted small">
            Нужен ровно один раз: положить на сервер наш ключ туннеля. Дальше вход только по
            ключу, пароль никуда не сохраняется.
          </p>
        </template>
        <p v-else class="muted small">
          Сначала проверяем сервер — жив ли он и тот ли это сервер. Пароль спросим после.
        </p>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Мозг и сертификаты</h3>
            <p class="muted small">Всё необязательное: без этих полей установка тоже проходит.</p>
          </div>
        </div>
        <div class="form-grid">
          <label class="full">Пароль sudo на мозге (необязательно)
            <UiInput
              v-model="gw.sudoPassword"
              data-context="settings-field"
              type="password"
              autocomplete="off"
              placeholder="оставь пустым — дадим команду для терминала"
              :disabled="gwRunning"
            />
          </label>
          <label class="full">Почта для Let’s Encrypt (необязательно)
            <UiInput
              v-model="gw.acmeEmail"
              data-context="settings-field"
              placeholder="для писем об истечении сертификата"
              :disabled="gwRunning"
            />
          </label>
        </div>
        <UiSwitch v-model="gw.acmeStaging" :disabled="gwRunning">
          Тестовые сертификаты Let’s Encrypt (для проверки схемы)
        </UiSwitch>
        <p class="muted small">
          У Let’s Encrypt пять неудач на имя в час. Тестовый режим выдаёт недоверенный
          сертификат (браузер ругнётся), зато лимит не тратит — включай, если гоняешь установку
          повторно.
        </p>
      </div>

      <div class="row">
        <UiButton
          data-role="settings-action"
          variant="solid"
          tone="accent"
          :disabled="!gwCanStart"
          @click="gwStart"
        >
          Установить
        </UiButton>
        <UiButton
          data-role="settings-action"
          :disabled="gwBusy || gwRunning || (!gwSaved && !gw.domain.trim())"
          @click="gwVerify"
        >
          Проверить связь
        </UiButton>
      </div>
      <p v-if="gwMsg" class="msg" :class="gwMsg.type">{{ gwMsg.text }}</p>
      <p v-if="!gwCanStart && !gwRunning" class="muted small">
        Кнопка ждёт: домен, адрес VPS, сверенный отпечаток<span v-if="gw.useCloudflare">,
        токен Cloudflare</span><span v-if="gwNeedsPassword">, пароль VPS</span>.
      </p>
      <p v-if="gw.useCloudflare" class="muted small">
        Выключение или удаление VPS само по себе DNS не очищает: токен не хранится, поэтому
        Cockpit не может изменить Cloudflare после установки. Следующий запуск снова заменит
        старый адрес текущим; перед окончательным освобождением IP запись пока нужно удалить вручную.
      </p>

      <!-- Ход установки. Живёт на сервере и уезжает по SSE: начали с компьютера — видно
           и с планшета, F5 картину не теряет. -->
      <div v-if="gwJob" class="card">
        <div class="card-head">
          <div>
            <h3>Установка</h3>
            <p class="muted small">Восемь шагов; сорвавшийся называет причину и не идёт дальше.</p>
          </div>
          <span
            class="status-pill"
            :class="gwJobConfirmed ? 'ok' : (gwJob.state === 'failed' ? 'danger' : 'warn')"
          ><i class="dot"></i>{{ gwJob.state === 'done' ? (gwJobConfirmed ? 'готово и проверено' : 'шаги завершены')
            : (gwJob.state === 'failed' ? 'сорвалась' : 'идёт') }}</span>
        </div>
        <ul class="gwsteps small">
          <li v-for="s in gwJob.steps" :key="s.key">
            <b :class="{ ok: s.state === 'ok', warn: s.state === 'run', off: s.state === 'skip' }">
              {{ GW_MARK[s.state] || '·' }}
            </b>
            <span>{{ s.title }}<span v-if="s.detail" class="muted"> — {{ s.detail }}</span></span>
          </li>
        </ul>
        <p v-if="gwJob.error" class="msg err">{{ gwJob.error.message }}</p>
        <p v-if="gwJob.state === 'done'" class="msg" :class="gwJobConfirmed ? 'ok' : 'warn'">
          <template v-if="gwJobConfirmed">
            Автоматические шаги завершены, внешний адрес проверен:
            <code>https://{{ gwJob.domain }}</code>.
          </template>
          <template v-else>
            Автоматические шаги завершены, но это ещё не подтверждает внешний доступ.
            Выполни оставшиеся действия, перезапуск, если он указан, затем нажми «Проверить связь».
          </template>
        </p>
        <!-- Не «осталось сделать», а чего ждать: трогать VPN визард не просит и не будет. -->
        <p v-if="gwJob.state === 'done'" class="muted small">
          Туннель ходит через VPN — так задумано, менять в нём ничего не нужно. Отсюда две
          особенности: до планшета крюк через выходной узел VPN, а вместе с VPN туннель падает
          и поднимается. Юниты туннеля этого и ждут, поэтому «activating» при опущенном
          VPN — ожидание, а не поломка. Если VPN уже работает через не-TUN интерфейс,
          его имя задаётся как <code>COCKPIT_VPN_IFACE</code> в корневом <code>.env</code>.
        </p>
        <p v-if="gwJob.needsRestart" class="msg warn">
          Нужен перезапуск сервера: домен и режим за прокси читаются один раз при старте.
          Кнопка — во вкладке «Сервер». Из чата агенту перезапускать нельзя: он сам дочерний
          процесс этого сервера.
        </p>
        <details v-if="gwJob.log?.length" class="gwlog">
          <summary class="muted small">Журнал ({{ gwJob.log.length }})</summary>
          <pre>{{ gwJob.log.join('\n') }}</pre>
        </details>
      </div>

      <!-- Что установка сделать не может: чужая панель DNS, root на мозге. Правила для VPN
           здесь нет намеренно — туннель ходит через него, и настройки VPN мы не трогаем. -->
      <div v-if="gwJob?.manual?.length" class="card">
        <div class="card-head">
          <div>
            <h3>Осталось сделать руками</h3>
            <p class="muted small">Шаги, которые кокпит за человека делать не имеет права.</p>
          </div>
        </div>
        <div v-for="m in gwJob.manual" :key="m.key" class="gwman">
          <p class="tlsline"><b>{{ m.title }}</b></p>
          <p class="muted small">{{ m.text }}</p>
          <template v-if="m.command">
            <pre class="gwcmd">{{ m.command }}</pre>
            <div class="row">
              <UiButton data-role="settings-action" @click="gwManualToTerminal(m)">
                Открыть в терминале
              </UiButton>
            </div>
          </template>
        </div>
      </div>

      <div v-if="gwChecks" class="card">
        <div class="card-head">
          <div>
            <h3>Проверка связи</h3>
            <p class="muted small">Живые запросы снаружи: туннели, кокпит и стенд под входом.</p>
          </div>
          <span class="status-pill" :class="gwChecks.ok ? 'ok' : 'warn'">
            <i class="dot"></i>{{ gwChecks.ok ? 'всё сходится' : 'есть замечания' }}
          </span>
        </div>
        <ul class="gwsteps small">
          <li v-for="c in gwChecks.checks" :key="c.key">
            <b :class="c.ok ? 'ok' : 'warn'">{{ c.ok ? '✓' : '✗' }}</b>
            <span>{{ c.title }}<span v-if="c.detail" class="muted"> — {{ c.detail }}</span></span>
          </li>
        </ul>
        <p v-if="gwSaved && !gwPublicDomain" class="muted small">
          Стенды проверятся после перезапуска сервера — до него домен в конфиг не попал.
        </p>
      </div>
      </section>
      </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, onMounted, onUnmounted, watch, watchEffect } from 'vue';
import { api } from '../shared/apiClient.ts';
import { useProvidersStore } from '../stores/providers.js';
import { useUiContextSource } from '../composables/useUiContextSource.ts';
import { useToolLauncher } from '../shared/tools/launcher.ts';
import ProviderIcon from '../shared/ProviderIcon.vue';
import ProviderUsageResources from '../features/providers/ProviderUsageResources.vue';
import { NAV_ICONS } from '../shared/navIcons.ts';
import AccessOverview from './settings/AccessOverview.vue';
import ToolHotkeys from './settings/ToolHotkeys.vue';
import { useAuthStore } from '../stores/auth.js';
import { usePluginsStore } from '../stores/plugins.js';
import { useChatStore } from '../stores/chat.js';
import { normalizeCompanionRun } from '../shared/companion-run.js';
import { useCompanionStore } from '../stores/companion.js';
import { usePwaStore } from '../stores/pwa.js';
import {
  blockReasonLabel,
  UPDATE_STAGE_LABELS,
  useCockpitUpdateStore,
} from '../stores/cockpit-update.js';
import {
  confirmDialog,
  UiButton,
  UiCheckbox,
  UiCommandButton,
  UiDisclosureButton,
  UiInput,
  UiNumberField,
  UiNumberInput,
  UiRadio,
  UiRange,
  UiSearchInput,
  UiSelect,
  UiSegmentedControl,
  UiSelectableRow,
  UiSpinner,
  UiSwitch,
  UiTextarea,
  UiToggleButton,
  UiTooltip,
} from '../ui';
import { useSse } from '../composables/useSse.ts';
import { FACTORY_DEBUG_LEVELS, factoryDebugPayload } from '../shared/factory-debug.js';

// Настройки сгруппированы по табам — новые разделы добавляются записью в TABS.
const TABS = [
  {
    id: 'app', label: 'Приложение', group: 'Основное', short: 'Экран и PWA',
    description: 'Поведение Cockpit на этом устройстве: экран, установка и локальные возможности браузера.',
    icon: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M9 21h6 M12 17v4',
  },
  {
    id: 'speech', label: 'Речь', group: 'Основное', short: 'Диктовка и приватность',
    description: 'Движок диктовки, место обработки голоса, язык и термины проекта.',
    icon: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3 M8 22h8',
  },
  {
    id: 'b24', label: 'Битрикс24', group: 'Основное', short: 'Портал и сессия',
    description: 'Подключение к порталу и проверка серверной сессии Битрикс24.',
    icon: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M8 8h8 M8 12h5 M8 16h3',
  },
  {
    id: 'providers', label: 'Исполнители', group: 'Автоматизация', short: 'ИИ и модели',
    description: 'Состояние CLI-исполнителей, доступные модели, обновления и общие каталоги.',
    icon: 'M12 3v3 M8 6h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z M9 12h.01 M15 12h.01 M9.5 16h5',
  },
  {
    id: 'runs', label: 'Запуски', group: 'Автоматизация', short: 'Правила и контекст',
    description: 'Правила подготовки запусков, контекст агентов и диагностика фабрики.',
    icon: 'M8 5v14l11-7z M4 5v14',
  },
  {
    id: 'plugins', label: 'Плагины', group: 'Автоматизация', short: 'Модули Cockpit',
    description: 'Включение системных и пользовательских модулей и их собственные параметры.',
    icon: 'M8 3v4 M16 3v4 M5 7h14v4a7 7 0 0 1-14 0z M12 18v3',
  },
  {
    id: 'server', label: 'Сервер', group: 'Система', short: 'Процесс и рестарт',
    description: 'Состояние процесса Cockpit и безопасное применение серверных обновлений.',
    icon: 'M5 4h14v6H5z M5 14h14v6H5z M8 7h.01 M8 17h.01',
  },
  {
    id: 'access', label: 'Доступ', group: 'Система', short: 'Вход, HTTPS и шлюз',
    description: 'Учётная запись, активные способы подключения и сертификаты для других устройств.',
    icon: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
  },
];
const TAB_GROUPS = ['Основное', 'Автоматизация', 'Система'].map((label) => ({
  label,
  items: TABS.filter((item) => item.group === label),
}));
const savedTab = localStorage.getItem('cockpit-settings-tab');
const tab = ref(TABS.some((item) => item.id === savedTab) ? savedTab : 'app');
const currentTab = computed(() => TABS.find((item) => item.id === tab.value) || TABS[0]);
const settingsNav = ref(null);
function revealTab(id, smooth = true) {
  nextTick(() => {
    const nav = settingsNav.value;
    const button = nav?.querySelector(`[data-settings-tab="${id}"]`);
    if (!nav || !button || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({
      left: button.offsetLeft - (nav.clientWidth - button.offsetWidth) / 2,
      behavior: smooth ? 'smooth' : 'auto',
    });
  });
}
function setTab(id) {
  tab.value = id;
  localStorage.setItem('cockpit-settings-tab', id);
  revealTab(id);
}

// Репортим открытый таб в UI-контекст — чат с агентом знает, что открыто.
const settingsContext = useUiContextSource('settings', {
  layer: 'page',
  details: { tab: currentTab.value.label },
});
watchEffect(() => settingsContext.update({ details: { tab: currentTab.value.label } }));

// ── Приложение (настройки именно этого окна/устройства) ──
const pwa = usePwaStore();
const companion = useCompanionStore();
const companionOutputPrefs = computed(() => ({
  ttsEnabled: false,
  ttsConsent: false,
  voiceURI: '',
  rate: 1,
  volume: 1,
  ...(companion.outputState?.prefs || {}),
}));
const companionOutputAvailable = computed(() => companion.outputState?.available === true);
const companionOutputVoices = computed(() => (Array.isArray(companion.outputState?.voices)
  ? companion.outputState.voices
  : []));
const companionTtsEnabled = computed(() => companionOutputPrefs.value.ttsEnabled === true
  && companionOutputPrefs.value.ttsConsent === true);
function setCompanionTtsEnabled(value) {
  companion.setTtsEnabled?.(value === true);
}
function setCompanionOutputPref(key, value) {
  companion.setOutputPrefs?.({ [key]: value });
}

// ── Чем отвечает компаньон (настройка СЕРВЕРНАЯ, в отличие от тумблеров выше) ──
// История компаньона server-owned и одна на все окна, поэтому и модель у неё одна:
// иначе один разговор шёл бы с компьютера и планшета разными моделями. Тем же она
// отличается от выбора в чате — там модель принадлежит конкретному разговору.
const companionRunMsg = ref(null);
const companionRunBusy = ref(false);
const companionRun = computed(() => normalizeCompanionRun(prefs.value?.companion));
/** Сохранённая пара → значение опции «исполнитель:модель»; пусто — не выбрана. */
const companionModelValue = computed(() => {
  const ref_ = companionRun.value.modelRef;
  return ref_ ? `${ref_.provider}:${ref_.model}` : '';
});
/** Выбор есть, а такой модели в реестре нет — вернём его подписью, иначе `null`. */
const companionModelLost = computed(() => {
  const ref_ = companionRun.value.modelRef;
  if (!ref_) return null;
  const { provider, model } = prov.modelOf(ref_);
  return provider && model ? null : `${ref_.provider}:${ref_.model}`;
});
/** Уровни эффорта выбранной модели; пусто — своей лестницы у неё нет, контрола не будет. */
const companionEffortLevels = computed(() => {
  const ref_ = companionRun.value.modelRef;
  if (!ref_) return [];
  const { model } = prov.modelOf(ref_);
  return Array.isArray(model?.efforts) ? model.efforts : [];
});
/** Сохранённый уровень, которого у модели больше нет: показываем, а не прячем. */
const companionEffortLost = computed(() => {
  const effort = companionRun.value.effort;
  if (!effort) return null;
  return companionEffortLevels.value.includes(effort) ? null : effort;
});
const companionRunLabel = computed(() => {
  const { model } = prov.modelOf(companionRun.value.modelRef || '');
  if (!model) return '';
  return [model.name || model.id, companionRun.value.effort].filter(Boolean).join(' · ');
});

async function saveCompanionRun(next) {
  companionRunMsg.value = null;
  companionRunBusy.value = true;
  try {
    prefs.value = await api.post('/api/settings/prefs', { companion: next });
    // Ход резолвит модель в браузере, а настройку стор получает вместе с историей —
    // значит новое значение отдаём ему сразу, а не до следующего F5.
    chatStore.companion = normalizeCompanionRun(prefs.value?.companion);
    companionRunMsg.value = {
      type: 'ok',
      text: companionRunLabel.value
        ? `Следующий ход компаньона уйдёт: ${companionRunLabel.value}.`
        : 'Компаньон будет ходить моделью по умолчанию из реестра исполнителей.',
    };
  } catch (e) {
    companionRunMsg.value = { type: 'err', text: e.message };
  } finally {
    companionRunBusy.value = false;
  }
}

function setCompanionModel(value) {
  // id исполнителя двоеточий не содержит, а id модели содержит сплошь и рядом
  // (`qwen3.6:latest`) — режем по первому.
  const at = String(value || '').indexOf(':');
  if (at <= 0) return saveCompanionRun({ modelRef: null, effort: '' });
  const modelRef = { provider: value.slice(0, at), model: value.slice(at + 1) };
  // Эффорт переносим, только если новая модель такой уровень объявляет: у моделей
  // разные лестницы, и `xhigh` на модели без него роняет запуск CLI, а не игнорируется.
  const { model } = prov.modelOf(modelRef);
  const levels = Array.isArray(model?.efforts) ? model.efforts : [];
  const effort = companionRun.value.effort;
  return saveCompanionRun({ modelRef, effort: levels.includes(effort) ? effort : '' });
}

function setCompanionEffort(value) {
  const modelRef = companionRun.value.modelRef;
  if (!modelRef) return null;
  return saveCompanionRun({ modelRef, effort: String(value || '') });
}

// ── Арбитр типизированной остановки конвейера ──
// Настройка серверная: арбитр живёт на сервере и ходит сам, поэтому выбор обязан быть
// один на все окна. Модель отдельная от компаньона — это разные решения человека.
const arbiterMsg = ref(null);
const arbiterBusy = ref(false);
const arbiterRun = computed(() => {
  const raw = prefs.value?.arbiter;
  const source = raw && typeof raw === 'object' ? raw : {};
  const ref_ = source.modelRef && typeof source.modelRef === 'object' ? source.modelRef : null;
  return {
    modelRef: ref_?.provider && ref_?.model ? { provider: ref_.provider, model: ref_.model } : null,
    effort: typeof source.effort === 'string' ? source.effort : '',
    auto: source.auto === true,
  };
});
const arbiterModelValue = computed(() => {
  const ref_ = arbiterRun.value.modelRef;
  return ref_ ? `${ref_.provider}:${ref_.model}` : '';
});
/** Выбор есть, а модели в реестре нет: молча показать «не выбрана» нельзя. */
const arbiterModelLost = computed(() => {
  const ref_ = arbiterRun.value.modelRef;
  if (!ref_) return null;
  const { provider, model } = prov.modelOf(ref_);
  return provider && model ? null : `${ref_.provider}:${ref_.model}`;
});
const arbiterEffortLevels = computed(() => {
  const ref_ = arbiterRun.value.modelRef;
  if (!ref_) return [];
  const { model } = prov.modelOf(ref_);
  return Array.isArray(model?.efforts) ? model.efforts : [];
});
const arbiterEffortLost = computed(() => {
  const effort = arbiterRun.value.effort;
  if (!effort) return null;
  return arbiterEffortLevels.value.includes(effort) ? null : effort;
});

async function saveArbiter(next) {
  arbiterMsg.value = null;
  arbiterBusy.value = true;
  try {
    prefs.value = await api.post('/api/settings/prefs', { arbiter: next });
    arbiterMsg.value = { type: 'ok', text: 'Сохранено.' };
  } catch (e) {
    arbiterMsg.value = { type: 'err', text: e.message };
  } finally {
    arbiterBusy.value = false;
  }
}

function setArbiterAuto(value) {
  return saveArbiter({ ...arbiterRun.value, auto: value === true });
}

function setArbiterModel(value) {
  // id исполнителя двоеточий не содержит, id модели содержит — режем по первому.
  const at = String(value || '').indexOf(':');
  if (at <= 0) return saveArbiter({ ...arbiterRun.value, modelRef: null, effort: '' });
  const modelRef = { provider: value.slice(0, at), model: value.slice(at + 1) };
  // Уровень переносим, только если новая модель его объявляет: `--effort xhigh` у модели
  // без такой ступени роняет запуск CLI, а не игнорируется.
  const { model } = prov.modelOf(modelRef);
  const levels = Array.isArray(model?.efforts) ? model.efforts : [];
  const effort = arbiterRun.value.effort;
  return saveArbiter({ ...arbiterRun.value, modelRef, effort: levels.includes(effort) ? effort : '' });
}

function setArbiterEffort(value) {
  if (!arbiterRun.value.modelRef) return null;
  return saveArbiter({ ...arbiterRun.value, effort: String(value || '') });
}

const wakeLockNeedsHttps = typeof window !== 'undefined' && window.isSecureContext === false;
const notificationNeedsHttps = typeof window !== 'undefined' && window.isSecureContext === false;

// ── Речь (server-owned выбор + фактическая возможность этого браузера) ──
const chatStore = useChatStore();
const speechLoading = ref(true);
const speechSaving = ref(false);
const speechRefreshing = ref(false);
const speechMsg = ref(null);
const speech = ref({
  engine: 'browser', browserProcessing: 'auto', browserAutoConsent: false,
  language: 'auto', dictionary: '', local: { ready: false, reason: '' }, revision: '',
  quality: 'balanced', videoQuality: 'balanced', videoInitialPrompt: '', model: null, videoModel: null,
  device: 'auto', computeType: null, beamSize: null, vadSilenceMs: 500,
  conditionOnPreviousText: true,
});
const speechCapabilities = ref({
  local: { ready: false, reason: '', checks: [] },
  models: [], cuda: { state: 'probe_failed', reason: '' }, languages: ['ru', 'en', 'auto'],
  lastDictionaryMeasure: null, resident: null, benchmark: null,
});
const browserLocalStatus = ref('unknown');
const browserLocalBusy = ref(false);
const speechAdvanced = ref(false);
const speechJobs = ref({});
const speechStarting = ref({});
const benchmarkResult = ref(null);
const speechJobTimers = new Map();
let speechJobsDestroyed = false;
let speechBaseline = null;
let speechSnapshotEpoch = 0;

const SPEECH_QUALITIES = [
  { id: 'fast', label: 'Быстро', model: 'small', beam: 1, hint: 'Черновик; термины может путать.' },
  { id: 'balanced', label: 'Обычно', model: 'medium', beam: 5, hint: 'Баланс скорости и точности.' },
  { id: 'accurate', label: 'Точно', model: 'large-v3-turbo', beam: 5, hint: 'Точнее; скорость зависит от CPU/GPU и проверяется замером.' },
];
const SPEECH_MODELS = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large-v3', label: 'Large v3' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo' },
];
const QUALITY_MODELS = { fast: 'small', balanced: 'medium', accurate: 'large-v3-turbo' };
const COCKPIT_DICTIONARY = 'кокпит\nконвейер\nworktree\nпесочница\nворота\nБитрикс24\nFastify\nPinia\nSSE\nCodex\nKimi\nOllama';
const TERMINAL_SPEECH_JOBS = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const SPEECH_EDITABLE_FIELDS = [
  'engine', 'browserProcessing', 'language', 'dictionary', 'quality', 'videoQuality',
  'videoInitialPrompt', 'model', 'videoModel', 'device', 'computeType', 'beamSize',
  'vadSilenceMs', 'conditionOnPreviousText',
];

function validNullable(value, allowed, fallback = null) {
  return value === null || allowed.includes(value) ? value : fallback;
}

function normalizeSpeechCapabilities(value, fallback = speechCapabilities.value) {
  const raw = value && typeof value === 'object' ? value : {};
  const localRaw = raw.local && typeof raw.local === 'object' ? raw.local : (fallback.local || {});
  const cudaRaw = raw.cuda && typeof raw.cuda === 'object' ? raw.cuda : (fallback.cuda || {});
  return {
    local: {
      ready: localRaw.ready === true,
      reason: typeof localRaw.reason === 'string' ? localRaw.reason : '',
      checks: Array.isArray(localRaw.checks) ? localRaw.checks : [],
    },
    models: Array.isArray(raw.models) ? raw.models
      .filter((model) => model && typeof model === 'object' && typeof model.modelId === 'string')
      .map((model) => ({
        ...model,
        cached: model.cached === true,
        sizeMb: Number.isFinite(Number(model.sizeMb)) ? Number(model.sizeMb) : 0,
      })) : (fallback.models || []),
    cuda: {
      ...cudaRaw,
      state: typeof cudaRaw.state === 'string' ? cudaRaw.state : 'probe_failed',
      reason: typeof cudaRaw.reason === 'string' ? cudaRaw.reason : '',
    },
    languages: Array.isArray(raw.languages) ? raw.languages : (fallback.languages || ['ru', 'en', 'auto']),
    lastDictionaryMeasure: raw.lastDictionaryMeasure ?? fallback.lastDictionaryMeasure ?? null,
    resident: raw.resident ?? fallback.resident ?? null,
    benchmark: raw.benchmark && typeof raw.benchmark === 'object'
      ? { ...raw.benchmark }
      : (fallback.benchmark && typeof fallback.benchmark === 'object' ? { ...fallback.benchmark } : null),
  };
}

function speechCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
function speechLanguageTag() {
  if (speech.value.language === 'ru') return 'ru-RU';
  if (speech.value.language === 'en') return 'en-US';
  return document.documentElement.lang || navigator.language || 'ru-RU';
}
const browserSpeechReady = computed(() => window.isSecureContext !== false && !!speechCtor());
const browserSpeechReason = computed(() => {
  if (window.isSecureContext === false) return 'Web Speech требует HTTPS или localhost.';
  if (!speechCtor()) return 'Этот браузер не предоставляет SpeechRecognition.';
  if (speech.value.browserProcessing === 'local' && browserLocalStatus.value === 'unavailable') {
    return 'Локальная модель выбранного языка в этом браузере недоступна.';
  }
  return '';
});
const speechEffective = computed(() => {
  if (speech.value.engine === 'whisper') {
    return speech.value.local.ready
      ? 'Whisper на сервере Cockpit'
      : `Недоступно${speech.value.local.reason ? `: ${speech.value.local.reason}` : ''}`;
  }
  if (!browserSpeechReady.value
      || (speech.value.browserProcessing === 'local' && browserLocalStatus.value === 'unavailable')) {
    return speech.value.local.ready
      ? `Whisper (fallback: ${browserSpeechReason.value})`
      : `Недоступно: ${browserSpeechReason.value || speech.value.local.reason || 'нет рабочего движка'}`;
  }
  if (speech.value.browserProcessing === 'local') {
    if (browserLocalStatus.value === 'downloadable') return 'Браузер локально — модель скачается по первому запуску';
    if (browserLocalStatus.value === 'downloading') return 'Браузер локально — модель скачивается';
    return 'Браузер локально на этом устройстве';
  }
  return 'Браузер — способ обработки выбирает сам браузер';
});

function speechSnapshotRevision(payload) {
  const raw = payload?.speech || payload?.settings || payload || {};
  const revision = raw.revision ?? payload?.revision;
  return typeof revision === 'string' ? revision : '';
}

function captureSpeechSnapshotContext() {
  return {
    epoch: speechSnapshotEpoch,
    revision: speechBaseline?.revision || '',
  };
}

function speechSnapshotMatchesCurrent(payload) {
  const revision = speechSnapshotRevision(payload);
  return !!revision && revision === (speechBaseline?.revision || '');
}

function speechSnapshotDisposition(context, payload) {
  if (speechSnapshotEpoch === context.epoch
    && (speechBaseline?.revision || '') === context.revision) return 'apply';
  if (speechSnapshotMatchesCurrent(payload)) return 'current';
  return 'stale';
}

function speechPatch() {
  if (!speechBaseline) return {};
  return Object.fromEntries(SPEECH_EDITABLE_FIELDS
    .filter((field) => !Object.is(speech.value[field], speechBaseline[field]))
    .map((field) => [field, speech.value[field]]));
}

function applySpeechSnapshot(payload, { preserveDirty = true } = {}) {
  const raw = payload?.speech || payload?.settings || payload || {};
  const capabilities = normalizeSpeechCapabilities(payload?.capabilities || raw.capabilities);
  const previous = speechBaseline || speech.value;
  const local = raw.local || capabilities.local || previous.local || {};
  const revision = raw.revision ?? payload?.revision;
  const dirty = new Map();
  if (preserveDirty && speechBaseline) {
    for (const field of SPEECH_EDITABLE_FIELDS) {
      if (!Object.is(speech.value[field], speechBaseline[field])) dirty.set(field, speech.value[field]);
    }
  }
  const serverSnapshot = {
    engine: ['browser', 'whisper'].includes(raw.engine) ? raw.engine : previous.engine,
    browserProcessing: ['auto', 'local'].includes(raw.browserProcessing)
      ? raw.browserProcessing : previous.browserProcessing,
    browserAutoConsent: typeof raw.browserAutoConsent === 'boolean'
      ? raw.browserAutoConsent : previous.browserAutoConsent,
    language: ['ru', 'en', 'auto'].includes(raw.language) ? raw.language : previous.language,
    dictionary: typeof raw.dictionary === 'string' ? raw.dictionary : previous.dictionary,
    quality: ['fast', 'balanced', 'accurate'].includes(raw.quality) ? raw.quality : previous.quality,
    videoQuality: ['fast', 'balanced', 'accurate'].includes(raw.videoQuality) ? raw.videoQuality : previous.videoQuality,
    videoInitialPrompt: typeof raw.videoInitialPrompt === 'string'
      ? raw.videoInitialPrompt : previous.videoInitialPrompt,
    model: validNullable(raw.model, SPEECH_MODELS.map((model) => model.id), previous.model),
    videoModel: validNullable(raw.videoModel, SPEECH_MODELS.map((model) => model.id), previous.videoModel),
    device: ['auto', 'cpu', 'cuda'].includes(raw.device) ? raw.device : previous.device,
    computeType: validNullable(raw.computeType, ['int8', 'int8_float16', 'float16', 'float32'], previous.computeType),
    beamSize: raw.beamSize === null || (Number.isInteger(raw.beamSize) && raw.beamSize >= 1 && raw.beamSize <= 10)
      ? raw.beamSize : previous.beamSize,
    vadSilenceMs: Number.isInteger(raw.vadSilenceMs) && raw.vadSilenceMs >= 100 && raw.vadSilenceMs <= 5000
      ? raw.vadSilenceMs : previous.vadSilenceMs,
    conditionOnPreviousText: typeof raw.conditionOnPreviousText === 'boolean'
      ? raw.conditionOnPreviousText : previous.conditionOnPreviousText,
    local: { ready: local.ready === true, reason: typeof local.reason === 'string' ? local.reason : '' },
    revision: typeof revision === 'string' && revision ? revision : (previous.revision || ''),
  };
  const previousFingerprint = speechBaseline && JSON.stringify(speechBaseline);
  speechBaseline = { ...serverSnapshot, local: { ...serverSnapshot.local } };
  if (!previousFingerprint || previousFingerprint !== JSON.stringify(speechBaseline)) speechSnapshotEpoch++;
  const formSnapshot = { ...serverSnapshot, local: { ...serverSnapshot.local } };
  for (const [field, value] of dirty) formSnapshot[field] = value;
  speech.value = formSnapshot;
  speechCapabilities.value = capabilities;
  const storeSnapshot = { settings: serverSnapshot, revision: serverSnapshot.revision, capabilities };
  if (typeof chatStore.setSpeechSnapshot === 'function') chatStore.setSpeechSnapshot(storeSnapshot);
  else chatStore.speech = serverSnapshot;
  return serverSnapshot;
}

watch(() => chatStore.speech, (next) => {
  if (!next || next.revision === speechBaseline?.revision) return;
  applySpeechSnapshot({ settings: next, revision: next.revision, capabilities: next.capabilities });
}, { flush: 'sync', immediate: true });

async function probeBrowserSpeech() {
  const Ctor = speechCtor();
  if (!browserSpeechReady.value || !Ctor) { browserLocalStatus.value = 'unavailable'; return; }
  if (!(typeof Ctor.available === 'function' && 'processLocally' in Ctor.prototype)) {
    browserLocalStatus.value = 'unavailable';
    return;
  }
  browserLocalBusy.value = true;
  try {
    browserLocalStatus.value = await Ctor.available({
      langs: [speechLanguageTag()], processLocally: true,
    });
  } catch {
    browserLocalStatus.value = 'unavailable';
  } finally {
    browserLocalBusy.value = false;
  }
}

async function loadSpeech() {
  speechLoading.value = true;
  speechMsg.value = null;
  const context = captureSpeechSnapshotContext();
  try {
    const response = await api.get('/api/settings/speech');
    const disposition = speechSnapshotDisposition(context, response);
    if (disposition === 'apply') applySpeechSnapshot(response);
    await probeBrowserSpeech();
  } catch (e) {
    speechMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally {
    speechLoading.value = false;
  }
}

async function refreshSpeechCapabilities() {
  if (speechRefreshing.value) return;
  speechRefreshing.value = true;
  speechMsg.value = null;
  const context = captureSpeechSnapshotContext();
  try {
    const response = await api.get('/api/settings/speech?refresh=1');
    const disposition = speechSnapshotDisposition(context, response);
    if (disposition === 'apply') applySpeechSnapshot(response);
    await probeBrowserSpeech();
    speechMsg.value = disposition === 'stale'
      ? { type: 'err', text: 'Настройки речи изменились во время проверки — показан актуальный снимок.' }
      : { type: 'ok', text: 'Окружение и кэши моделей перепроверены.' };
  } catch (error) {
    speechMsg.value = { type: 'err', text: error.data?.message || error.message };
  } finally {
    speechRefreshing.value = false;
  }
}

/**
 * Сброс шлёт null, а не текст: дефолт живёт на сервере, и вторая копия промпта во фронте
 * разошлась бы с ней при первой же правке.
 */
async function resetVideoInitialPrompt() {
  speech.value.videoInitialPrompt = null;
  await saveSpeech();
}

async function saveSpeech() {
  const patch = speechPatch();
  if (!Object.keys(patch).length) {
    speechMsg.value = { type: 'ok', text: 'Изменений нет.' };
    return;
  }
  speechSaving.value = true;
  speechMsg.value = null;
  const context = captureSpeechSnapshotContext();
  try {
    const response = await api.post('/api/settings/speech', patch);
    const disposition = speechSnapshotDisposition(context, response);
    if (disposition === 'apply') applySpeechSnapshot(response);
    await probeBrowserSpeech();
    speechMsg.value = disposition === 'stale'
      ? { type: 'err', text: 'Настройки речи изменились в другом окне — проверь правки и сохрани ещё раз.' }
      : { type: 'ok', text: 'Настройки диктовки сохранены.' };
  } catch (e) {
    speechMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally {
    speechSaving.value = false;
  }
}

const cudaReady = computed(() => speechCapabilities.value.cuda?.state === 'ready');
// Отсутствие поля означает старый сервер: оставляем кнопку рабочей. Новый сервер
// явно присылает available=false, когда эталонная запись не настроена.
const benchmarkAvailable = computed(() => speechCapabilities.value.benchmark?.available !== false);
const benchmarkReason = computed(() => {
  const capability = speechCapabilities.value.benchmark;
  if (!capability || capability.available !== false) return '';
  return capability.reason || 'Эталонная запись для замера не настроена.';
});
const cudaReason = computed(() => {
  const state = speechCapabilities.value.cuda?.state;
  if (state === 'ready') return 'Готово к инференсу на CUDA.';
  if (state === 'no_device') return 'NVIDIA GPU не обнаружен.';
  if (state === 'missing_library') return 'В media-venv нет CUDA-библиотек.';
  return speechCapabilities.value.cuda?.reason || 'Не удалось проверить CUDA.';
});
const benchmarkDevice = computed(() => {
  if (speech.value.device !== 'auto') return speech.value.device;
  return cudaReady.value ? 'cuda' : 'cpu';
});
const benchmarkComputeType = computed(() => speech.value.computeType
  || (benchmarkDevice.value === 'cuda' ? 'float16' : 'int8'));
const effectiveDictationModel = computed(() => speech.value.model || QUALITY_MODELS[speech.value.quality] || 'medium');
const effectiveVideoModel = computed(() => speech.value.videoModel || QUALITY_MODELS[speech.value.videoQuality] || 'medium');

function setNullableInteger(field, value, min, max) {
  if (value === '') { speech.value[field] = null; return; }
  const number = Number(value);
  if (Number.isInteger(number)) speech.value[field] = Math.max(min, Math.min(max, number));
}
function fillCockpitDictionary() { speech.value.dictionary = COCKPIT_DICTIONARY; }
function speechModelLabel(modelId) {
  return SPEECH_MODELS.find((model) => model.id === modelId)?.label || modelId;
}
function formatModelSize(sizeMb) {
  const value = Number(sizeMb);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 1024 ? `${(value / 1024).toFixed(1)} ГБ` : `${value.toFixed(value >= 100 ? 0 : 1)} МБ`;
}

function normalizeSpeechJob(value, fallback = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    ...fallback,
    ...raw,
    jobId: typeof raw.jobId === 'string' ? raw.jobId : fallback.jobId,
    kind: typeof raw.kind === 'string' ? raw.kind : fallback.kind,
    modelId: typeof raw.modelId === 'string' ? raw.modelId : fallback.modelId,
    status: typeof raw.status === 'string' ? raw.status : (fallback.status || 'queued'),
    progress: raw.progress && typeof raw.progress === 'object' ? raw.progress : (fallback.progress || null),
    result: raw.result ?? fallback.result ?? null,
    error: raw.error ?? fallback.error ?? null,
  };
}
function rememberSpeechJob(value, fallback = {}) {
  const job = normalizeSpeechJob(value, fallback);
  if (!job.jobId) return null;
  speechJobs.value = { ...speechJobs.value, [job.jobId]: job };
  if (job.kind === 'benchmark' && job.status === 'done') benchmarkResult.value = job.result || {};
  return job;
}
function modelJob(modelId) {
  return Object.values(speechJobs.value).filter((job) => job.modelId === modelId && job.kind !== 'benchmark').at(-1) || null;
}
function benchmarkJob() {
  return Object.values(speechJobs.value).filter((job) => job.kind === 'benchmark').at(-1) || null;
}
function speechJobActive(job) { return !!job && !TERMINAL_SPEECH_JOBS.has(job.status); }
function speechJobPercent(job) {
  const progress = job?.progress;
  if (!progress) return null;
  if (Number.isFinite(Number(progress.percent))) return Math.max(0, Math.min(100, Number(progress.percent)));
  const done = Number(progress.done ?? progress.current);
  const total = Number(progress.total);
  return Number.isFinite(done) && Number.isFinite(total) && total > 0
    ? Math.max(0, Math.min(100, (done / total) * 100)) : null;
}
function speechJobLabel(job) {
  if (!job) return '';
  const labels = {
    queued: 'в очереди', running: 'выполняется', done: 'готово',
    failed: 'ошибка', cancelled: 'отменено', interrupted: 'прервано перезапуском',
  };
  const percent = speechJobPercent(job);
  return `${labels[job.status] || job.status}${percent === null ? '' : ` · ${Math.round(percent)}%`}`;
}
function clearSpeechJobTimer(jobId) {
  const timer = speechJobTimers.get(jobId);
  if (timer) clearTimeout(timer);
  speechJobTimers.delete(jobId);
}
function scheduleSpeechJobPoll(jobId, delay = 900) {
  if (speechJobsDestroyed) return;
  clearSpeechJobTimer(jobId);
  speechJobTimers.set(jobId, setTimeout(() => pollSpeechJob(jobId), delay));
}
async function refreshSpeechSnapshot() {
  const context = captureSpeechSnapshotContext();
  try {
    const snapshot = await api.get('/api/settings/speech');
    if (speechJobsDestroyed) return;
    if (speechSnapshotDisposition(context, snapshot) === 'apply') applySpeechSnapshot(snapshot);
    await probeBrowserSpeech();
  } catch { /* job уже завершён; следующий GET восстановит capabilities */ }
}
async function pollSpeechJob(jobId) {
  clearSpeechJobTimer(jobId);
  if (speechJobsDestroyed) return;
  const previous = speechJobs.value[jobId];
  if (!previous) return;
  try {
    const response = await api.get(`/api/settings/speech/jobs/${encodeURIComponent(jobId)}`);
    if (speechJobsDestroyed) return;
    const job = rememberSpeechJob(response, previous);
    if (!job) return;
    if (TERMINAL_SPEECH_JOBS.has(job.status)) {
      if (job.status === 'done' && job.kind !== 'benchmark') await refreshSpeechSnapshot();
      return;
    }
    scheduleSpeechJobPoll(jobId);
  } catch (error) {
    if (speechJobsDestroyed) return;
    rememberSpeechJob({
      ...previous,
      error: { code: 'job_poll_failed', message: error.message },
    }, previous);
    scheduleSpeechJobPoll(jobId, 1600);
  }
}
async function startSpeechJob(kind, modelId) {
  const key = `${kind}:${modelId || ''}`;
  if (speechStarting.value[key]) return;
  speechStarting.value = { ...speechStarting.value, [key]: true };
  speechMsg.value = null;
  try {
    const path = kind === 'benchmark'
      ? '/api/settings/speech/benchmark'
      : `/api/settings/speech/models/${encodeURIComponent(modelId)}/${kind}`;
    const body = kind === 'benchmark' ? {
      modelId: effectiveDictationModel.value,
      language: speech.value.language,
      device: benchmarkDevice.value,
      computeType: benchmarkComputeType.value,
    } : {};
    const started = await api.post(path, body);
    if (speechJobsDestroyed) return;
    const job = rememberSpeechJob(started, {
      kind,
      modelId: kind === 'benchmark' ? effectiveDictationModel.value : modelId,
      status: 'queued',
    });
    if (!job) throw new Error('Сервер не вернул jobId.');
    await pollSpeechJob(job.jobId);
  } catch (error) {
    if (speechJobsDestroyed) return;
    speechMsg.value = { type: 'err', text: error.data?.message || error.message };
  } finally {
    const next = { ...speechStarting.value };
    delete next[key];
    speechStarting.value = next;
  }
}
async function cancelSpeechJob(job) {
  if (!job?.jobId) return;
  clearSpeechJobTimer(job.jobId);
  try {
    rememberSpeechJob(
      await api.del(`/api/settings/speech/jobs/${encodeURIComponent(job.jobId)}`),
      job,
    );
  } catch (error) {
    speechMsg.value = { type: 'err', text: error.data?.message || error.message };
    if (speechJobActive(job)) scheduleSpeechJobPoll(job.jobId);
  }
}
function startBenchmark() {
  if (!benchmarkAvailable.value || (speech.value.device === 'cuda' && !cudaReady.value)) return;
  benchmarkResult.value = null;
  startSpeechJob('benchmark', effectiveDictationModel.value);
}
function benchmarkText(result) {
  if (!result || typeof result !== 'object') return '';
  const durationMs = Number(result.durationMs ?? result.duration);
  const elapsedSeconds = Number(result.elapsedSec);
  const audioSeconds = Number(result.audioSec ?? result.audioSeconds);
  const factor = Number(result.realtimeFactor);
  const parts = [];
  if (Number.isFinite(audioSeconds)) parts.push(`${audioSeconds.toFixed(1)} с речи`);
  if (Number.isFinite(elapsedSeconds)) parts.push(`${elapsedSeconds.toFixed(2)} с обработки`);
  else if (Number.isFinite(durationMs)) parts.push(`${(durationMs / 1000).toFixed(2)} с обработки`);
  if (Number.isFinite(factor)) parts.push(`RTF ${factor.toFixed(2)}`);
  return parts.join(' · ') || 'Замер завершён.';
}

onUnmounted(() => {
  speechJobsDestroyed = true;
  for (const timer of speechJobTimers.values()) clearTimeout(timer);
  speechJobTimers.clear();
});

// ── Битрикс24 ──
const form = ref({ baseUrl: '', login: '', password: '' });
const configured = ref(false);
const saving = ref(false);
const testing = ref(false);
const msg = ref(null);

async function loadCurrent() {
  try {
    const v = await api.get('/api/settings/b24');
    configured.value = v.configured;
    form.value.baseUrl = v.baseUrl;
    form.value.login = v.login;
  } catch (e) { msg.value = { type: 'err', text: e.message }; }
}
async function save() {
  saving.value = true; msg.value = null;
  try {
    await api.post('/api/settings/b24', { ...form.value });
    configured.value = true;
    form.value.password = '';
    msg.value = { type: 'ok', text: 'Сохранено.' };
    await loadCurrent();
  } catch (e) { msg.value = { type: 'err', text: e.message }; } finally { saving.value = false; }
}
async function testAuth() {
  testing.value = true; msg.value = null;
  try {
    const r = await api.post('/api/settings/b24/test');
    msg.value = r.ok ? { type: 'ok', text: `Авторизация успешна (userId ${r.userId}).` } : { type: 'err', text: `Не удалось: ${r.error}` };
  } catch (e) { msg.value = { type: 'err', text: e.message }; } finally { testing.value = false; }
}

// ── Исполнители (реестр LLM-агентов) ──
const prov = useProvidersStore();
// Кто применяет доверенные каталоги, объявляют сами адаптеры в /api/providers.
// Здесь нет ни id, ни названий конкретных ИИ: новый исполнитель появится в строке
// автоматически, как только включит capability в своём контракте.
const trustedDirectoryProviders = computed(() =>
  prov.providers.filter((provider) => provider.trustedDirectories === true));
const trustedDirectoryProviderNames = computed(() =>
  trustedDirectoryProviders.value.map((provider) => provider.name).join(', '));
const refreshing = ref(false);
async function refreshProv() {
  refreshing.value = true;
  await prov.load(true);
  refreshing.value = false;
}
// Команда установки или авторизации недоступного исполнителя — клик открывает терминал
// с уже введённой командой (выполнение — Enter'ом пользователя).
const { openTerminal } = useToolLauncher();
function installInTerminal(p) {
  openTerminal({ insert: p.setupCommand || p.install });
}

// Свои настройки исполнителя: что за ключ и какое направление опасно — знает адаптер.
// UI лишь исполняет generic confirm и держит строку занятой до конца confirm + POST.
const setMsg = ref({});
const providerSettingBusyMap = ref({});

function providerSettingKey(p, s) {
  return `${p.id}:${s.id}`;
}

function providerSettingBusy(p, s) {
  return providerSettingBusyMap.value[providerSettingKey(p, s)] === true;
}

function setProviderSettingBusy(key, value) {
  const next = { ...providerSettingBusyMap.value };
  if (value) next[key] = true;
  else delete next[key];
  providerSettingBusyMap.value = next;
}

/**
 * Направленное подтверждение приходит только из `setting.confirm`; id исполнителя
 * и настройки здесь не участвуют. Отмена заканчивается до optimistic store-вызова.
 */
async function saveProviderSetting(p, s, value) {
  const key = providerSettingKey(p, s);
  if (providerSettingBusyMap.value[key]) return;
  setProviderSettingBusy(key, true);
  setMsg.value = { ...setMsg.value, [key]: '' };
  try {
    const confirmation = value ? s.confirm?.on : s.confirm?.off;
    let confirmed = false;
    if (confirmation) {
      confirmed = await confirmDialog(String(confirmation.text || 'Подтвердить изменение?'), {
        okText: String(confirmation.label || s.label || 'Применить'),
        danger: confirmation.danger === true,
      });
      if (!confirmed) return;
    }

    const r = confirmed
      ? await prov.saveSetting(p.id, s.id, value, true)
      : await prov.saveSetting(p.id, s.id, value);
    if (!r.ok) {
      setMsg.value = { ...setMsg.value, [key]: `Не сохранилось: ${r.error}` };
    }
  } finally {
    setProviderSettingBusy(key, false);
  }
}

// Текстовые/числовые настройки: сохранение по Enter и по уходу фокуса. Enter сразу
// уводит фокус, так что сохранение одно — повторный blur видит то же значение и молчит;
// неизменённое значение тоже не шлём (каждый клик мимо инпута не должен будить сервер).
// Сюда же попадает 'range' без валидного потолка — он рисуется числовым инпутом.
function commitProviderSetting(p, s, event) {
  const el = event?.target;
  if (!el) return;
  if (s.kind === 'number' || s.kind === 'range') {
    const num = Number(el.value);
    if (!Number.isFinite(num)) { el.value = s.value; return; } // мусор → назад к сохранённому
    if (num === s.value) return;
    saveProviderSetting(p, s, num);
    return;
  }
  if (el.value === s.value) return;
  saveProviderSetting(p, s, el.value);
}

// Проверка новых версий CLI. Сервер и сам проверяет раз в 6 часов (индикатор в топбаре),
// эта кнопка — «посмотреть прямо сейчас». Обновление НИКОГДА не запускается само.
const checking = ref(false);
async function checkUpdates() {
  checking.value = true;
  try {
    await api.post('/api/providers/check-updates', {});
    await prov.load(true);
  } catch { /* сеть недоступна — индикатор просто останется прежним */ }
  finally { checking.value = false; }
}

// Обновление CLI исполнителя. Сам ход и его итог живут в сторе: ту же кнопку носит
// всплывашка топбара, и состояние «ставится прямо сейчас» у них общее.
const updating = computed(() => prov.updating || '');
const updMsg = computed(() => prov.updateResults || {});
const updateProvider = (p) => prov.updateCli(p.id);

// ── MCP-серверы исполнителя ──
// Адаптер сам решает, отдаёт он live health-check или безопасный inventory конфигов.
// UI знает только нейтральные scope/state и опрашивает capability лениво.
const MCP_SCOPES = [
  { id: 'user', label: 'Пользователь' },
  { id: 'project', label: 'Проект' },
  { id: 'account', label: 'Аккаунт' },
];
const MCP_STATES = {
  ok: { label: 'Подключён', cls: 'ok' },
  failed: { label: 'Не подключился', cls: 'err' },
  'needs-auth': { label: 'Нужна авторизация', cls: 'warn' },
  configured: { label: 'Настроен', cls: 'idle' },
  disabled: { label: 'Выключен', cls: 'idle' },
  remote: { label: 'Включён на claude.ai', cls: 'idle' },
  unknown: { label: 'Состояние неизвестно', cls: 'warn' },
};
function mcpOf(p) { return prov.mcp[p.id] || null; }

/**
 * Ресурсы аккаунта исполнителя (доплата, кредиты, загруженные модели) — из того же
 * ответа о лимитах, что кормит всплывашку топбара. Пусто, пока ответ не пришёл или
 * исполнитель ресурсов не объявляет: пустой рамки на карточке тогда не будет.
 */
function usageResourcesOf(p) {
  const usage = prov.usage[p.id];

  return Array.isArray(usage?.resources) ? usage.resources : [];
}

/**
 * Базовые scope общие, но адаптер может переименовать секцию и дать пояснение.
 * Незнакомый будущий scope не теряем: он появится с собственным id как подписью.
 */
function mcpGroups(p) {
  const servers = mcpOf(p)?.servers || [];
  const overrides = new Map((Array.isArray(mcpOf(p)?.groups) ? mcpOf(p).groups : [])
    .filter((group) => typeof group?.id === 'string' && group.id)
    .map((group) => [group.id, group]));
  const scopes = MCP_SCOPES.map((scope) => ({ ...scope, ...(overrides.get(scope.id) || {}) }));
  const known = new Set(scopes.map((scope) => scope.id));
  for (const group of overrides.values()) if (!known.has(group.id)) scopes.push(group);
  for (const server of servers) {
    const id = server.scope || 'user';
    if (!scopes.some((scope) => scope.id === id)) scopes.push({ id, label: id });
  }
  return scopes
    .map((scope) => ({
      ...scope,
      servers: servers.filter((server) => (server.scope || 'user') === scope.id),
    }))
    .filter((g) => g.servers.length);
}
function mcpState(server) { return MCP_STATES[server.state] || MCP_STATES.unknown; }
function loadMcpFor(p, refresh = false) {
  if (typeof p?.id !== 'string') return;
  prov.loadMcp(p.id, refresh);
}
// Слот есть у всех карточек, запрос — у установленной MCP-capability: модельный
// login не нужен для чтения конфигурации и может как раз быть причиной MCP auth.
function loadAllMcp(refresh = false) {
  for (const p of prov.providers) if (p.mcp && p.installed) loadMcpFor(p, refresh);
}

// ── Запуски (правила перед стартом триажа/конвейера) ──
const prefs = ref(null);
const prefsMsg = ref(null);
const trustedDirectories = ref([]);
const trustedDirectoryInput = ref('');
const trustedDirectoriesBusy = ref(false);
const trustedDirectoriesMsg = ref(null);
async function loadPrefs() {
  try {
    prefs.value = await api.get('/api/settings/prefs');
    trustedDirectories.value = [...(prefs.value.trustedDirectories || [])];
    syncInitialAccessDetails();
  } catch {
    prefs.value = null;
    trustedDirectories.value = [];
  }
}

function addTrustedDirectory() {
  const value = trustedDirectoryInput.value.trim();
  trustedDirectoriesMsg.value = null;
  if (!value) return true;
  if (!value.startsWith('/')) {
    trustedDirectoriesMsg.value = { type: 'err', text: 'Укажите абсолютный путь, начиная с /.' };
    return false;
  }
  if (!trustedDirectories.value.includes(value)) trustedDirectories.value.push(value);
  trustedDirectoryInput.value = '';
  return true;
}

function removeTrustedDirectory(index) {
  trustedDirectories.value.splice(index, 1);
  trustedDirectoriesMsg.value = null;
}

async function applyTrustedDirectories() {
  if (!addTrustedDirectory()) return;
  trustedDirectoriesBusy.value = true;
  trustedDirectoriesMsg.value = null;
  try {
    const result = await api.post('/api/settings/trusted-directories', {
      directories: trustedDirectories.value,
    });
    trustedDirectories.value = [...result.directories];
    if (prefs.value) prefs.value.trustedDirectories = [...result.directories];
    trustedDirectoriesMsg.value = {
      type: 'ok',
      text: 'Сохранено. Изменение действует со следующего хода.',
    };
  } catch (e) {
    trustedDirectoriesMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally {
    trustedDirectoriesBusy.value = false;
  }
}

async function toggleGitRefresh(v) {
  prefsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { gitRefreshBeforeRun: v });
    prefsMsg.value = { type: 'ok', text: 'Сохранено.' };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}

// Живые сессии исполнителей. Тумблер оставлен для отката: живой процесс держит память
// и свои MCP-серверы, и человеку нужен способ вернуть прежний порядок без правки кода.
async function toggleLiveSessions(v) {
  prefsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { chatLiveSessions: v });
    prefsMsg.value = {
      type: 'ok',
      text: v
        ? 'Агент чата будет жить между ходами. Применится к следующему ходу.'
        : 'Со следующего хода процесс агента снова поднимается на каждое сообщение. '
          + 'Уже открытые погаснут по простою — или сразу, кнопкой ниже.',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}

// ── Живые процессы агентов ───────────────────────────────────────────────────
// Свободную сессию в `ps` не отличить от разового запуска, а держит она и память,
// и MCP-серверы, и незакрытые фоновые команды. Поэтому список и кнопка гашения — здесь.
const liveSessions = ref([]);
const liveLimits = ref({ maxSessions: 4, idleMs: 30 * 60 * 1000 });
const liveEnabled = ref(true);
const liveLoaded = ref(false);
const liveBusy = ref(false);
const liveMsg = ref(null);
const liveFreeCount = computed(() => liveSessions.value.filter((item) => !item.running).length);
const liveRunningCount = computed(() => liveSessions.value.filter((item) => item.running).length);

async function loadLiveSessions() {
  try {
    const data = await api.get('/api/chat/sessions');
    liveSessions.value = data.sessions || [];
    liveLimits.value = {
      maxSessions: Number(data.maxSessions) || 4,
      idleMs: Number(data.idleMs) || 30 * 60 * 1000,
    };
    liveEnabled.value = data.enabled !== false;
  } catch (e) {
    liveSessions.value = [];
    liveMsg.value = { type: 'err', text: `Список живых процессов не прочитался: ${e.message}` };
  } finally {
    liveLoaded.value = true;
  }
}

function liveTitle(item) {
  if (item.chatTitle) return item.taskId ? `${item.chatTitle} · задача ${item.taskId}` : item.chatTitle;
  return item.taskId ? `Чат задачи ${item.taskId}` : 'Чат без названия';
}

// Подписи берём из живого реестра исполнителей, а не из своей карты: список режимов
// даёт сам CLI, и вторая копия названий разошлась бы с ним на первом же обновлении.
function liveRunLabel(item) {
  const provider = prov.providers.find((p) => p.id === item.executor) || null;
  const mode = (provider?.modes || []).find((m) => m.id === item.permissionMode) || null;
  const parts = [provider?.name || item.executor];
  if (item.model) parts.push(item.model);
  if (item.effort) parts.push(`усилие ${item.effort}`);
  if (item.permissionMode) parts.push(mode?.label || item.permissionMode);
  return parts.join(' · ');
}

const liveNow = ref(Date.now());
let liveTicker = null;

function minutesSince(at) {
  return Math.max(0, Math.round((liveNow.value - Number(at || 0)) / 60000));
}

function liveDetail(item) {
  const parts = [];
  parts.push(item.pid ? `pid ${item.pid}` : 'pid неизвестен');
  parts.push(`открыт ${minutesSince(item.openedAt)} мин назад`);
  if (item.running) {
    parts.push('идёт ход');
  } else {
    const left = Math.max(0, Math.round((Number(item.idleAtMs || 0) - liveNow.value) / 60000));
    parts.push(`простой ${minutesSince(item.lastUsed)} мин, погаснет через ${left} мин`);
  }
  // Про самопробуждение говорим только там, где оно есть: у остальных исполнителей
  // процесс живёт, но модель сам не будит — обещать обратное нельзя.
  if (item.unsolicited) parts.push('может заговорить сам');
  return parts.join(' · ');
}

// Роутер сюда не тащим: настройки живут без него, а хеш-навигация — тот же переход
// для vue-router с `createWebHashHistory`, но без инъекции в каждый тест этой страницы.
function openLiveChat(item) {
  if (typeof chatStore.setActive === 'function') chatStore.setActive(item.chatKey);
  location.hash = '#/chats';
}

async function closeLiveSession(item) {
  // Идущий ход гасим только вторым осознанным действием: вместе с процессом теряется
  // работа агента, а «Погасить» рядом со свободными сессиями читается как безобидное.
  if (item.running) {
    const ok = await confirmDialog(
      `В чате «${liveTitle(item)}» прямо сейчас идёт ход. Погасить процесс вместе с ним? `
      + 'Всё, что агент не успел записать, потеряется.',
      { danger: true, okText: 'Погасить с ходом' },
    );
    if (!ok) return;
  }
  liveBusy.value = true;
  liveMsg.value = null;
  try {
    const query = item.running ? '?force=1' : '';
    await api.del(`/api/chat/sessions/${encodeURIComponent(item.chatKey)}${query}`);
    liveMsg.value = { type: 'ok', text: 'Процесс погашен. Следующий ход поднимет его заново.' };
    await loadLiveSessions();
  } catch (e) {
    liveMsg.value = { type: 'err', text: e.data?.message || e.message };
    await loadLiveSessions();
  } finally {
    liveBusy.value = false;
  }
}

async function closeFreeSessions() {
  liveBusy.value = true;
  liveMsg.value = null;
  try {
    const result = await api.del('/api/chat/sessions');
    liveMsg.value = {
      type: 'ok',
      text: result.skipped
        ? `Погашено: ${result.closed}. Занятых ходом пропущено: ${result.skipped} — их гасят по одной.`
        : `Погашено процессов: ${result.closed}.`,
    };
    await loadLiveSessions();
  } catch (e) {
    liveMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally {
    liveBusy.value = false;
  }
}

// Список живёт, только пока карточка открыта: незачем держать его во всех окнах.
// Тикер ничего не запрашивает — он лишь двигает «сейчас» для подписей времени.
watchEffect(() => {
  if (liveTicker) {
    clearInterval(liveTicker);
    liveTicker = null;
  }
  if (tab.value !== 'runs') return;
  loadLiveSessions();
  liveNow.value = Date.now();
  liveTicker = setInterval(() => { liveNow.value = Date.now(); }, 30_000);
});
onUnmounted(() => {
  if (liveTicker) clearInterval(liveTicker);
  liveTicker = null;
});
useSse((name) => {
  // Событие означает «перечитай»: состав меняется редко, а показывать мёртвый
  // процесс живым — ровно та беда, ради которой карточку и заводили.
  if (name === 'chat-sessions' && tab.value === 'runs') loadLiveSessions();
});

// Порог автокомпакта чатов. Правится числом, а не тумблером: подходящее значение
// зависит от того, как человек работает, а 0 — осознанное «не вмешиваться».
const compactWindow = ref(0);
watchEffect(() => { compactWindow.value = Number(prefs.value?.chatAutoCompactWindow) || 0; });
async function saveCompactWindow() {
  prefsMsg.value = null;
  const value = Math.max(0, Math.round(Number(compactWindow.value) || 0));
  try {
    prefs.value = await api.post('/api/settings/prefs', { chatAutoCompactWindow: value });
    // Это одна из границ кольца контекста в открытых чатах — стор получает её при
    // загрузке истории, поэтому новое значение отдаём ему сразу, а не до следующего F5.
    useChatStore().compactWindow = value;
    prefsMsg.value = {
      type: 'ok',
      text: value
        ? `Чаты будут сжиматься при ${value.toLocaleString('ru')} токенах контекста. Применится к новым ходам.`
        : 'Порог снят: у каждого CLI останется свой (у Claude — почти у самого потолка окна модели).',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}
// Тот же порог для этапов конвейера. Своя настройка, а не общая с чатом: сжатие на
// этапе стоит дешевле (нить разговора с человеком там рвать нечего), поэтому значения
// у них расходятся осознанно.
const stageCompactWindow = ref(0);
watchEffect(() => { stageCompactWindow.value = Number(prefs.value?.stageAutoCompactWindow) || 0; });
async function saveStageCompactWindow() {
  prefsMsg.value = null;
  const value = Math.max(0, Math.round(Number(stageCompactWindow.value) || 0));
  try {
    prefs.value = await api.post('/api/settings/prefs', { stageAutoCompactWindow: value });
    prefsMsg.value = {
      type: 'ok',
      text: value
        ? `Этапы конвейера будут сжиматься при ${value.toLocaleString('ru')} токенах контекста. Применится к новым заходам.`
        : 'Порог снят: у CLI на этапах останется свой (он срабатывает почти у потолка окна модели).',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}
// Порог молчания хода конвейера. Секунды в поле показываем минутами: человек мыслит
// «полчаса висит», а не «1800».
const silenceWindowMin = ref(0);
watchEffect(() => {
  silenceWindowMin.value = Math.round((Number(prefs.value?.runSilenceWindow) || 0) / 60);
});
async function saveSilenceWindow() {
  prefsMsg.value = null;
  const value = Math.max(0, Math.round(Number(silenceWindowMin.value) || 0)) * 60;
  try {
    prefs.value = await api.post('/api/settings/prefs', { runSilenceWindow: value });
    prefsMsg.value = {
      type: 'ok',
      text: value
        ? `Позовём, если ход конвейера замолчит дольше ${value / 60} мин.`
        : 'Оповещение о зависших ходах выключено.',
    };
  } catch (e) { prefsMsg.value = { type: 'err', text: e.message }; }
}

// Подробный trace фабрики. Сам файл настроек принадлежит engine writer-у; UI работает
// только через /api/settings/factory-debug.
const factoryDebug = ref(null);
const factoryDebugBusy = ref(false);
const factoryDebugMsg = ref(null);

async function loadFactoryDebug({ keepMessage = false } = {}) {
  try {
    factoryDebug.value = await api.get('/api/settings/factory-debug?scope=global');
    if (!keepMessage) factoryDebugMsg.value = null;
  } catch (e) {
    factoryDebug.value = null;
    factoryDebugMsg.value = { type: 'err', text: e.message };
  }
}

async function saveFactoryDebug(level) {
  factoryDebugBusy.value = true;
  factoryDebugMsg.value = null;
  try {
    factoryDebug.value = await api.post(
      '/api/settings/factory-debug',
      factoryDebugPayload(level),
    );
    factoryDebugMsg.value = {
      type: 'ok',
      text: level === 'off' ? 'Подробное логирование выключено.' : 'Уровень логирования сохранён.',
    };
  } catch (e) {
    factoryDebugMsg.value = { type: 'err', text: e.message };
    await loadFactoryDebug({ keepMessage: true });
  } finally {
    factoryDebugBusy.value = false;
  }
}

// Сколько моделей исполнителя сейчас скрыто из выбора — считаем тем же правилом,
// по которому строится селект в чате (стор providers), а не своей копией условия.
function hiddenCount(p) {
  return (p.models || []).length - prov.visibleModels(p).length;
}

/**
 * Подпись точки версии рядом с именем исполнителя. Пусто, пока фоновая проверка не
 * назвала последнюю версию: точки нет вовсе — придумывать «всё в порядке» за
 * непроведённую проверку нельзя. Обновляет человек кнопкой, кокпит только сообщает.
 */
function updateHint(p) {
  if (!p.latest) return '';
  return p.updateAvailable
    ? `Доступно обновление: ${p.latest} — нажми «Обновить»`
    : `Последняя версия (${p.latest})`;
}

// Показ старых версий моделей в выборе чата. Сохраняем на сервере (настройка общая для всех
// окон) и сразу отражаем в сторе — селект перестраивается без перезагрузки.
const modelsMsg = ref(null);
async function toggleShowAllModels(v) {
  modelsMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { showAllModels: v });
    prov.showAllModels = !!prefs.value.showAllModels;
  } catch (e) { modelsMsg.value = { type: 'err', text: e.message }; }
}

// ── Доступ (вход в кокпит) ──
const auth = useAuthStore();
const acc = ref({ currentPassword: '', login: '', password: '', password2: '' });
const accBusy = ref(false);
const accMsg = ref(null);

async function saveAccount() {
  accMsg.value = null;
  if (acc.value.password.length < 8) { accMsg.value = { type: 'err', text: 'Новый пароль — не короче 8 символов.' }; return; }
  if (acc.value.password !== acc.value.password2) { accMsg.value = { type: 'err', text: 'Пароли не совпадают.' }; return; }
  accBusy.value = true;
  try {
    const r = await api.post('/api/auth/password', {
      currentPassword: acc.value.currentPassword,
      login: acc.value.login,
      password: acc.value.password,
    });
    acc.value = { currentPassword: '', login: acc.value.login, password: '', password2: '' };
    accMsg.value = { type: 'ok', text: `Сохранено. ${r.note || ''}`.trim() };
    await auth.load();
  } catch (e) {
    accMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { accBusy.value = false; }
}

/**
 * Массовый выход инвалидирует и текущую сессию, поэтому действие подтверждается
 * через общий dialog host до запроса, а после запроса клиент всегда уходит на вход.
 */
async function logoutAll() {
  const confirmed = await confirmDialog(
    'Разлогинить все устройства, включая это?',
    {
      danger: true,
      okText: 'Выйти со всех',
    },
  );

  if (!confirmed) {
    return;
  }

  try {
    await api.post('/api/auth/logout-all');
  } catch {
    // Сервер мог инвалидировать cookie раньше ответа — клиент всё равно уходит на вход.
  }

  auth.authenticated = false;
}

// ── Способы доступа ──
// У LAN и шлюза разная семантика: локальный флаг управляет HTTPS-сокетом на следующем
// старте, а установленный VPS-шлюз отдельным prefs-флагом не выключается вовсе. Поэтому
// одинаковых тумблеров здесь больше нет: один переключатель отвечает только за защиту LAN,
// а панели подробностей раскрываются локально и всегда по одной.
const accessBusy = ref('');
const accessMsg = ref(null);
const activeAccessDetails = ref('');
let accessDetailsTouched = false;

async function toggleAccessDetails(kind) {
  accessDetailsTouched = true;
  activeAccessDetails.value = activeAccessDetails.value === kind ? '' : kind;
  if (kind === 'gateway' && gatewaySetupState.value === 'error') loadGatewaySetup();
  if (!activeAccessDetails.value) return;
  await nextTick();
  // Подробности — единая область после сводки и защиты входа. Переводим к ней фокус
  // и прокрутку: на телефоне иначе клик выглядит безрезультатным, а screen reader не
  // получает явного перехода от disclosure-кнопки к управляемому region.
  const region = document.getElementById(`${kind === 'local' ? 'local-https' : 'gateway'}-settings`);
  region?.focus?.({ preventScroll: true });
  region?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

async function setLocalHttpsMode(on) {
  if (tls.value?.source === 'env') {
    accessMsg.value = {
      type: 'warn',
      text: 'HTTPS задан переменными окружения сервера. Изменить его можно только в конфигурации системы.',
    };
    return;
  }
  if (!on) {
    const ok = await confirmDialog(
      'Выключить локальный HTTPS? После перезапуска сервера кокпит перестанет слушать порт '
      + `${tls.value?.https?.port || 8143}. В домашней сети останется HTTP на порту `
      + `${tls.value?.httpPort || 8140}: пароль пойдёт без шифрования, PWA ставиться не будет. `
      + 'Localhost и доступ через VPS-шлюз не изменятся; сертификат и корень останутся на месте.',
      { danger: true, okText: 'Выключить' },
    );
    if (!ok) return;
  }
  accessDetailsTouched = true;
  accessBusy.value = 'accessLocalHttps';
  accessMsg.value = null;
  try {
    prefs.value = await api.post('/api/settings/prefs', { accessLocalHttps: on });
    await loadTls();
    if (on) activeAccessDetails.value = 'local';
    else if (activeAccessDetails.value === 'local') activeAccessDetails.value = '';
    if (!tls.value) {
      accessMsg.value = {
        type: 'err',
        text: `Настройка сохранена, но состояние HTTPS не удалось перечитать: ${tlsMsg.value?.text || 'нет ответа сервера'}`,
      };
      return;
    }
    const managedByEnv = tls.value?.source === 'env';
    accessMsg.value = {
      type: 'ok',
      text: managedByEnv
        ? 'Локальная настройка сохранена, но действующий HTTPS задан переменными окружения и этим переключателем не управляется.'
        : (on
          ? (tls.value?.leaf?.exists
            ? 'Локальный HTTPS включён. Сокет поднимется при следующем перезапуске сервера.'
            : 'Локальный HTTPS включён. Теперь выпусти сертификат для адреса домашней сети.')
          : 'Локальный HTTPS выключен. После перезапуска дома останется HTTP; localhost и VPS-шлюз не изменятся.'),
    };
  } catch (e) {
    accessMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { accessBusy.value = ''; }
}

// ── Локальный HTTPS (свой корневой сертификат) ──
// Без него на планшете нет PWA: `navigator.serviceWorker` существует только в secure context,
// а публичный сертификат на домашний адрес не выпишет никто.
const tls = ref(null);          // ответ /api/settings/tls
const tlsState = ref('loading'); // loading | ready | error — null сам по себе не различает их
const tlsLoadError = ref('');
const tlsPicked = ref([]);      // адреса, отмеченные галками
const tlsBusy = ref(false);
const tlsMsg = ref(null);

async function loadTls({ keepMessage = false } = {}) {
  if (!keepMessage) tlsMsg.value = null;
  tlsState.value = 'loading';
  tlsLoadError.value = '';
  try {
    tls.value = await api.get('/api/settings/tls');
    // По умолчанию отмечаем то, что уже в сертификате, иначе — все адреса машины:
    // дома их один-два, и лишняя галка дешевле, чем «почему не открывается».
    const covered = tls.value.leaf?.addresses || [];
    const all = (tls.value.addresses || []).map((a) => a.address);
    tlsPicked.value = covered.length ? all.filter((a) => covered.includes(a)) : all;
    if (!tlsPicked.value.length) tlsPicked.value = all;
    tlsState.value = 'ready';
    syncInitialAccessDetails();
  } catch (e) {
    tls.value = null;
    tlsState.value = 'error';
    tlsLoadError.value = e.data?.message || e.message;
    tlsMsg.value = { type: 'err', text: tlsLoadError.value };
  }
}

function toggleTlsAddress(addr, on) {
  const set = new Set(tlsPicked.value);
  if (on) set.add(addr); else set.delete(addr);
  tlsPicked.value = [...set];
}

async function generateTls() {
  if (tls.value?.source === 'env') {
    tlsMsg.value = {
      type: 'warn',
      text: 'Системный HTTPS нельзя перевыпустить из Cockpit: измени сертификат в конфигурации сервера.',
    };
    return;
  }
  tlsBusy.value = true; tlsMsg.value = null;
  try {
    const r = await api.post('/api/settings/tls/generate', { addresses: tlsPicked.value });
    tls.value = r.status;
    tlsState.value = 'ready';
    tlsMsg.value = {
      type: 'ok',
      text: `Сертификат выпущен до ${new Date(r.notAfter).toLocaleDateString('ru-RU')}. `
        + (prefs.value?.accessLocalHttps
          ? 'Поставь корень на устройства (QR ниже) и перезапусти сервер — HTTPS включается только при старте.'
          : 'Поставь корень на устройства (QR ниже), затем включи HTTPS в карточке домашней сети и перезапусти сервер.'),
    };
  } catch (e) {
    tlsMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { tlsBusy.value = false; }
}

// Отдельно от тумблера режима: тот просто не поднимает сокет, а это — стереть выпущенное.
// Нужно редко (сменилась сеть, хочется чистого листа), поэтому и кнопка вторичная.
async function dropTlsCertificate() {
  if (tls.value?.source === 'env') {
    tlsMsg.value = {
      type: 'warn',
      text: 'Системный HTTPS нельзя удалить из Cockpit: им управляет конфигурация сервера.',
    };
    return;
  }
  const ok = await confirmDialog(
    'Удалить выпущенный сертификат? Кокпит с планшета снова откроется только по http, и PWA '
    + 'перестанет ставиться. Корень на устройствах останется — после нового выпуска '
    + 'переустанавливать его не нужно.',
    { danger: true, okText: 'Удалить' },
  );
  if (!ok) return;
  tlsBusy.value = true; tlsMsg.value = null;
  try {
    const r = await api.post('/api/settings/tls/disable', { confirm: true });
    tls.value = r.status;
    tlsState.value = 'ready';
    tlsMsg.value = { type: 'ok', text: 'Сертификат удалён. HTTPS погаснет после перезапуска сервера.' };
  } catch (e) {
    tlsMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { tlsBusy.value = false; }
}

// Адрес для QR и подсказок — первый из тех, что в сертификате.
const tlsAddress = () => tls.value?.leaf?.addresses?.[0] || '';
const tlsUrl = () => (tlsAddress() && tls.value?.https?.port
  ? `https://${tlsAddress()}:${tls.value.https.port}` : '');

// ── Шлюз наружу: установка формой ──
//
// Секреты живут ТОЛЬКО в памяти вкладки и в теле одного запроса: ни в prefs (те целиком
// уезжают в браузер), ни в слепке установки их нет. После успеха гасим и в памяти —
// держать пароль root во вкладке до конца дня незачем.
const gw = ref({
  domain: '',
  gateway: '',
  sshPort: 22,
  sshUser: 'root',
  sshPassword: '',
  sudoPassword: '',
  useCloudflare: false,
  cloudflareToken: '',
  acmeEmail: '',
  acmeStaging: false,
});
const gwSaved = ref(null); // слепок прошлой установки (без секретов)
const gwJob = ref(null); // снимок идущей или последней установки
const gwPublicDomain = ref(''); // домен, который процесс подхватил при СТАРТЕ
const gwBusy = ref(false);
const gwMsg = ref(null);
const gwProbe = ref(null); // отпечаток ключа хоста + нужен ли пароль
const gwHostOk = ref(false); // человек сверил отпечаток с панелью хостера
const gwChecks = ref(null); // результат кнопки «Проверить связь»
const gatewaySetupState = ref('loading'); // loading | ready | error — не выдаём неизвестность за «не настроен»
const gatewayLoadError = ref('');
let gatewaySetupLoaded = false;

// На первом открытии ведём сразу к незавершённой работе, но после первого клика выбор
// человека не перехватываем поздно приехавшими параллельными GET-запросами.
function syncInitialAccessDetails() {
  if (accessDetailsTouched || !prefs.value || !tls.value || !gatewaySetupLoaded) return;
  if (gwJob.value && ['running', 'failed'].includes(gwJob.value.state)) {
    activeAccessDetails.value = 'gateway';
  } else if (tls.value.source !== 'env' && prefs.value.accessLocalHttps === true
      && (!tls.value.https?.up || tls.value.needsRestart)) {
    activeAccessDetails.value = 'local';
  }
}

const GW_MARK = { wait: '·', run: '…', ok: '✓', fail: '✗', skip: '—' };
const gwRunning = computed(() => gwJob.value?.state === 'running');
const gwJobVerifyState = computed(() => gwJob.value?.steps
  ?.find((step) => step.key === 'verify')?.state || '');
const gwJobConfirmed = computed(() => gwJob.value?.state === 'done'
  && gwJobVerifyState.value === 'ok'
  && !gwJob.value?.needsRestart);
// Пароль требуем, только если сервер и правда не пускает по ключу (повторная установка — пускает).
const gwNeedsPassword = computed(() => gwProbe.value?.passwordNeeded !== false);
const gwCanStart = computed(() => !!gw.value.domain.trim()
  && !!gw.value.gateway.trim()
  && gwHostOk.value
  && (!gw.value.useCloudflare || !!gw.value.cloudflareToken.trim())
  && (!gwNeedsPassword.value || !!gw.value.sshPassword)
  && !gwRunning.value && !gwBusy.value);

/** Успех — единственный момент, когда секреты в памяти вкладки больше не нужны. */
function gwApplyJob(job) {
  const wasDone = gwJob.value?.state === 'done';
  gwJob.value = job || null;
  if (job?.state === 'running' && !accessDetailsTouched) {
    activeAccessDetails.value = 'gateway';
  }
  if (job?.state === 'done' && !wasDone) {
    gw.value.sshPassword = '';
    gw.value.sudoPassword = '';
    gw.value.cloudflareToken = '';
    loadGatewaySetup({ keepJob: true });
  }
}
// Прогресс идёт по общему SSE вкладки: установку начали с компьютера — видно и с планшета.
useSse((name, data) => { if (name === 'gateway-setup') gwApplyJob(data); });

async function loadGatewaySetup({ keepJob = false } = {}) {
  gatewaySetupState.value = 'loading';
  gatewayLoadError.value = '';
  try {
    const r = await api.get('/api/gateway/setup');
    gwSaved.value = r.setup || null;
    gwPublicDomain.value = r.publicDomain || '';
    if (!keepJob) gwJob.value = r.job || null;
    // Поля формы дозаполняем прошлой установкой, но НЕ затираем набранное руками.
    const s = r.setup;
    if (s) {
      if (!gw.value.domain) gw.value.domain = s.domain || '';
      if (!gw.value.gateway) gw.value.gateway = s.gateway || '';
      if (s.sshPort) gw.value.sshPort = s.sshPort;
      if (s.sshUser) gw.value.sshUser = s.sshUser;
      if (s.dns === 'cloudflare') gw.value.useCloudflare = true;
    }
    gatewaySetupState.value = 'ready';
    gatewaySetupLoaded = true;
    syncInitialAccessDetails();
  } catch (e) {
    gatewaySetupState.value = 'error';
    gatewayLoadError.value = e.data?.message || e.message;
    gatewaySetupLoaded = true;
    gwMsg.value = { type: 'err', text: gatewayLoadError.value };
    syncInitialAccessDetails();
  }
}

/** Проба ДО пароля: жив ли сервер и тот ли это сервер. */
async function gwProbeHost() {
  gwBusy.value = true;
  gwMsg.value = null;
  gwProbe.value = null;
  gwHostOk.value = false;
  try {
    gwProbe.value = await api.post('/api/gateway/setup/probe', {
      gateway: gw.value.gateway.trim(),
      sshPort: Number(gw.value.sshPort) || 22,
      sshUser: gw.value.sshUser.trim() || 'root',
    });
    if (!gwProbe.value.passwordNeeded) gw.value.sshPassword = '';
  } catch (e) {
    gwMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { gwBusy.value = false; }
}

async function gwStart() {
  let dnsPlan = null;
  if (gw.value.useCloudflare) {
    gwBusy.value = true;
    gwMsg.value = null;
    try {
      dnsPlan = await api.post('/api/gateway/setup/dns-plan', {
        domain: gw.value.domain.trim(),
        gateway: gw.value.gateway.trim(),
        useCloudflare: true,
        cloudflareToken: gw.value.cloudflareToken.trim(),
      });
    } catch (e) {
      gwMsg.value = { type: 'err', text: e.data?.message || e.message };
      return;
    } finally {
      gwBusy.value = false;
    }
  }

  const dnsChanges = dnsPlan?.records?.filter((r) => r.action !== 'unchanged') || [];
  const removed = dnsPlan?.removed || [];
  const removedText = removed.length
    ? ` Будут удалены ${removed.length} лишних адресных записей: ${removed.slice(0, 6)
      .map((r) => `${r.type} ${r.name} → ${r.content || 'пусто'}`).join('; ')}${removed.length > 6 ? '; …' : ''}.`
    : '';
  const dnsText = dnsPlan
    ? ` Cloudflare: зона ${dnsPlan.zone.name}; Cockpit управляет только ${dnsPlan.domain} и `
      + `*.${dnsPlan.domain}. Обе записи будут указывать только на ${dnsPlan.ip} `
      + `(DNS-only, TTL 60).${removedText} Остальные имена и служебные записи не меняются.`
    : '';
  const ok = await confirmDialog(
    `Настроить шлюз на ${gw.value.gateway.trim()} и открыть кокпит по адресу `
    + `https://${gw.value.domain.trim()}?\n\n`
    + 'На VPS встанет Caddy и пользователь туннеля, на мозге — юниты обратных туннелей, '
    + 'в .env кокпита допишутся домен и режим за прокси. Пароль уйдёт на сервер один раз '
    + '(положить туда наш ключ) и нигде не сохранится.'
    + dnsText,
    {
      title: 'Установить VPS-шлюз',
      okText: dnsPlan ? 'Синхронизировать и установить' : 'Установить',
      danger: removed.length > 0 || dnsChanges.length > 0,
    },
  );
  if (!ok) return;
  gwBusy.value = true;
  gwMsg.value = null;
  gwChecks.value = null;
  try {
    const r = await api.post('/api/gateway/setup/start', {
      domain: gw.value.domain.trim(),
      gateway: gw.value.gateway.trim(),
      sshPort: Number(gw.value.sshPort) || 22,
      sshUser: gw.value.sshUser.trim() || 'root',
      sshPassword: gw.value.sshPassword,
      sudoPassword: gw.value.sudoPassword,
      useCloudflare: gw.value.useCloudflare,
      cloudflareToken: gw.value.useCloudflare ? gw.value.cloudflareToken.trim() : '',
      cloudflarePlanFingerprint: dnsPlan?.fingerprint || '',
      acmeEmail: gw.value.acmeEmail.trim(),
      acmeStaging: gw.value.acmeStaging,
      hostKeyFingerprint: gwProbe.value?.fingerprint || '',
    });
    gwJob.value = r.job || null;
  } catch (e) {
    gwMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { gwBusy.value = false; }
}

async function gwVerify() {
  gwBusy.value = true;
  gwMsg.value = null;
  try {
    const body = {};
    if (gw.value.domain.trim() && gw.value.gateway.trim()) {
      body.domain = gw.value.domain.trim();
      body.gateway = gw.value.gateway.trim();
      body.sshPort = Number(gw.value.sshPort) || 22;
      body.sshUser = gw.value.sshUser.trim() || 'root';
    }
    const result = await api.post('/api/gateway/setup/verify', body);
    // Ответ проверки не хранится на сервере. Привязываем его к точной цели в памяти
    // вкладки, чтобы последующая правка формы не красила зелёным другой домен.
    gwChecks.value = {
      ...result,
      domain: body.domain || gwSaved.value?.domain || '',
      gateway: body.gateway || gwSaved.value?.gateway || '',
    };
  } catch (e) {
    gwChecks.value = null;
    gwMsg.value = { type: 'err', text: e.data?.message || e.message };
  } finally { gwBusy.value = false; }
}

/** Ручной шаг с командой — в терминал кокпита, без Enter: запуск остаётся за человеком. */
function gwManualToTerminal(entry) {
  if (entry?.command) openTerminal({ insert: entry.command });
}

// ── Плагины ──
const pluginsStore = usePluginsStore();
const plugMsg = ref(null);
const plugSavingId = ref(null);
const plugToggleId = ref(null);
const plugError = ref(null);
const pluginQuery = ref('');
const pluginFilter = ref('all');
const pluginConfigurableOnly = ref(false);
const pluginCustomOnly = ref(false);
const selectedPluginId = ref('');
const pluginDetail = ref(null);
const pluginCatalog = ref(null);
const pluginMobileDetailOpen = ref(false);
const pluginGuideOpen = ref(false);
const pluginStats = computed(() => {
  const list = Array.isArray(pluginsStore.list) ? pluginsStore.list : [];
  return {
    enabled: list.filter((plugin) => plugin.enabled).length,
    configurable: list.filter((plugin) => plugin.settings?.length).length,
    custom: list.filter((plugin) => !plugin.system).length,
  };
});
const pluginFilterOptions = computed(() => {
  const total = Array.isArray(pluginsStore.list) ? pluginsStore.list.length : 0;

  return [
    { value: 'all', label: `Все ${total}` },
    { value: 'enabled', label: `Включены ${pluginStats.value.enabled}` },
    { value: 'disabled', label: `Выключены ${total - pluginStats.value.enabled}` },
  ];
});

/** Поиск охватывает то, по чему человек узнаёт модуль, включая id из манифеста. */
function pluginMatchesQuery(plugin, query) {
  if (!query) return true;

  const haystack = [
    plugin.id,
    plugin.name,
    plugin.description,
    plugin.nav?.label,
    plugin.system ? 'системный' : 'пользовательский',
  ].filter(Boolean).join(' ').toLocaleLowerCase('ru');

  return haystack.includes(query);
}

/** Фильтр состояния применяется до выбора: правая панель никогда не спорит с каталогом. */
function pluginMatchesFilter(plugin) {
  const stateMatches = pluginFilter.value === 'enabled'
    ? plugin.enabled === true
    : pluginFilter.value === 'disabled'
      ? plugin.enabled !== true
      : true;

  return stateMatches
    && (!pluginConfigurableOnly.value || plugin.settings?.length > 0)
    && (!pluginCustomOnly.value || !plugin.system);
}

const visiblePlugins = computed(() => {
  const query = pluginQuery.value.trim().toLocaleLowerCase('ru');
  const list = Array.isArray(pluginsStore.list) ? pluginsStore.list : [];

  return list.filter((plugin) => pluginMatchesFilter(plugin)
    && pluginMatchesQuery(plugin, query));
});
const selectedPlugin = computed(() => visiblePlugins.value
  .find((plugin) => plugin.id === selectedPluginId.value) || null);

// Первый подходящий модуль выбирается только когда прежний действительно исчез из выдачи.
// Поэтому ввод поиска не сбрасывает осмысленный выбор, пока он всё ещё подходит запросу.
watch(
  visiblePlugins,
  (plugins) => {
    if (!plugins.some((plugin) => plugin.id === selectedPluginId.value)) {
      selectedPluginId.value = plugins[0]?.id || '';
      pluginMobileDetailOpen.value = false;
    }
  },
  { immediate: true },
);

/** Русские формы счётчика нужны и каталогу, и заголовку панели параметров. */
function countedLabel(value, one, few, many) {
  const normalized = Math.abs(Number(value)) % 100;
  const digit = normalized % 10;
  let word = many;

  if (normalized < 11 || normalized > 19) {
    if (digit === 1) word = one;
    else if (digit >= 2 && digit <= 4) word = few;
  }

  return `${value} ${word}`;
}

function pluginCountLabel(value) {
  return countedLabel(value, 'плагин', 'плагина', 'плагинов');
}

function settingCountLabel(value) {
  return countedLabel(value, 'параметр', 'параметра', 'параметров');
}

function clearPluginFilters() {
  pluginQuery.value = '';
  pluginFilter.value = 'all';
  pluginConfigurableOnly.value = false;
  pluginCustomOnly.value = false;
}

/**
 * В узкой раскладке каталог и подробности стоят друг под другом. После явного выбора
 * переносим человека к панели, но на широком экране оставляем фокус в каталоге.
 */
async function selectPlugin(id) {
  selectedPluginId.value = id;
  pluginMobileDetailOpen.value = true;
  await nextTick();

  if (typeof window.matchMedia !== 'function'
      || !window.matchMedia('(max-width: 959px)').matches) return;

  pluginDetail.value?.focus({ preventScroll: true });
  pluginDetail.value?.scrollIntoView?.({ block: 'start' });
}

/** Возврат из мобильной detail-панели восстанавливает фокус на выбранной строке. */
async function closeMobilePlugin() {
  pluginMobileDetailOpen.value = false;
  await nextTick();

  const row = pluginCatalog.value
    ?.querySelector(`[data-plugin-id="${selectedPluginId.value}"] button`);
  row?.focus();
}

/** Смена состояния не должна размонтировать detail из-под сфокусированного тумблера. */
async function togglePlugin(plugin, enabled) {
  if (plugToggleId.value) return;

  if ((pluginFilter.value === 'enabled' && !enabled)
      || (pluginFilter.value === 'disabled' && enabled)) {
    pluginFilter.value = 'all';
  }

  plugToggleId.value = plugin.id;

  try {
    await pluginsStore.toggle(plugin.id, enabled);
  } finally {
    plugToggleId.value = null;
  }
}

function pluginSettingId(plugin, setting, suffix = 'value') {
  return `plugin-${plugin.id}-${setting.key}-${suffix}`;
}

// Иконка относится к назначению плагина, а не к его происхождению. Встроенные
// повторяют навигацию Cockpit; неизвестному пользовательскому модулю достаётся
// нейтральный знак плагина — манифест не получает права передавать произвольный SVG.
function pluginIconPath(plugin) {
  return NAV_ICONS[plugin?.nav?.icon] || NAV_ICONS[plugin?.id] || NAV_ICONS.plugin;
}

async function savePlugin(p) {
  if (plugSavingId.value) return;

  plugSavingId.value = p.id;
  plugError.value = null;

  try {
    await pluginsStore.saveSettings(p.id, p.values);
    plugMsg.value = p.id;
    setTimeout(() => {
      if (plugMsg.value === p.id) plugMsg.value = null;
    }, 2000);
  } catch (error) {
    plugError.value = {
      id: p.id,
      text: error?.data?.message || error?.message || 'Не удалось сохранить настройки.',
    };
  } finally {
    plugSavingId.value = null;
  }
}

// Настройка типа `model` — тот же выбор, что в чате: исполнители группами, внутри их
// модели. Правило видимости общее (`visibleModels`): в кратком списке только свежие
// версии, остальные — под настройкой «показывать все модели».
const modelGroups = computed(() => prov.providers
  .map((p) => ({ ...p, models: prov.visibleModels(p) }))
  .filter((p) => p.models.length));

function pluginModelGroups(setting) {
  const capability = String(setting?.requiresCapability || '');
  if (!capability) return modelGroups.value;
  return modelGroups.value.filter((provider) => provider.capabilities?.[capability] === true);
}

/** Сохранённая пара → значение опции «исполнитель:модель»; пусто — не выбрана. */
function pluginModelValue(p, key) {
  const saved = p.values?.[key];
  if (!saved || typeof saved !== 'object') return '';
  const provider = String(saved.provider || '');
  const model = String(saved.model || '');
  return provider && model ? `${provider}:${model}` : '';
}

/**
 * Сохранённый, но недоступный для настройки выбор остаётся видимым: иначе пустой
 * select соврёт, будто сервер не продолжает запускать прежнюю модель.
 */
function pluginModelUnavailable(p, setting) {
  const value = pluginModelValue(p, setting?.key);
  if (!value) return null;
  const { provider, model } = prov.modelOf(p.values[setting.key]);
  if (!provider || !model) return `${value} — нет в реестре`;

  const capability = String(setting?.requiresCapability || '');
  if (capability && provider.capabilities?.[capability] !== true) {
    return `${provider.name}: ${model.name} — не подходит для этой настройки`;
  }

  return null;
}

function setPluginModel(p, key, value) {
  // id исполнителя двоеточий не содержит, а id модели содержит сплошь и рядом
  // (`qwen3.6:latest`) — режем по первому.
  const at = String(value || '').indexOf(':');
  if (at <= 0) { p.values[key] = null; return; }
  const next = { provider: value.slice(0, at), model: value.slice(at + 1) };
  // Эффорт переносим, только если новая модель такой уровень объявляет: у моделей
  // разные лестницы, и `xhigh` на модели без него роняет запуск CLI, а не игнорируется.
  const effort = p.values[key]?.effort;
  if (effort && pluginEffortLevels(next).includes(effort)) next.effort = effort;
  p.values[key] = next;
}

/** Уровни эффорта выбранной модели; пусто — своей лестницы у неё нет, контрола не будет. */
function pluginEffortLevels(saved) {
  if (!saved || typeof saved !== 'object') return [];
  const { model } = prov.modelOf(saved);
  return Array.isArray(model?.efforts) ? model.efforts : [];
}

/** Сохранённый уровень, которого у модели больше нет: показываем, а не прячем. */
function pluginEffortLost(p, key) {
  const saved = p.values?.[key];
  const effort = saved?.effort;
  if (!effort) return null;
  return pluginEffortLevels(saved).includes(effort) ? null : effort;
}

function setPluginEffort(p, key, value) {
  const saved = p.values?.[key];
  if (!saved || typeof saved !== 'object') return;
  const effort = String(value || '');
  if (effort) p.values[key] = { ...saved, effort };
  else { const { effort: _drop, ...rest } = saved; p.values[key] = rest; }
}

// ── Сервер (режим запуска и перезапуск) ──
const srv = ref(null);          // { systemd, pid, uptimeSec }
const restarting = ref(false);
const srvMsg = ref(null);
const cockpitUpdate = useCockpitUpdateStore();
const cockpitStatus = computed(() => cockpitUpdate.status);
const cockpitJob = computed(() => cockpitStatus.value?.job || null);
const clientBuildVersion = __COCKPIT_VERSION__;
const clientBuildSha = __COCKPIT_SHA__;
let confirmedUpdateJob = null;
const shortSha = (sha) => sha?.slice(0, 7) || '—';
const fmtChecked = (value) => {
  if (!value) return 'ещё не проверялось';
  try { return new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
  catch { return value; }
};

async function activeChatTurns() {
  try { return ((await api.get('/api/chat/active')).active || []).length; }
  catch { return 0; }
}

async function startCockpitAction(kind) {
  const status = cockpitStatus.value;
  if (!status) return;
  const active = await activeChatTurns();
  const warning = active
    ? ` Сейчас идут ходы агентов: ${active} — при рестарте они ОБОРВУТСЯ.`
    : '';
  const isRelease = kind === 'update';
  const action = isRelease
    ? `Установить ${status.latest?.tag} fast-forward-ом на чистую main? Будет применён только commit ${shortSha(status.latest?.sha)}.`
    : `Собрать и применить текущий checkout ${status.checkout.branch || 'detached HEAD'} · ${shortSha(status.checkout.sha)}? Git-ветка и файлы не изменятся.`;
  const details = ' Cockpit ненадолго станет недоступен после успешной сборки.';
  if (!(await confirmDialog(action + details + warning, {
    danger: !!active,
    okText: isRelease ? `Обновить до ${status.latest?.tag}` : 'Применить checkout',
  }))) return;
  const job = isRelease
    ? await cockpitUpdate.installRelease()
    : await cockpitUpdate.applyCheckout();
  if (!job && cockpitUpdate.error) srvMsg.value = { type: 'err', text: cockpitUpdate.error };
}

watchEffect(() => {
  const job = cockpitJob.value;
  if (job?.status !== 'done' || job.id === confirmedUpdateJob) return;
  confirmedUpdateJob = job.id;
  loadServer();
  pwa.checkForUpdate();
});

async function loadServer() { try { srv.value = await api.get('/api/system/server'); } catch { srv.value = null; } }

function fmtUptime(s) {
  if (s >= 86400) return `${Math.floor(s / 86400)}д ${Math.floor((s % 86400) / 3600)}ч`;
  if (s >= 3600) return `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м`;
  if (s >= 60) return `${Math.floor(s / 60)}м`;
  return `${s}с`;
}

async function restartServer() {
  // Рестарт обрывает идущие ходы агентов в чатах (они — дочерние процессы сервера):
  // честно предупреждаем числом, а не общими словами.
  const active = await activeChatTurns();
  const mode = srv.value?.systemd
    ? 'Сервер выйдет, юнит systemd поднимет его сам.'
    : 'Сервер запущен вручную — перезапустится через bin/restart.';
  const warn = active ? ` Сейчас идут ходы агентов: ${active} — они ОБОРВУТСЯ.` : '';
  if (!(await confirmDialog(`Перезапустить сервер кокпита? ${mode}${warn}`, { danger: !!active, okText: 'Перезапустить' }))) return;
  restarting.value = true; srvMsg.value = null;
  try { await api.post('/api/system/restart'); } catch { /* процесс мог умереть раньше ответа — это норм */ }
  // Ждём возвращения по публичному /api/auth/state (как bin/restart) и перезагружаем
  // страницу — она подтянет свежий бандл; ради применения нового кода кнопка и нужна.
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000) {
    await new Promise((r) => { setTimeout(r, 1000); });
    try { await api.get('/api/auth/state'); location.reload(); return; }
    catch { /* ещё поднимается */ }
  }
  restarting.value = false;
  srvMsg.value = { type: 'err', text: 'Сервер не вернулся за 40 секунд — смотри journalctl --user -u cockpit-server или server/.state/cockpit-server.log.' };
}

// ── Пересборка web-бандла из рабочего дерева (без checkout и рестарта) ──
const rebuilding = ref(false);
async function rebuildWeb() {
  if (!(await confirmDialog(
    'Пересобрать web-бандл из текущего рабочего дерева? В сборку попадут и незакоммиченные правки. '
    + 'Checkout и процесс сервера не трогаем; на время сборки (~минута) рестарт и обновления заблокированы.',
    { okText: 'Пересобрать' },
  ))) return;
  srvMsg.value = null;
  try { await api.post('/api/system/web-rebuild'); }
  catch (e) { srvMsg.value = { type: 'err', text: e.message }; return; }
  rebuilding.value = true;
  const t0 = Date.now();
  // Сборка фоном на сервере — опрашиваем. «idle» после старта = сервер перезапустили
  // в обход блокировки (руками), статус сборки уже неизвестен.
  while (Date.now() - t0 < 12 * 60_000) {
    await new Promise((r) => { setTimeout(r, 2000); });
    let state = null;
    try { state = (await api.get('/api/system/web-rebuild')).rebuild; } catch { continue; }
    if (state?.status === 'running') continue;
    if (state?.status === 'done') {
      srvMsg.value = { type: 'ok', text: 'Web-бандл пересобран. Страница обновится и подтянет новую сборку.' };
      pwa.checkForUpdate();
      setTimeout(() => location.reload(), 1500);
    } else if (state?.status === 'failed') {
      srvMsg.value = { type: 'err', text: state.error?.message || 'Пересборка завершилась ошибкой.' };
    } else {
      srvMsg.value = { type: 'err', text: 'Сервер перезапустился во время сборки — статус неизвестен, проверь web/dist вручную.' };
    }
    rebuilding.value = false;
    return;
  }
  rebuilding.value = false;
  srvMsg.value = { type: 'err', text: 'Пересборка не завершилась за 12 минут — смотри лог сервера.' };
}

// Опрос MCP начинаем, только когда человек открыл вкладку исполнителей: он стоит
// секунд живого health-check, и платить за него при открытии любой другой вкладки
// (или в топбаре) незачем. Повторные заходы гасит минутный кэш сервера.
// Источники перечислены ЯВНО, и это не стиль: watchEffect собрал бы в зависимости
// ещё и `prov.mcp` — его читает сам `loadMcp`, чтобы не терять прошлый список на
// время загрузки, — а ответ опроса в него же и пишет. Эффект перезапускал бы себя
// после каждого ответа, и вкладка молотила бы опрос исполнителей без конца.
watch(
  () => tab.value === 'providers' && prov.loaded,
  (active) => {
    if (!active) {
      return;
    }

    loadAllMcp(false);
    // Ресурсы аккаунта приезжают тем же запросом, что кормит всплывашку топбара:
    // минутный кэш стора не даст лишнего похода на вкладку.
    prov.loadUsage();
  },
  { immediate: true },
);

onMounted(() => {
  revealTab(tab.value, false);
  loadCurrent();
  loadSpeech();
  prov.load();
  loadPrefs();
  loadFactoryDebug();
  pluginsStore.load();
  loadServer();
  cockpitUpdate.load();
  loadTls();
  loadGatewaySetup();
  acc.value.login = auth.login || '';
});
</script>

<style scoped>
.settings {
  width: min(100%, 1280px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.settings-hero {
  position: relative;
  min-height: 150px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 28px 30px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background:
    radial-gradient(circle at 82% 20%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 28%),
    linear-gradient(135deg, color-mix(in srgb, var(--surface) 94%, var(--accent)) 0%, var(--surface) 72%);
  box-shadow: var(--shadow);
}
.settings-hero::after {
  content: '';
  position: absolute;
  inset: auto -70px -110px auto;
  width: 280px;
  height: 220px;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 50%;
}
.settings-hero > div:first-child { position: relative; z-index: 1; max-width: 680px; }
.settings-hero h2, .section-intro h2 { margin: 0; letter-spacing: -.025em; }
.settings-hero h2 { font-size: clamp(23px, 2vw, 30px); line-height: 1.2; }
.settings-hero p:last-child { max-width: 620px; margin: 10px 0 0; color: var(--ink-mid); }
.eyebrow {
  margin: 0 0 6px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 720;
  letter-spacing: .095em;
  line-height: 1.2;
  text-transform: uppercase;
}
.hero-mark {
  position: relative;
  z-index: 1;
  flex: none;
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: 22px;
  background: color-mix(in srgb, var(--accent) 10%, var(--ground));
  color: var(--accent);
  transform: rotate(3deg);
}
.hero-mark svg { width: 34px; height: 34px; }

.settings-layout {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  align-items: start;
  gap: 28px;
}
.settings-nav-wrap { min-width: 0; }
.settings-nav {
  position: sticky;
  top: 0;
  display: grid;
  gap: 14px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface) 86%, transparent);
}
.nav-group { display: grid; gap: 3px; }
.nav-group-label {
  padding: 5px 10px 4px;
  color: var(--ink-mid);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.settings-workspace { min-width: 0; max-width: 860px; }
.settings-workspace.wide { max-width: none; }
.section-intro {
  min-height: 80px;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 2px 0 20px;
  border-bottom: 1px solid var(--line);
}
.section-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
  color: var(--accent);
}
.section-icon svg { width: 21px; height: 21px; }
.section-intro h2 { font-size: 22px; line-height: 1.2; }
.section-intro p:last-child { max-width: 700px; margin: 5px 0 0; color: var(--ink-mid); font-size: 13.5px; }
section { display: flex; flex-direction: column; gap: 14px; padding-top: 18px; }
.section-note {
  max-width: 760px;
  margin: 0;
  padding: 11px 13px;
  border-left: 2px solid color-mix(in srgb, var(--accent) 58%, var(--line));
  border-radius: 0 9px 9px 0;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--ink-mid);
  font-size: 12.5px;
}
.section-note code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }

.muted code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.card {
  min-width: 0;
  background: linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, #fff) 0%, var(--surface) 100%);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 13px;
  box-shadow: inset 0 1px 0 #ffffff08;
}
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.card-head h3 { margin: 0; font-size: 14px; font-weight: 660; letter-spacing: -.01em; }
.card-head p { margin: 4px 0 0; }
.scope-pill, .status-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 25px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--ground);
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}
.status-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-mid); }
.status-pill.ok { border-color: color-mix(in srgb, var(--good) 34%, var(--line)); color: var(--good); }
.status-pill.ok .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 55%, transparent); }
.status-pill.warn { border-color: color-mix(in srgb, var(--warn) 38%, var(--line)); color: var(--warn); }
.status-pill.warn .dot { background: var(--warn); }
.status-pill.danger { border-color: color-mix(in srgb, var(--bad) 38%, var(--line)); color: var(--bad); }
.status-pill.danger .dot { background: var(--bad); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.form-grid .full { grid-column: 1 / -1; }
.speech-choice-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.speech-choice {
  display: flex; flex-direction: row; align-items: flex-start; gap: 10px; min-width: 0;
  padding: 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--ground);
  cursor: pointer;
}
.speech-choice.active { border-color: color-mix(in srgb, var(--accent) 65%, var(--line));
  background: color-mix(in srgb, var(--accent) 8%, var(--ground)); }
.speech-choice-copy { min-width: 0; display: grid; gap: 4px; color: var(--ink); }
.speech-choice-copy small { color: var(--ink-mid); font-size: 12px; line-height: 1.45; }
.speech-choice-copy code { font-size: 11px; }
.speech-subhead { margin-top: 3px; color: var(--ink-mid); font-size: 11px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; }
.speech-field { gap: 7px; }
.speech-quality-block { display: grid; gap: 9px; }
.speech-quality-block + .speech-quality-block { padding-top: 13px; border-top: 1px solid var(--line); }
.speech-quality-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.speech-quality { display: flex; flex-direction: row; align-items: flex-start; gap: 9px; min-width: 0;
  padding: 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--ground); cursor: pointer; }
.speech-quality.active { border-color: color-mix(in srgb, var(--accent) 65%, var(--line));
  background: color-mix(in srgb, var(--accent) 8%, var(--ground)); }
.speech-quality-copy { display: grid; gap: 3px; min-width: 0; color: var(--ink); }
.speech-quality-copy small { color: var(--ink-mid); font-size: 11.5px; line-height: 1.4; }
.speech-advanced-toggle { justify-self: start; }
.speech-advanced { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px;
  padding-top: 13px; border-top: 1px dashed var(--line); }
.speech-check { grid-column: 1 / -1; display: flex; flex-direction: row; align-items: flex-start; gap: 9px;
  padding: 10px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); }
.speech-check-copy { display: grid; gap: 3px; }
.speech-check-copy small { color: var(--ink-mid); line-height: 1.4; }
.speech-field-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.speech-model-list { display: grid; gap: 9px; }
.speech-model-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 9px 12px;
  padding: 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--ground); }
.speech-model-main { display: grid; gap: 2px; min-width: 0; }
.speech-model-main > .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.speech-model-state { width: fit-content; margin-top: 3px; border-radius: 999px; padding: 2px 7px; font-size: 10.5px; }
.speech-model-state.ready { background: color-mix(in srgb, var(--good) 12%, transparent); color: var(--good); }
.speech-model-state.missing { background: var(--surface-2); color: var(--ink-mid); }
.speech-model-actions { display: flex; align-items: center; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
.speech-job { grid-column: 1 / -1; display: grid; gap: 5px; padding-top: 7px; border-top: 1px dashed var(--line);
  color: var(--ink-mid); font-size: 12px; }
.speech-job > div { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.speech-job progress { width: 100%; height: 7px; accent-color: var(--accent); }
.speech-job.done { color: var(--good); }
.speech-job.failed, .speech-job.interrupted { color: var(--bad); }
.speech-env-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.speech-env-grid > div { display: grid; align-content: start; gap: 6px; padding: 11px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--ground); }
.speech-env-grid p { margin: 0; }
.speech-checks { display: grid; gap: 3px; margin: 2px 0 0; padding-left: 18px; font-size: 11.5px; }
.speech-checks .ok { color: var(--good); }
.speech-checks .err { color: var(--bad); }
.speech-benchmark { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-top: 12px; border-top: 1px solid var(--line); }
.speech-benchmark p { margin: 3px 0 0; }
/* Каталог держит десятки модулей в одной короткой колонке, а форма существует только
   для выбранного. Порядок DOM совпадает с визуальным — клавиатура не скачет по dense-grid. */
.plugin-loading {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 88px;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--surface);
}
.plugin-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.plugin-search {
  flex: 1 1 260px;
  max-width: 360px;
}
.plugin-filter-group {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  min-width: 0;
}
.plugin-filter {
  flex: none;
  max-width: 100%;
  overflow-x: auto;
}
.plugin-browser {
  display: grid;
  grid-template-columns: minmax(270px, .72fr) minmax(0, 1.55fr);
  align-items: start;
  gap: 14px;
  min-width: 0;
}
.plugin-catalog {
  position: sticky;
  top: 12px;
  gap: 10px;
  padding: 12px;
  background: color-mix(in srgb, var(--surface) 92%, var(--ground));
}
.plugin-catalog-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 3px 3px;
}
.plugin-catalog-head > div {
  display: grid;
  gap: 2px;
}
.plugin-catalog-head span {
  color: var(--accent);
  font-size: 9px;
  font-weight: 740;
  letter-spacing: .09em;
  text-transform: uppercase;
}
.plugin-catalog-head b {
  font-size: 12.5px;
  font-weight: 650;
}
.plugin-catalog-head small {
  color: var(--ink-mid);
  font-size: 10px;
}
.plugin-catalog-list {
  display: grid;
  gap: 7px;
  max-height: min(66vh, 680px);
  overflow-y: auto;
  padding-right: 2px;
  scrollbar-gutter: stable;
}
.plugin-catalog-content {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-width: 0;
}
.plugin-catalog-icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
}
.plugin-catalog-icon svg {
  width: 17px;
  height: 17px;
}
.plugin-catalog-icon.muted {
  border-color: var(--line);
  background: var(--ground);
  color: var(--ink-mid);
}
.plugin-catalog-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.plugin-catalog-name {
  overflow: hidden;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 630;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-catalog-meta {
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-catalog-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}
.plugin-catalog-state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-mid);
}
.plugin-catalog-state.on {
  color: var(--good);
}
.plugin-catalog-state.on i {
  background: var(--good);
  box-shadow: 0 0 5px color-mix(in srgb, var(--good) 45%, transparent);
}
.plugin-detail {
  position: relative;
  overflow: hidden;
  gap: 0;
  padding: 0;
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--surface) 96%, var(--accent)) 0%,
    var(--surface) 42%
  );
  scroll-margin-top: 12px;
}
.plugin-detail:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 72%, transparent);
  outline-offset: 3px;
}
.plugin-detail::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  background: linear-gradient(90deg, var(--accent), transparent 70%);
  opacity: .72;
}
.plugin-detail.off::before {
  background: var(--line-2);
  opacity: .45;
}
.plugin-mobile-back {
  display: none;
  align-self: flex-start;
  margin: 12px 12px 0;
}
.plughead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 19px 19px 0;
}
.plugidentity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.plugicon {
  flex: none;
  display: grid;
  place-items: center;
  width: 43px;
  height: 43px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 9%, var(--ground));
  color: var(--accent);
  box-shadow: inset 0 1px 0 #ffffff08;
}
.plugicon svg { width: 21px; height: 21px; }
.plugin-detail.off .plugicon {
  border-color: var(--line);
  background: var(--ground);
  color: var(--ink-mid);
}
.plugtitle { min-width: 0; display: grid; gap: 5px; }
.plugname { min-width: 0; display: flex; align-items: baseline; gap: 7px; }
.plugname b {
  overflow: hidden;
  font-size: 14px;
  font-weight: 670;
  letter-spacing: -.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugver { flex: none; color: var(--ink-mid); font-family: var(--mono); font-size: 10.5px; }
.plugmeta { display: flex; align-items: center; gap: 7px; min-width: 0; }
.plugtag {
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-mid);
  font-size: 10.5px;
  line-height: 1.3;
}
.plugtag.user {
  border-color: color-mix(in srgb, var(--accent) 42%, var(--line));
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--accent);
}
.plugplace {
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plug-switch {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 5px;
  color: var(--ink-mid);
  font-size: 11px;
}
.plug-switch.on { color: var(--accent); }
.plug-switch :deep(.tsw) { padding: 0; }
.plugdesc {
  margin: 14px 19px 17px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.5;
}
.plugin-detail-state {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 19px 18px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--ground);
  color: var(--ink-mid);
}
.plugin-detail-state.ready {
  border-color: color-mix(in srgb, var(--good) 30%, var(--line));
}
.plugin-detail-state-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  border-radius: 9px;
  background: var(--surface-2);
}
.plugin-detail-state.ready .plugin-detail-state-icon {
  background: color-mix(in srgb, var(--good) 10%, var(--surface));
  color: var(--good);
}
.plugin-detail-state-icon svg {
  width: 16px;
  height: 16px;
}
.plugin-detail-state > span:last-child {
  display: grid;
  gap: 3px;
}
.plugin-detail-state b {
  color: var(--ink);
  font-size: 12px;
}
.plugin-detail-state small {
  color: var(--ink-mid);
  font-size: 10.5px;
  line-height: 1.4;
}
.plugin-empty {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}
.plugin-empty-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: var(--surface-2);
  color: var(--ink-mid);
}
.plugin-empty-icon svg {
  width: 19px;
  height: 19px;
}
.plugin-empty p {
  margin: 3px 0 0;
}
.plugin-guide {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding-top: 2px;
}
.plugin-guide .section-note {
  max-width: 680px;
  margin: 0;
}
.plugrestart {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: -5px 19px 17px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--warn) 30%, var(--line));
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 6%, var(--ground));
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.45;
}
.plugrestart svg { flex: none; width: 14px; height: 14px; margin-top: 1px; color: var(--warn); }

.plugset {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 15px 19px 19px;
  border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--ground) 74%, transparent);
}
.plugset-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 2px;
}
.plugset-head > div { display: grid; gap: 1px; }
.plugset-head span {
  color: var(--accent);
  font-size: 9px;
  font-weight: 740;
  letter-spacing: .09em;
  text-transform: uppercase;
}
.plugset-head b { font-size: 12.5px; font-weight: 650; }
.plugset-head small { color: var(--ink-mid); font-size: 9.5px; }
.plugrow { min-width: 0; display: grid; gap: 6px; }
.plugrow label { color: var(--ink-mid); font-size: 11.5px; }
.plugrow .inp { width: min(100%, 320px); max-width: 320px; }
/* Выбор модели: подпись сверху, селект во всю карточку — названия моделей вместе
   с именем исполнителя в узкой колонке не помещаются. */
.plugrow.wide { align-items: stretch; }
.plugrow.wide label, .plugrow.wide .inp { min-width: 0; max-width: none; }
.plug-model-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(220px, .85fr);
  align-items: end;
  gap: 12px;
}
.plug-model-grid.solo { grid-template-columns: minmax(0, 1fr); }
.plug-model-grid .plugrow .inp { width: 100%; max-width: none; }
.plughint { max-width: 720px; margin: -2px 0 1px; color: var(--ink-mid); font-size: 11px; line-height: 1.5; }
.effort-row { min-width: 0; }
.plugcheck {
  align-items: flex-start;
  gap: 10px;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
}
.plugcheck-copy { min-width: 0; display: grid; gap: 2px; }
.plugcheck-copy b { color: var(--ink); font-size: 12px; font-weight: 590; }
.plugcheck-copy small { color: var(--ink-mid); font-size: 10.5px; line-height: 1.45; }
/* Кнопка — по содержимому. Общий max-width делал её полосой во всю карточку. */
.plugset > .btn { align-self: flex-start; }
.plugin-save { display: inline-flex; align-items: center; gap: 6px; margin-top: 2px; }
label:not([class^='ui-']):not([class*=' ui-']) {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--ink-mid);
  font-size: 13px;
}
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.trusted-copy { margin: 5px 0 0; }
.trusted-list { display: grid; gap: 7px; }
.trusted-item { display: flex; align-items: stretch; gap: 8px; min-width: 0; }
.trusted-item code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; background: var(--ground); border: 1px solid var(--line);
  border-radius: 7px; padding: 0 9px; height: 36px; box-sizing: border-box;
  display: flex; align-items: center; font-size: 12px; }
.trusted-item .ui-button { flex: none; box-sizing: border-box; }
.trusted-add { display: flex; align-items: stretch; gap: 8px; }
.trusted-add .ui-input { flex: 1; min-width: 0; box-sizing: border-box; }
.trusted-add .ui-button { box-sizing: border-box; }

/* «Запуски» — не линейная форма, а небольшой пульт из независимых смысловых зон.
   Автоподбор колонок использует всю ширину вкладки и сам схлопывается до одной. */
.runs-section { container-type: inline-size; gap: 14px; }
.runs-grid {
  display: grid;
  grid-template-columns: minmax(0, .85fr) minmax(0, 1.15fr);
  gap: 14px;
}
.run-card { align-content: start; }
.run-kicker {
  margin: 0 0 4px;
  color: var(--accent);
  font-size: 9.5px;
  font-weight: 740;
  letter-spacing: .09em;
  line-height: 1.2;
  text-transform: uppercase;
}
.run-feedback {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}
.run-feedback.ok {
  border-color: color-mix(in srgb, var(--good) 35%, var(--line));
  background: color-mix(in srgb, var(--good) 5%, var(--surface));
}
.run-feedback.err {
  border-color: color-mix(in srgb, var(--bad) 38%, var(--line));
  background: color-mix(in srgb, var(--bad) 5%, var(--surface));
}
.run-option-list { display: grid; }
.run-option {
  display: grid;
  gap: 5px;
  padding: 13px 0;
  border-top: 1px solid var(--line);
}
.run-option:first-child { padding-top: 0; border-top: 0; }
.run-option:last-child { padding-bottom: 0; }
.run-option > p { margin: 0 0 0 39px; }
.run-threshold-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.run-threshold, .run-observe-item {
  min-width: 0;
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--ground);
}
.run-threshold-copy { min-width: 0; display: grid; gap: 3px; }
.run-threshold-copy > b { font-size: 13px; font-weight: 630; }
.run-threshold-copy > p { margin: 0; }
.run-value-control {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
}
.run-threshold .run-value-control { grid-template-columns: minmax(0, 1fr) auto; }
.run-threshold .run-value-control .ui-button { grid-column: 1 / -1; width: 100%; }
.run-number, .run-select { width: 100%; min-width: 0; }
.run-unit { color: var(--ink-mid); font-size: 11.5px; white-space: nowrap; }
.run-card-note {
  margin: 0;
  padding: 9px 11px;
  border-left: 2px solid color-mix(in srgb, var(--accent) 52%, var(--line));
  border-radius: 0 8px 8px 0;
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  color: var(--ink-mid);
  font-size: 11.5px;
  line-height: 1.5;
}
.run-observe-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr));
  gap: 10px;
}
.run-observe-item { grid-template-rows: auto auto 1fr; }
.run-debug-control {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(150px, .8fr) minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}
.debug-effective { min-width: 0; color: var(--ink-mid); font-size: 11.5px; }
.run-subnote { align-self: end; margin: 0; color: var(--ink-mid); font-size: 11px; }
/* Настройка показа моделей — отделена от списка исполнителей */
.prow { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 12px; display: grid; gap: 6px; }
/* Первый блок своей карточки — отбивать сверху не от чего */
.prow.first { border-top: none; margin-top: 0; padding-top: 0; }

.live-card { gap: 12px; }
.live-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.live-mode {
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 4%, var(--ground));
}
.live-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--ground);
}
.live-stats > span {
  min-width: 0;
  display: grid;
  place-content: center;
  gap: 1px;
  padding: 8px 12px;
  border-left: 1px solid var(--line);
  text-align: center;
}
.live-stats > span:first-child { border-left: 0; }
.live-stats b { font-size: 15px; font-weight: 680; }
.live-stats .busy b { color: var(--good); }
.live-stats small { color: var(--ink-mid); font-size: 9.5px; }
.live-empty {
  display: grid;
  gap: 3px;
  padding: 14px;
  border: 1px dashed var(--line);
  border-radius: 10px;
  background: var(--ground);
  font-size: 13px;
}
.live-empty p { margin: 0; }
.live-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.live-row {
  min-width: 0;
  display: grid;
  gap: 9px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--ground);
}
.live-row.is-running {
  border-color: color-mix(in srgb, var(--good) 30%, var(--line));
  background: color-mix(in srgb, var(--good) 3%, var(--ground));
}
.live-line {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}
.live-identity { min-width: 0; display: flex; align-items: flex-start; gap: 8px; }
.live-copy { min-width: 0; display: grid; gap: 2px; }
.live-row-actions { display: flex; gap: 7px; }
.live-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--ink-mid);
}
.live-dot.busy { background: var(--good);
  box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.live-name { min-width: 0; overflow: hidden; font-size: 13px; font-weight: 620;
  text-overflow: ellipsis; white-space: nowrap; }
.live-run { min-width: 0; overflow: hidden; color: var(--ink-mid); font-size: 11.5px;
  line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.live-meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px 12px;
  flex-wrap: wrap;
  padding-left: 16px;
}
.live-detail { font-size: 11px; line-height: 1.45; }
.live-path {
  min-width: 0;
  overflow: hidden;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--surface-2);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-footnote { margin-top: 1px; }
.msg { font-size: 13px; margin: 0; white-space: pre-line; }
.small { font-size: 12px; line-height: 1.5; }
.msg.ok { color: var(--good); }
.msg.err { color: var(--bad); }

/* Плашка исполнителя: у каждого ИИ своя карточка, карточки — горизонтальным рядом */
/* Без align-items: start — плашки в ряду тянутся до общей высоты */
.pvcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 350px), 1fr)); gap: 14px; }
.pvcard { gap: 10px; }
.pvhead { display: flex; align-items: center; gap: 10px; }
.pvtitle { flex: 1; min-width: 0; }
/* Две строки фактов о CLI держат место всегда: реестр отвечает не мгновенно, и без
   этой меры блоки ниже переезжали бы уже после отрисовки карточки. */
.pvfacts { display: grid; gap: 2px; align-content: start; min-block-size: 40px; }
.pvicon { flex: none; display: grid; place-items: center; width: 34px; height: 34px;
  border: 1px solid var(--line); border-radius: 9px; background: var(--ground); }
.pvname { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 600; }
/* Точка версии CLI: тихая у свежей, тревожная у отставшей. Текст — в тултипе. */
.pvupddot { flex: none; width: 7px; height: 7px; border-radius: 50%;
  background: var(--ink-mid); cursor: default; }
.pvupddot.hot { background: var(--warn, #e0a33a);
  box-shadow: 0 0 6px color-mix(in srgb, var(--warn, #e0a33a) 60%, transparent); }
.pvsub { font-size: 12.5px; }
/* Свои настройки исполнителя — отбиты от фактов о CLI, как у карточек плагинов */
.pvset { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--line); padding-top: 10px; }
.pvsetttl { font-size: 12px; color: var(--ink-mid); text-transform: uppercase; letter-spacing: .04em; }
.pvsetrow { display: grid; gap: 3px; }
.pvsetline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pvsetinput { flex: 1; min-width: 140px; }
.pvsetrange { flex: 1; min-width: 140px; accent-color: var(--accent); }
.pvrangeval { font-size: 12px; color: var(--mut, var(--ink-mid)); white-space: nowrap;
  font-variant-numeric: tabular-nums; }
.pvsetlbl { font-size: 13px; }
/* Ручка объявлена исполнителем, но ещё не подключена к ходу */
.pvsoon { font-size: 11px; border: 1px solid var(--line); border-radius: 999px;
  padding: 1px 8px; color: var(--mut, var(--ink-mid)); }
/* Высота ЗАДАНА, а не ограничена сверху. Число ручек и длина списка MCP у исполнителей
   разные, приезжают они в разное время, и потолок оставлял бы блоки разъезжаться: у
   соседних карточек одноимённые разделы стояли бы на разной высоте, а поздний ответ
   двигал бы всё, что под ним. Лишнее прокручивается внутри своего тела. */
.pvsetttl { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pvsettings { flex: none; block-size: 220px; }
.pvmcp { flex: none; block-size: 220px; }
.pvsetbody, .mcpbody { flex: 1; min-block-size: 0; overflow-y: auto; padding-right: 2px;
  scrollbar-gutter: stable; overscroll-behavior: contain; }
.pvsetbody { display: flex; flex-direction: column; gap: 8px; }
.pvsetbody:focus-visible,
.mcpbody:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.mcpnote { margin-top: 0; }
.mcpgrp { display: grid; gap: 4px; }
.mcpgrpttl { font-size: 11.5px; }
.mcpgrphint { font-size: 11px; line-height: 1.4; opacity: .8; }
.mcprow { display: grid; gap: 2px; padding: 3px 0; }
.mcpline { display: flex; align-items: center; gap: 8px; }
.mcpdot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ink-mid); }
.mcpdot.ok { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.mcpdot.err { background: var(--bad); }
.mcpdot.warn { background: var(--warn, #e0a33a); }
/* Аккаунтный коннектор: локальной проверки нет, поэтому и цвета тревоги нет */
.mcpdot.idle { background: var(--ink-mid); }
/* Имя может быть длинным (у коннекторов оно с префиксом) — режем его, а не колонку:
   без min-width: 0 флекс-элемент не сжимается ниже своего содержимого и распирает плашку */
.mcpname { flex: 1; min-width: 0; font-size: 13px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.mcpst { flex: none; font-size: 12px; }
.mcpst.ok { color: var(--good); }
.mcpst.err { color: var(--bad); }
.mcpst.warn { color: var(--warn, #e0a33a); }
.mcpst.idle { color: var(--ink-mid); }
.mcpdetail { font-size: 11.5px; line-height: 1.45; padding-left: 16px;
  overflow-wrap: anywhere; }
/* Кнопка футера прижата к низу плашки: при равной высоте ряда кнопки в одну линию */
.pvfoot { display: flex; align-items: center; justify-content: flex-end; gap: 10px;
  margin-top: auto; }
/* Итог обновления занимает оставшуюся ширину строки кнопки: карточка может подрасти
   вниз, но всё, что выше, остаётся на своих местах — секции соседних карточек сходятся. */
.pvfootmsg { flex: 1; min-width: 0; font-size: 12px; line-height: 1.4; text-align: start; }
.pvstate { flex: none; display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; }
.pvstate .dot { width: 8px; height: 8px; border-radius: 50%; }
.pvstate.ok { color: var(--good); }
.pvstate.ok .dot { background: var(--good); box-shadow: 0 0 6px color-mix(in srgb, var(--good) 60%, transparent); }
.pvstate.err { color: var(--bad); }
.pvstate.err .dot { background: var(--bad); }
/* Подсказка установки недоступного исполнителя */
.pvinstall { font-size: 12px; color: var(--ink-mid); margin-top: 4px; }
/* Сервер: строка режима + кнопка перезапуска */
.srvline { margin: 0; font-size: 13.5px; }
.srvline b { font-weight: 640; }
.version-facts { display: grid; gap: 10px; margin: 0; }
.version-facts > div { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 12px; align-items: baseline; }
.version-facts dt { color: var(--ink-mid); font-size: 12px; }
.version-facts dd { margin: 0; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.version-facts dd b { font-weight: 650; }
.version-facts dd code { background: var(--ground); border-radius: 5px; padding: 1px 5px; }
.version-facts dd a { margin-left: 8px; color: var(--accent); }
.dirty-mark { margin-left: 6px; color: var(--warn); font-size: 11px; }
.msg.info { color: var(--accent); }
.update-job { display: grid; gap: 4px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--ground); }
.update-job.failed { border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }
.update-job.done { border-color: color-mix(in srgb, var(--good) 40%, var(--line)); }
.update-actions { align-items: center; }
.block-reasons { margin: 0; padding-left: 18px; display: grid; gap: 5px; color: var(--ink-mid); font-size: 12px; line-height: 1.45; }

@container (max-width: 840px) {
  .runs-grid { grid-template-columns: minmax(0, 1fr); }
}

/* Локальный HTTPS */
.sechead { margin: 12px 0 0; font-size: 14px; font-weight: 640; }
.access-account { display: grid; gap: 8px; }
.access-account > .sechead { margin: 0; }
.access-detail-region {
  display: grid;
  gap: 12px;
  scroll-margin-top: 18px;
}
.access-detail-region:focus { outline: none; }
.access-detail-region:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 8px;
}
.access-detail-head { display: grid; gap: 8px; padding-top: 4px; }
.access-detail-head .sechead, .access-detail-head > p { margin: 0; }

/* Режим доступа: тумблер + пояснение под ним, выровненное по подписи тумблера. */
.mode { display: grid; gap: 2px; }
.mode > p { margin: 0 0 0 39px; }
.mode + .mode { border-top: 1px solid var(--line); padding-top: 12px; }
.companion-audio-setting { gap: 9px; }
.companion-audio-setting > p { margin-left: 39px; }
/* Блок «Чем отвечает» — единственный серверный в карточке, и тумблера у него нет:
   отступ под переключатель (39px) здесь был бы отступом ни от чего. */
.companion-run-setting { gap: 10px; }
.companion-run-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.companion-run-head > div { min-width: 0; display: grid; gap: 2px; }
.companion-run-head b { color: var(--ink); font-size: 13px; font-weight: 590; }
.companion-run-head p { margin: 0; }
.companion-run-setting .msg { margin: 0; }
.companion-audio-grid { margin-left: 39px; display: grid;
  grid-template-columns: minmax(180px, 1.3fr) repeat(2, minmax(130px, 1fr)); gap: 10px; }
.companion-tts-consent { margin-left: 39px; display: grid; gap: 8px; padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line));
  border-radius: 9px; background: var(--ground); font-size: 13px; }
.companion-tts-consent .row { justify-content: flex-start; }
.notification-mode > p { margin-left: 0; }
.notification-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.notification-line > div { display: grid; gap: 2px; }
.notification-line p { margin: 0; }
.notification-line .ui-button { flex: none; }
.tlsline { margin: 0; font-size: 13.5px; }
.tlsline b { font-weight: 640; }
.tlsline b.ok { color: var(--good); }
.tlsline b.warn { color: var(--warn, #e0a33a); }
.tlsline b.off { color: var(--ink-mid); }
.msg.warn { color: var(--warn, #e0a33a); }
.tlsaddrs { display: grid; gap: 6px; }
.tlsaddr { flex-direction: row; align-items: center; gap: 8px; }
.tlsaddr code { background: var(--ground); border: 1px solid var(--line); border-radius: 6px;
  padding: 2px 7px; font-size: 12.5px; }
.tlsqr { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
/* QR всегда на белом: тёмный фон карточки камера читает через раз */
.tlsqr img { flex: none; background: #fff; border-radius: 8px; padding: 6px; }
.tlssteps { flex: 1; min-width: 240px; margin: 0; padding-left: 18px; display: grid; gap: 6px;
  color: var(--ink-mid); }
.tlssteps code { background: var(--surface-2); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
.fp { font-size: 11px; }

/* Шлюз наружу: ход установки, ручные шаги и журнал.
   Свой список, а не .tlssteps: там <ol> с номерами, а у шага уже есть своя метка
   состояния — номер рядом с «✓» читается как второй значок. */
.gwsteps { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; color: var(--ink-mid); }
.gwsteps li { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.gwsteps li > span { min-width: 0; overflow-wrap: anywhere; }
.gwsteps b { flex: none; width: 12px; text-align: center; font-weight: 700; color: var(--ink-mid); }
.gwsteps b.ok { color: var(--good); }
.gwsteps b.warn { color: var(--warn, #e0a33a); }
.gwsteps b.off { color: var(--ink-dim, var(--ink-mid)); }

.gwman { display: grid; gap: 6px; padding: 11px 12px; border: 1px solid var(--line);
  border-radius: 9px; background: var(--ground); }
.gwman + .gwman { margin-top: 8px; }
.gwman p { margin: 0; }
/* Команда показывается ЦЕЛИКОМ с переносом: по ней принимают решение, многоточие тут вредно.
   Без overflow-wrap длинный путь распирал бы всю колонку настроек (см. грабли про min-width). */
.gwcmd { margin: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface-2); font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.gwlog summary { cursor: pointer; }
.gwlog pre { margin: 8px 0 0; max-height: 260px; overflow: auto; padding: 9px 10px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2);
  font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }

/* Планшет: вертикальная рейка превращается в липкую горизонтальную навигацию. */
@media (max-width: 1099px) {
  .settings { gap: 18px; }
  .settings-layout { display: block; }
  .settings-nav-wrap {
    position: sticky;
    top: -1px;
    z-index: 20;
    margin: 0 -1px;
    padding: 8px 1px;
    background: linear-gradient(var(--ground) 78%, transparent);
  }
  .settings-nav {
    position: static;
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 7px;
    scroll-snap-type: x proximity;
    scrollbar-width: none;
  }
  .settings-nav::-webkit-scrollbar { display: none; }
  .nav-group { display: contents; }
  .nav-group-label { display: none; }
  .settings-workspace, .settings-workspace.wide { max-width: 920px; margin: 16px auto 0; }
}

/* На средней ширине detail уже важнее одновременного показа двух тесных колонок. */
@media (max-width: 959px) {
  .plugin-toolbar { align-items: stretch; flex-direction: column; }
  .plugin-search { max-width: none; }
  .plugin-filter-group { justify-content: flex-start; flex-wrap: wrap; }
  .plugin-browser { grid-template-columns: minmax(0, 1fr); }
  .plugin-catalog { position: static; }
  .plugin-catalog-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-height: none;
    overflow-y: visible;
    padding-right: 0;
  }
  .plugin-mobile-back { display: inline-flex; }
}

@media (max-width: 760px) {
  .plug-model-grid { grid-template-columns: minmax(0, 1fr); }
}

/* Мобильный: одна колонка без горизонтального переполнения и с крупными действиями. */
@media (max-width: 639px) {
  .settings { gap: 12px; }
  .settings.settings-plugins .settings-hero { display: none; }
  .settings.settings-plugins .section-intro p:last-child { display: none; }
  .settings-hero { min-height: 0; padding: 19px; border-radius: 14px; }
  .settings-hero h2 { font-size: 21px; }
  .settings-hero p:last-child { display: none; }
  .hero-mark { width: 48px; height: 48px; border-radius: 14px; }
  .hero-mark svg { width: 24px; height: 24px; }
  .settings-nav-wrap { margin: 0 -16px; padding: 7px 16px; }
  .settings-nav { margin: 0 -7px; }
  .section-intro { min-height: 0; gap: 11px; padding: 4px 0 16px; }
  .section-icon { width: 38px; height: 38px; border-radius: 10px; }
  .section-intro h2 { font-size: 19px; }
  .section-intro p:last-child { font-size: 12.5px; }
  section { gap: 12px; padding-top: 14px; }
  .card { padding: 15px; border-radius: 12px; }
  .card-head { flex-wrap: wrap; gap: 10px; }
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .form-grid .full { grid-column: auto; }
  .speech-choice-grid { grid-template-columns: minmax(0, 1fr); }
  .speech-quality-grid, .speech-advanced, .speech-env-grid { grid-template-columns: minmax(0, 1fr); }
  .speech-model-row { grid-template-columns: minmax(0, 1fr); }
  .speech-model-actions { justify-content: flex-start; }
  .speech-benchmark { align-items: stretch; flex-direction: column; }
  .pvcards { grid-template-columns: minmax(0, 1fr); }
  .plugin-toolbar.mobile-detail-hidden,
  .plugin-guide.mobile-detail-hidden { display: none; }
  .plugin-filter-group {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    overflow: visible;
  }
  .plugin-filter { grid-column: 1 / -1; overflow: visible; }
  .plugin-catalog-list { grid-template-columns: minmax(0, 1fr); }
  .plugin-browser.mobile-detail-open .plugin-catalog { display: none; }
  .plugin-browser:not(.mobile-detail-open) .plugin-detail { display: none; }
  .plugin-detail { padding: 0; scroll-margin-top: 84px; }
  .plugin-empty { grid-template-columns: auto minmax(0, 1fr); }
  .plugin-empty .ui-button { grid-column: 1 / -1; width: 100%; }
  .plughead { flex-wrap: wrap; gap: 12px; padding: 16px 16px 0; }
  .plugidentity { width: 100%; }
  .plug-switch { width: 100%; justify-content: space-between; padding-top: 0; }
  .plugdesc { min-height: 0; margin: 13px 16px 15px; }
  .plugrestart { margin-inline: 16px; }
  .plugset { padding: 14px 16px 16px; }
  .plugset-head { align-items: flex-start; flex-direction: column; gap: 2px; }
  .plugrow .inp { width: 100%; max-width: none; }
  .pvhead { align-items: flex-start; flex-wrap: wrap; }
  .pvstate { margin-left: 44px; }
  .plugrow label, .plugrow .inp { min-width: 0; max-width: none; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr); }
  .row > .ui-button { width: 100%; }
  .run-value-control { grid-template-columns: minmax(0, 1fr) auto; }
  .run-value-control .ui-button { grid-column: 1 / -1; width: 100%; }
  .run-threshold-list { grid-template-columns: minmax(0, 1fr); }
  .run-debug-control { grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .live-head-actions {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr);
  }
  .live-head-actions .ui-button { width: 100%; }
  .live-line { grid-template-columns: minmax(0, 1fr); }
  .live-row-actions { margin-left: 16px; }
  .live-row-actions .ui-button { flex: 1; }
  .live-meta { align-items: stretch; flex-direction: column; }
  .live-path { max-width: 100%; }
  .trusted-add { flex-direction: column; }
  .trusted-add .ui-button { width: 100%; }
  .mode > p { margin-left: 0; padding-left: 39px; }
  .companion-audio-grid { margin-left: 0; padding-left: 39px; grid-template-columns: minmax(0, 1fr); }
  .companion-tts-consent { margin-left: 0; }
  .notification-line { align-items: stretch; flex-direction: column; }
  .notification-line .ui-button { width: 100%; }
  .version-facts > div { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .tlsaddr { flex-wrap: wrap; }
  .tlsqr { display: grid; justify-items: center; }
  .tlsqr img { width: min(180px, 100%); height: auto; }
  .tlssteps { min-width: 0; width: 100%; }
  .fp { overflow-wrap: anywhere; }
}
</style>
