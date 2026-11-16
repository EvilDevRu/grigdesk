<template>
  <UiWorkspacePage
    :data-perf-pending="loading ? '' : undefined">
      <template #title><h1>{{ translate('core.pluginTelegram') }}</h1></template>
      <template #actions>
        <UiActionLink v-if="!pluginOff && connected" href="#/inbox" size="compact"> {{ translate('core.telegramObschayaOchered') }} </UiActionLink>
      </template>
    <div class="tg">
    <section v-if="pluginOff" class="card disabled-card">
      <div class="disabled-mark">{{ translate('core.telegramTg') }}</div>
      <div>
        <h2 class="ttl">{{ translate('core.telegramTelegramPokaVyklyuchen') }}</h2>
        <p class="muted lead"> {{ translate('core.telegramVklyuchiPlaginTelegramV') }} </p>
      </div>
    </section>

    <template v-else>
      <p v-if="!loading" class="ui-workspace-intro">
        {{ connected ? translate('core.telegramPodklyuchenUsername', { username: bot?.username ?? '' }) : translate('core.telegramPodklyuchiteBotaTokenomOt') }}
      </p>

      <div v-if="error || note" class="feedback" role="status" aria-live="polite">
        <p v-if="error" class="err"
    :data-perf-error="!loading && error && !connected ? '' : undefined">{{ error }}</p>
        <p v-if="note" class="ok">{{ note }}</p>
      </div>

      <!-- Подключённый бот: native provider lifecycle и его account-scoped настройки. -->
      <TelegramLoading v-if="loading" :label="translate('core.telegramZagruzhayuSostoyanieBota')"
                       :failed="Boolean(error)" :connected="connected" />
      <template v-else-if="connected">
        <nav class="setup-path" :aria-label="translate('core.telegramNastroykaTelegrama')">
          <a class="path-step done" href="#tg-bot">
            <span class="path-mark">1</span>
            <span class="path-copy">
              <b>{{ translate('core.telegramBotPodklyuchen') }}</b>
              <small v-if="privacyKnown && bot?.canReadAllGroupMessages">{{ translate('core.telegramGruppyDostupnyTselikom') }}</small>
              <small v-else>{{ translate('core.telegramProverRezhimPrivatnosti') }}</small>
            </span>
          </a>
          <a class="path-step" :class="{ done: chats.length }" href="#tg-chats">
            <span class="path-mark">2</span>
            <span class="path-copy">
              <b>{{ translate('core.telegramPoluchiSoobschenie') }}</b>
              <small>{{ chats.length ? translate('core.telegramBotUzheSlyshitChaty') : translate('core.telegramDobavBotaVRabochiy') }}</small>
            </span>
          </a>
          <a class="path-step" :class="{ done: rules.length, attention: dirty }" href="#tg-rules">
            <span class="path-mark">3</span>
            <span class="path-copy">
              <b>{{ translate('core.telegramRazreshiChat') }}</b>
              <small v-if="dirty">{{ translate('core.taskEditUnsaved') }}</small>
              <small v-else>{{ rules.length ? translate('core.telegramPrivyazkaKProektuNastroena') : translate('core.telegramVyberiProektDlyaChata') }}</small>
            </span>
          </a>
        </nav>

        <div class="tg-grid">
          <!-- Подключение и здоровье опроса — отдельные provider-состояния. -->
          <section id="tg-bot" class="card bot-card">
            <div class="head">
              <div class="bot-name">
                <span class="status-dot" :class="pollState?.kind === 'good' ? 'on' : 'warn'"></span>
                <div>
                  <div class="section-kicker">{{ translate('core.telegramPodklyuchennyyBot') }}</div>
                  <div class="name">@{{ bot?.username }}</div>
                </div>
              </div>
            </div>

            <div v-if="privacyKnown && bot?.canReadAllGroupMessages" class="state good"> {{ translate('core.telegramRezhimPrivatnostiVyklyuchenV') }} </div>
            <div v-else-if="privacyKnown" class="state warn">
              <b>{{ translate('core.telegramBotPokaNeVidit') }}</b>
              {{ bot?.privacyHint }} {{ translate('core.telegramVyklyuchiRezhimUBotfather') }} </div>
            <div v-else class="state"> {{ translate('core.telegramSostoyanieRezhimaPrivatnostiNeizvestno') }} </div>

            <div v-if="pollState" class="state" :class="pollState.kind">{{ pollState.text }}</div>
            <div v-if="providerReason" class="state warn">{{ translate('core.telegramPrichinaProvider') }} {{ providerReason }}</div>

            <p class="muted sub"> {{ translate('core.telegramSleduyuschiyShagDobav') }}{{ bot?.username }} {{ translate('core.telegramVRabochiyChatObychnym') }} </p>

            <div class="bot-actions">
              <UiButton
                class="btn"
                :disabled="Boolean(busy)"
                :loading="busy === 'recheck'"
                :loading-label="translate('core.telegramProveryayuTelegram')"
                @click="recheck"
              >
                {{ busy === 'recheck' ? translate('core.telegramProveryayu') : translate('settings.test') }}
              </UiButton>
              <UiButton
                class="btn danger disconnect"
                tone="danger"
                :disabled="Boolean(busy)"
                @click="disconnect"
              > {{ translate('core.telegramOtklyuchit') }} </UiButton>
            </div>

            <details class="technical">
              <summary>{{ translate('core.telegramDannyePodklyucheniya') }}</summary>
              <div class="muted sub technical-data"> {{ 'id' }} {{ bot?.botId }} {{ translate('core.telegramToken') }} {{ bot?.tokenHint }}
                <template v-if="bot?.connectedAt"> {{ translate('core.telegramPodklyuchen') }} {{ fmtMs(bot?.connectedAt) }}</template>
              </div>
            </details>
          </section>

          <aside class="side-stack" :aria-label="translate('core.telegramVspomogatelnyeNastroykiKanala')">
            <!-- Единственный источник имён для привязки «чат/тема → проект». -->
            <section id="tg-chats" class="card chats-card">
              <div class="head compact-head">
                <div>
                  <div class="section-kicker">{{ translate('core.telegramIstochnikSoobscheniy') }}</div>
                  <div class="section-title">
                    <span class="h">{{ translate('core.telegramChtoSlyshitBot') }}</span>
                    <span v-if="chats.length" class="count subtle">{{ chats.length }}</span>
                  </div>
                </div>
                <UiButton class="btn compact" :disabled="loading" @click="loadChats"> {{ translate('core.trackerUpdate') }} </UiButton>
              </div>

              <div v-if="!chats.length" class="mini-empty">
                <b>{{ translate('core.telegramSoobscheniyPokaNeBylo') }}</b>
                <p class="muted sub"> {{ translate('core.telegramDobavBotaVRabochiy2') }} </p>
              </div>
              <ul v-else class="chats">
                <li v-for="c in chats" :key="c.id" class="chat">
                  <div class="cname">{{ c.title || translate('core.telegramChatId', { id: String(c.id) }) }}</div>
                  <div class="muted sub">
                    {{ chatKind(c) }} ·
                    {{ translate('core.telegramMessageCount', { count: c.messages || 0 }) }}
                  </div>
                  <div class="muted chat-meta"> {{ 'id' }} {{ c.id }}<template v-if="c.lastAt"> {{ translate('core.telegramPoslednee') }} {{ fmtSec(c.lastAt) }}</template>
                  </div>
                </li>
              </ul>

              <p class="muted sub card-foot"> {{ translate('core.telegramEtotSpisokTolkoPokazyvaet') }} </p>
            </section>

            <!-- Необязательный фолбэк для сообщений, которых ещё нет в архиве. -->
            <section class="card service-card">
              <div class="head compact-head">
                <div>
                  <div class="section-kicker">{{ translate('core.telegramDlyaStaryhSsylokNeobyazatelno') }}</div>
                  <div class="h">{{ translate('core.telegramSluzhebnyyChat') }}</div>
                </div>
                <span class="optional-chip">{{ translate('core.telegramOptsionalno') }}</span>
              </div>

              <p class="muted sub"> {{ translate('core.telegramVyberiSvoyuLichkuS') }} </p>

              <fieldset class="native-editor" :disabled="!providerWritable || !!busy">
                <div class="service-control">
                  <UiSelect v-model="serviceChoice" class="sel">
                    <option value="">{{ translate('core.telegramNeVybranPeresylkiNe') }}</option>
                    <option v-for="o in serviceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </UiSelect>
                  <UiButton
                    v-if="serviceDirty"
                    class="btn primary"
                    variant="solid"
                    tone="success"
                    :loading="busy === 'service'"
                    :loading-label="translate('core.telegramSohranyayuSluzhebnyyChat')"
                    @click="saveService"
                  >
                    {{ busy === 'service' ? translate('core.telegramSohranyayu') : translate('core.save') }}
                  </UiButton>
                </div>
              </fieldset>

              <p v-if="!serviceOptions.length" class="muted sub"> {{ translate('core.telegramVybiratPokaNeIz') }} </p>
              <p v-else-if="!serviceSaved" class="muted sub"> {{ translate('core.telegramPokaChatNeVybran') }} </p>

              <details class="explain compact-explain">
                <summary>{{ translate('core.telegramZachemNuzhnaImennoLichka') }}</summary>
                <p class="muted sub"> {{ translate('core.telegramBotNaSekunduPeresylaet') }} </p>
              </details>
            </section>

            <!-- Пульт срочных реакций: карточки «работа стоит на тебе» и кнопки решений
                 в личке владельца. Владелец подтверждается 6-значным кодом. -->
            <section id="tg-pult" class="card pult-card">
              <div class="head compact-head">
                <div>
                  <div class="section-kicker">{{ translate('core.telegramUdalennyeResheniyaBezVps') }}</div>
                  <div class="h">{{ translate('core.telegramPult') }}</div>
                </div>
                <span v-if="pult?.confirmed" class="count">{{ translate('core.telegramVklyuchen') }}</span>
                <span v-else class="optional-chip">{{ translate('settings.disabled') }}</span>
              </div>

              <p class="muted sub"> {{ translate('core.telegramBotDerzhitVTvoey') }} </p>

              <template v-if="pult?.confirmed">
                <div class="state good" data-state="pult-on"> {{ translate('core.telegramPultSlushaetLichku') }} {{ pult.chatTitle || pult.chatHint }}.
                </div>
                <div class="row">
                  <UiButton
                    class="btn danger"
                    tone="danger"
                    :disabled="Boolean(busy)"
                    @click="pultDisable"
                  > {{ translate('core.telegramVyklyuchitPult') }} </UiButton>
                </div>
              </template>
              <template v-else>
                <fieldset class="native-editor" :disabled="!providerWritable || !!busy">
                  <div class="service-control">
                    <UiSelect v-model="pultChoice" class="sel">
                      <option value="">{{ translate('core.telegramVyberiSvoyuLichkuS2') }}</option>
                      <option v-for="o in pultOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                    </UiSelect>
                    <UiButton
                      class="btn primary"
                      variant="solid"
                      tone="success"
                      :disabled="!pultChoice"
                      :loading="busy === 'pult'"
                      :loading-label="translate('core.telegramOtpravlyayuKod')"
                      @click="pultRequest"
                    >
                      {{ busy === 'pult' ? translate('core.telegramOtpravlyayu') : translate('settings.getCode') }}
                    </UiButton>
                  </div>
                  <div v-if="pult?.pending" class="service-control pult-code" data-state="pult-pending">
                    <UiInput
                      v-model="pultCode"
                      class="code-input"
                      data-role="verification-code"
                      inputmode="numeric"
                      maxlength="6"
                      :placeholder="translate('core.telegramKodIzLichki')"
                      @keyup.enter="pultConfirm"
                    />
                    <UiButton
                      class="btn primary"
                      variant="solid"
                      tone="success"
                      :disabled="!pultCode.trim()"
                      :loading="busy === 'pult'"
                      :loading-label="translate('core.telegramVklyuchayuPult')"
                      @click="pultConfirm"
                    > {{ translate('core.usageConfirmOn') }} </UiButton>
                  </div>
                </fieldset>
                <p v-if="!pultOptions.length" class="muted sub"> {{ translate('core.telegramVybiratPokaNeIz2') }} </p>
                <p v-else-if="pult?.configured" class="muted sub"> {{ translate('core.telegramPrezhniyVybor') }}{{ pult.chatTitle || pult.chatHint }}{{ translate('core.telegramSohranenDlyaVklyucheniyaZaprosi') }} </p>
              </template>

              <details class="explain compact-explain">
                <summary>{{ translate('core.telegramGranitsyIBezopasnost') }}</summary>
                <p class="muted sub"> {{ translate('core.telegramUBotovNetSkvoznogo') }} </p>
              </details>
            </section>
          </aside>

          <!-- Allowlist: широкая карточка и явная последовательность «откуда → куда → автомат». -->
          <section id="tg-rules" class="card rules-card">
            <div v-if="!providerWritable" class="state warn" data-state="provider-read-only"> {{ translate('core.telegramProviderNePodklyuchenDlya') }} </div>
            <fieldset class="native-editor rules-editor" :disabled="!providerWritable || !!busy">
            <div class="head rules-head">
              <div>
                <div class="section-kicker">{{ translate('core.telegramDostupIMarshrutizatsiya') }}</div>
                <div class="section-title">
                  <span class="h">{{ translate('core.telegramRazreshennyeChaty') }}</span>
                  <span v-if="rules.length" class="count subtle">{{ rules.length }}</span>
                </div>
              </div>
              <UiButton class="btn" :disabled="Boolean(busy)" @click="addRule"> {{ translate('core.telegramDobavitChat') }} </UiButton>
            </div>

            <div class="rules-callout">
              <span class="callout-mark">!</span>
              <div>
                <b>{{ translate('core.telegramBotSlyshitChatNo') }}</b>
                <p class="muted sub"> {{ translate('core.telegramPraviloOdnovremennoRazreshaetChitat') }} </p>
              </div>
            </div>

            <div v-if="!rules.length" class="empty-rules">
              <div>
                <b>{{ translate('core.telegramNiOdinChatNe') }}</b>
                <p class="muted sub"> {{ translate('core.telegramDobavPervoePraviloVyberi') }} </p>
              </div>
              <UiButton
                class="btn primary"
                variant="solid"
                tone="success"
                :disabled="Boolean(busy)"
                @click="addRule"
              > {{ translate('core.telegramDobavitPervoePravilo') }} </UiButton>
            </div>

            <ol v-else class="rules">
              <li v-for="(r, i) in rules" :key="i" class="rule">
                <div class="rule-head">
                  <div>
                    <span class="rule-number">{{ translate('core.telegramPravilo') }} {{ i + 1 }}</span>
                    <b>{{ r.title || r.username || translate('core.telegramNovyyChat') }}</b>
                  </div>
                  <UiIconButton
                    class="icon-btn danger x"
                    role="embedded"
                    tone="danger"
                    :label="translate('core.telegramUbratPravilo')"
                    v-tooltip="translate('core.telegramUbratPravilo')"
                    @click="rules.splice(i, 1)"
                  >
                    ×
                  </UiIconButton>
                </div>

                <div class="rule-builder">
                  <section class="rule-part">
                    <div class="part-head">
                      <span class="part-number">1</span>
                      <div>
                        <b>{{ translate('core.telegramOtkudaChitat') }}</b>
                        <small>{{ translate('core.telegramRabochiyChatTselikomIli') }}</small>
                      </div>
                    </div>

                    <div class="field-grid source-fields">
                      <label class="control full">
                        <span class="field-label">{{ translate('core.telegramChat') }}</span>
                        <UiSelect
                          class="sel chat-select"
                          :model-value="chatMode(r)"
                          @update:model-value="setChat(r, $event)"
                        >
                          <option value="">{{ translate('core.telegramChatNeVybran') }}</option>
                          <option v-for="o in chatOptions" :key="o.value" :value="o.value">
                            {{ o.label }}
                          </option>
                          <option value="name">{{ translate('core.telegramPublichnyyChatPoImeni') }}</option>
                        </UiSelect>
                      </label>
                      <label v-if="chatMode(r) === 'name'" class="control">
                        <span class="field-label">{{ translate('core.telegramImyaPublichnogoChata') }}</span>
                        <UiInput
                          v-model="r.username"
                          class="inp thin"
                          spellcheck="false"
                          :placeholder="translate('core.telegramImyaChata')"
                        />
                      </label>
                      <div class="control topic-control">
                        <span class="field-label">{{ translate('core.telegramTema') }} <em>{{ translate('core.telegramNeobyazatelno') }}</em></span>
                        <UiSelect
                          class="sel thin topic-select"
                          compact
                          :disabled="!ruleChatId(r)"
                          :model-value="topicChoice(r)"
                          @focus="loadTopicsForRule(r, true)"
                          @update:model-value="setThread(r, $event)"
                        >
                          <option value="">{{ translate('core.telegramVsyaPerepiskaVseTemy') }}</option>
                          <option v-for="topic in topicsOf(r)" :key="topic.id" :value="String(topic.id)">
                            {{ topicLabel(topic) }}
                          </option>
                          <option
                            v-if="topicChoice(r) && !topicKnown(r)"
                            :value="topicChoice(r)"
                          > {{ translate('core.telegramTema') }} {{ topicChoice(r) }} {{ translate('core.telegramSohranenaVruchnuyu') }} </option>
                        </UiSelect>

                        <div class="topic-status muted">
                          <span v-if="!ruleChatId(r)">{{ translate('core.telegramSnachalaVyberiUslyshannyyChat') }}</span>
                          <span v-else-if="topicsBusy(r)">
                            <UiSpinner decorative /> {{ translate('core.telegramZagruzhayuTemy') }} </span>
                          <span v-else-if="topicsError(r)">{{ topicsError(r) }}</span>
                          <span v-else-if="topicsOf(r).length"> {{ translate('core.telegramNaydeno') }} {{ topicsOf(r).length }}.
                            <template v-if="topicsOf(r).some((topic) => !topic.title)"> {{ translate('core.telegramNazvaniyaPoyavyatsyaPosleNovogo') }} </template>
                            <template v-else>{{ translate('core.telegramSpisokObnovlyaetsyaPoSoobscheniyam') }}</template>
                          </span>
                          <span v-else-if="topicsLoaded(r)"> {{ translate('core.telegramTemPokaNeSlyshno') }} </span>
                          <UiButton
                            v-if="ruleChatId(r)"
                            class="link-btn"
                            variant="text"
                            tone="accent"
                            :disabled="topicsBusy(r)"
                            @click="loadTopicsForRule(r, true)"
                          > {{ translate('core.trackerUpdate') }} </UiButton>
                          <a
                            v-if="topicLink(r)"
                            :href="topicLink(r)"
                            target="_blank"
                            rel="noopener"
                          > {{ translate('core.telegramOtkrytVybrannuyuTemu') }} </a>
                        </div>

                        <details class="manual-topic">
                          <summary>{{ translate('core.telegramTemyNetVSpiske') }}</summary>
                          <label class="manual-topic-field">
                            <span class="field-label">{{ translate('core.telegramNomerIzSsylkiNa') }}</span>
                            <UiInput
                              v-model="r.threadId"
                              class="inp thin"
                              inputmode="numeric"
                              :placeholder="translate('core.telegramTemaNaprimer42')"
                            />
                          </label>
                        </details>
                      </div>
                    </div>

                    <p class="muted sub part-hint"> {{ translate('core.telegramGrigdeskPokazyvaetTemyV') }} </p>

                    <div class="agent-search-option">
                      <UiCheckbox
                        :checked="agentSearchStateKnown && r.agentSearch === true"
                        :disabled="dirty || !providerWritable || !!busy || !agentSearchStateKnown || !rulesPolicyFingerprint"
                        @change="setAgentSearch(r, $event)"
                      >
                        <span class="task-option-copy">
                          <b>{{ translate('core.telegramRazreshitAgentamIskatEtu') }}</b>
                          <small v-if="!agentSearchStateKnown" data-state="agent-search-unknown"> {{ translate('core.telegramSostoyanieDostupaNePodtverzhdeno') }} </small>
                          <small v-else> {{ translate('core.telegramOptInDlyaBuduschego') }} </small>
                        </span>
                      </UiCheckbox>
                    </div>
                  </section>

                  <section class="rule-part">
                    <div class="part-head">
                      <span class="part-number">2</span>
                      <div>
                        <b>{{ translate('core.telegramKudaSozdatZadachu') }}</b>
                        <small>{{ translate('core.telegramProektGrigdeskIParametry') }}</small>
                      </div>
                    </div>

                    <div class="field-grid destination-fields">
                      <label class="control project-control">
                        <span class="field-label">{{ translate('core.telegramProektGrigdesk') }} <em>{{ translate('core.telegramObyazatelno') }}</em></span>
                        <UiSelect v-model="r.project" class="sel project-select">
                          <option value="">{{ translate('core.telegramProektGrigdeskNeVybran') }}</option>
                          <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
                        </UiSelect>
                      </label>
                      <label class="control">
                        <span class="field-label">{{ translate('core.telegramTip') }}</span>
                        <UiSelect v-model="r.kind" class="sel thin" compact>
                          <option value="bug">{{ translate('core.telegramBag') }}</option>
                          <option value="wish">{{ translate('core.telegramIdeya') }}</option>
                        </UiSelect>
                      </label>
                      <label class="control">
                        <span class="field-label">{{ translate('core.telegramProektBitriks24') }} <em>{{ translate('core.telegramNeobyazatelno') }}</em></span>
                        <UiSelect
                          v-model="r.b24.groupId"
                          class="sel thin tracker-group-select"
                          compact
                        >
                          <option :value="null">
                            {{ trackerGroupsFailed ? translate('core.telegramBezProektaSpisokSeychas') : translate('core.telegramBezProektaBitriks24') }}
                          </option>
                          <option v-for="group in trackerGroupOptions" :key="group.id" :value="group.id">
                            {{ group.name }}
                          </option>
                        </UiSelect>
                      </label>
                      <label class="control responsible-control">
                        <span class="field-label">{{ translate('core.telegramOtvetstvennyy') }}</span>
                        <UiSelect v-model="r.b24.responsibleId" class="sel">
                          <option :value="null">{{ translate('core.telegramOtvetstvennyyYa') }}</option>
                          <option v-for="u in trackerUsers" :key="u.id" :value="u.id">{{ u.name }}</option>
                        </UiSelect>
                      </label>
                      <label class="control">
                        <span class="field-label">{{ translate('core.taskEditPriority') }}</span>
                        <UiSelect v-model.number="r.b24.priority" class="sel thin" compact>
                          <option :value="0">{{ translate('core.telegramNizkiy') }}</option>
                          <option :value="1">{{ translate('core.telegramSredniy') }}</option>
                          <option :value="2">{{ translate('core.telegramVysokiy') }}</option>
                        </UiSelect>
                      </label>
                    </div>

                    <p class="muted sub part-hint"> {{ translate('core.telegramProektGrigdeskOpredelyaetK') }} </p>

                    <div class="task-reply-option">
                      <UiCheckbox v-model="r.notifyTaskCreated">
                        <span class="task-option-copy">
                          <b>{{ translate('core.telegramSoobschatVTelegramO') }}</b>
                          <small> {{ translate('core.telegramPosleRuchnoyIliAvtomaticheskoy') }} </small>
                        </span>
                      </UiCheckbox>
                    </div>
                  </section>
                </div>

                <!-- Класс rrow и подпись lbl сохранены как явный контракт тестов формы. -->
                <div class="rrow auto-panel" :class="{ enabled: autoOf(r).enabled }">
                  <span class="lbl">{{ translate('core.telegramAvtomat') }}</span>
                  <div class="auto-copy">
                    <b>{{ translate('core.telegramAvtomatizatsiya') }}</b>
                    <span class="muted sub">{{ translate('core.telegramNeobyazatelnoSnachalaMozhnoRazbirat') }}</span>
                  </div>
                  <div class="chk">
                    <UiCheckbox
                      :checked="autoOf(r).enabled"
                      @update:checked="setAuto(r, 'enabled', $event)"
                    > {{ translate('core.telegramZavoditZadachiBezMenya') }} </UiCheckbox>
                  </div>
                  <template v-if="autoOf(r).enabled">
                    <label class="num"> {{ translate('core.telegramUverennostOt') }} <UiNumberInput
                        class="inp num-f"
                        :model-value="pctOf(r)"
                        min="0"
                        max="100"
                        @update:model-value="setPct(r, $event)"
                      />
                      %
                    </label>
                    <label class="num"> {{ translate('core.telegramNeBolshe') }} <UiNumberInput
                        class="inp num-f"
                        :model-value="autoOf(r).maxPerDay"
                        min="0"
                        max="100"
                        @update:model-value="setCap(r, $event)"
                      /> {{ translate('core.telegramZadachVSutki') }} </label>
                  </template>
                </div>
              </li>
            </ol>

            <details v-if="rules.length" class="explain rules-explain">
              <summary>{{ translate('core.telegramKakBezopasnoVklyuchatAvtomat') }}</summary>
              <p class="muted sub"> {{ translate('core.telegramVklyuchayEgoTolkoDlya') }} </p>
            </details>

            <div v-if="dirty" class="savebar">
              <span>{{ translate('core.telegramIzmeneniyaEscheNePrimeneny') }}</span>
              <div class="row">
                <UiButton
                  class="btn primary"
                  variant="solid"
                  tone="success"
                  :disabled="Boolean(busy)"
                  :loading="busy === 'rules'"
                  :loading-label="translate('core.telegramSohranyayuPravila')"
                  @click="saveRules"
                >
                  {{ busy === 'rules' ? translate('core.telegramSohranyayu') : translate('core.save') }}
                </UiButton>
                <UiButton class="btn" :disabled="Boolean(busy)" @click="loadRules"> {{ translate('core.trackerCancel') }} </UiButton>
              </div>
            </div>
            </fieldset>
          </section>
        </div>
      </template>

      <!-- Первое подключение: два шага стоят рядом и не требуют знания архитектуры. -->
      <template v-else-if="!loading">
        <div class="setup-grid">
          <section class="card setup-card token-card">
            <div class="setup-card-head">

              <div>
                <div class="section-kicker">{{ translate('core.telegramVGrigdesk') }}</div>
                <div class="h">{{ translate('core.telegramVstavTokenIPodklyuchi') }}</div>
              </div>
            </div>

            <p class="muted"> {{ translate('core.telegramGrigdeskSnachalaProveritToken') }} </p>

            <label class="control token-control">
              <span class="field-label">{{ translate('core.telegramTokenOtBotfather') }}</span>
              <UiInput
                v-model="token"
                class="inp"
                type="password"
                data-role="secret-token"
                autocomplete="off"
                spellcheck="false"
                :placeholder="'8123456789:AA…'"
                @keydown.enter="connect"
              />
            </label>
            <UiButton
              class="btn primary connect-btn"
              variant="solid"
              tone="success"
              :disabled="!canConnect || !token.trim() || Boolean(busy)"
              :loading="busy === 'connect'"
              :loading-label="translate('core.telegramProveryayuToken')"
              @click="connect"
            >
              {{ busy === 'connect' ? translate('core.telegramProveryayuToken2') : translate('core.telegramPodklyuchit') }}
            </UiButton>

            <div class="state" :class="providerConnection === 'degraded' ? 'warn' : ''"
                 data-state="provider-disconnected"> {{ translate('core.telegramTelegramNePodklyuchenNovye') }} <template v-if="providerReason"> {{ translate('core.telegramPrichina') }} {{ providerReason }}.</template>
            </div>

            <div class="security-note">
              <b>{{ translate('core.telegramTokenOstanetsyaNaServere') }}</b>
              <span> {{ translate('core.telegramVBrauzerVernutsyaTolko') }} <code>{{ '/revoke' }}</code>.
              </span>
            </div>

            <details class="technical">
              <summary>{{ translate('core.telegramGdeHranitsyaToken') }}</summary>
              <div class="muted sub technical-data"> {{ translate('core.telegramVFayle') }} <code>{{ 'state/telegram-account-creds.json' }}</code> {{ translate('core.telegramVPapkeDannyhDostupnom') }} </div>
            </details>
          </section>
          <details class="card setup-card setup-guide">
            <summary class="setup-card-head">

              <div>
                <div class="section-kicker">{{ translate('core.telegramVTelegrame') }}</div>
                <div class="h">{{ translate('core.telegramSozdayOtdelnogoBota') }}</div>
              </div>
            </summary>

            <ol class="steps">
              <li>
                <span class="step-mark">1</span>
                <span>{{ translate('core.telegramNaydi') }} <b>{{ translate('core.telegramBotfather') }}</b> {{ translate('core.telegramSSineyGalochkoyI') }} <code>{{ '/newbot' }}</code>.</span>
              </li>
              <li>
                <span class="step-mark">2</span>
                <span>{{ translate('core.telegramZadayVidimoeLyudyamImya') }}</span>
              </li>
              <li>
                <span class="step-mark">3</span>
                <span>{{ translate('core.telegramZadayImyaPolzovatelyaLatinitsey') }} <code>{{ 'bot' }}</code>.</span>
              </li>
              <li>
                <span class="step-mark">4</span>
                <span>{{ translate('core.telegramSkopiruyPrislannyyTokenVida') }} <code>{{ '8123456789:AA…' }}</code>.</span>
              </li>
              <li>
                <span class="step-mark">5</span>
                <span>{{ translate('core.telegramOtprav') }} <code>{{ '/setprivacy' }}</code>{{ translate('core.telegramVyberiBotaINazhmi') }} <b>{{ translate('core.telegramDisable') }}</b>{{ translate('core.telegramChtobyOnVidelObychnye') }}</span>
              </li>
            </ol>

            <div class="info-note"> {{ translate('core.telegramBotaNelzyaSozdatKnopkoy') }} </div>
          </details>


        </div>

        <section class="after-connect">
          <div class="after-title">{{ translate('core.telegramChtoProizoydetPoslePodklyucheniya') }}</div>
          <div class="after-grid">
            <div class="after-step">
              <span>1</span>
              <div><b>{{ translate('core.telegramDobavishBotaVChat') }}</b><small>{{ translate('core.telegramKakObychnogoUchastnikaGruppy') }}</small></div>
            </div>
            <div class="after-step">
              <span>2</span>
              <div><b>{{ translate('core.telegramVybereshProekt') }}</b><small>{{ translate('core.telegramGrigdeskNeOtkroetChat') }}</small></div>
            </div>
            <div class="after-step">
              <span>3</span>
              <div><b>{{ translate('core.telegramVklyuchishPriemVInbox') }}</b><small>{{ translate('core.telegramStarayaIstoriyaNeStanet') }}</small></div>
            </div>
          </div>
        </section>
      </template>
    </template>
    </div>
  </UiWorkspacePage>
</template>

<script setup lang="ts">
import TelegramLoading from './TelegramLoading.vue';

// Native-раздел канала Telegram: подключение бота, услышанные чаты, служебная
// личка и allowlist «чат/тема → проект». Общая очередь и её activation живут
// отдельно на `/inbox`; Telegram не владеет её карточками, решениями и моделью.
//
// Бот не ведёт диалог и не задаёт уточняющих вопросов. Единственное исходящее
// сообщение — явно включённое у конкретного правила подтверждение уже созданной
// задачи с номером и ссылкой на Битрикс24.
//
// Почему нет кнопки «создать бота»: у Телеграма нет API создания ботов вовсе —
// бот заводится только личной перепиской человека с @BotFather. GrigDesk берёт
// на себя всё, что после: проверяет токен через getMe, называет бота по имени
// и кладёт секрет в state/ папки данных с правами 0600. Терминал для этого не нужен.
//
// Правила «чат или тема → проект» — не настройка удобства, а разрешение читать:
// без правила ссылку на чат не развернёт никто. Поэтому редактор ничего не
// придумывает за человека (пустой список значит «закрыто везде») и правит список
// целиком: сервер и проверяет его целиком, одним валидатором.
import { computed, onMounted, ref, watch } from 'vue';

import { errorMessage } from '../../../shared/lib/errors.ts';

import {
  confirmDialog, UiActionLink, UiButton, UiCheckbox, UiIconButton, UiInput, UiNumberInput,
  UiWorkspacePage, UiSelect, UiSpinner, vTooltip, t as translate, messageRef, uiLocale
} from '../ui';
import { api } from '../shared/apiClient.ts';
import { telegramApi, telegramPluginDisabled } from '../shared/telegramApi.ts';
import { isTelegramPolicyFingerprint } from '../../../shared/telegram/telegramContracts.ts';
import type {
  TelegramBot,
  TelegramChat,
  TelegramPoll,
  TelegramPult,
  TelegramRule,
  TelegramRules,
  TelegramStatus,
  TelegramTopic,
} from '../../../shared/telegram/telegramContracts.ts';
import { usePluginsStore } from '../stores/plugins.ts';

// Состояние канала закрыто перечислением на границе сети: «подключается» и
// «отвалился» ведут человека к разным действиям, и своего значения раздел не
// придумывает — он показывает ровно то, что назвал сервер.
type ConnectionState = NonNullable<TelegramStatus['connection']>;

// Что раздел сейчас делает. Пустая строка — «ничего»: одновременных операций у
// формы нет, поэтому одного поля хватает и на блокировку, и на подпись кнопки.
type BusyKind = '' | 'connect' | 'recheck' | 'disconnect' | 'rules' | 'agent-search'
  | 'service' | 'pult';

// Половина автомата у правила: включён ли, с какого порога уверенности заводить
// задачу и сколько таких задач в сутки. Границы те же, что у сервера.
interface AutoTaskForm {
  enabled: boolean;
  minConfidence: number;
  maxPerDay: number;
}

// Правило в форме — та же запись, что и в контракте, но с промежуточными
// состояниями полей ввода: пока адрес не выбран, он законно пуст, а `null` и
// пустая строка значат разное — «адреса нет» против «имя ещё не введено».
type RuleForm = Omit<TelegramRule, 'draft' | 'autoLaunch' | 'agentSearch' | 'b24'> & {
  // Поля сервера, которых у нового правила нет вовсе: дописывать их пустыми
  // значило бы отправить на сохранение то, чего человек не заполнял.
  draft?: TelegramRule['draft'];
  autoLaunch?: TelegramRule['autoLaunch'];
  // Доступ агентов правит только своя ручка, и обычное сохранение его снимает
  // из тела запроса целиком — значит поле обязано быть удаляемым.
  agentSearch?: boolean | null;
  b24: {
    responsibleId: number | null;
    groupId: number | null;
    priority: number;
  };
};

// Ростер и проекты портала приходят из соседнего раздела и своего контракта
// здесь не имеют: разделу «Телеграма» нужны только имя и числовой id.
interface TrackerUser {
  id: number;
  name: string;
}

interface TrackerGroup {
  id?: unknown;
  name?: unknown;
}

// Проект в селекте правила. `missing` помечает сохранённый, но сейчас
// недоступный: подменять такой на «без проекта» нельзя — правило уедет не туда.
interface TrackerGroupOption {
  id: number;
  name: string;
  missing: boolean;
}

// Что написать про опрос. Вид подсказки — часть данных, а не только цвет:
// «слушает» и «не идёт» ведут человека к разным действиям.
interface PollNote {
  kind: 'good' | 'warn';
  text: string;
}

const plugins = usePluginsStore();

if (!plugins.loaded) {
  plugins.load();
}

const pluginOff = computed(() => plugins.loaded && !plugins.enabled('telegram'));

const bot = ref<TelegramBot | null>(null);
const poll = ref<TelegramPoll | null>(null);   // подключённый бот и идущий опрос — разное
const providerConnection = ref<ConnectionState>('disconnected');
const providerReason = ref('');
const chats = ref<TelegramChat[]>([]);         // что бот уже слышал
const rules = ref<RuleForm[]>([]);             // рабочая копия: правится на месте, уезжает целиком
const savedRules = ref('[]');                  // слепок сервера — по нему видно несохранённое
// CAS именно содержимого policy, а не времени загрузки и не mutable bot display.
// Без него старая вкладка могла целиком перезаписать более новое разрешение.
const rulesPolicyFingerprint = ref('');
// После ambiguous PUT старое значение agentSearch нельзя показывать как факт,
// пока отдельный GET rules не подтвердил policy и её новый CAS fingerprint.
const agentSearchStateKnown = ref(false);
const projects = ref<string[]>([]);
const loading = ref(true);
const token = ref('');
const busy = ref<BusyKind>('');
const error = ref('');
const note = ref('');

const connected = computed(() => !!bot.value?.configured);
const providerWritable = computed(() => connected.value && providerConnection.value === 'connected');
const canConnect = computed(() => providerConnection.value !== 'degraded');
// undefined — старая запись без этого поля: выдумывать состояние приватности нельзя.
const privacyKnown = computed(() => typeof bot.value?.canReadAllGroupMessages === 'boolean');

// Двe меры времени, и путать их нельзя: своё состояние GrigDesk считает в
// миллисекундах, а даты сообщений приходят от Bot API в секундах и такими же
// лежат в архиве. Поэтому две функции с явными именами, а не одна «универсальная».
function fmtMs(ms: number | null | undefined): string {
  if (!ms) {
    return '';
  }

  return new Date(ms).toLocaleString(uiLocale.value, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtSec(sec: number | null | undefined): string {
  return fmtMs(Number(sec || 0) * 1000);
}

// Русское склонение по числу: «1 правило», «2 правила», «5 правил». Формы
// приходят от места вызова — общего словаря на раздел заводить незачем.
function plural(n: number | null | undefined, forms: readonly [string, string, string]): string {
  const a = Math.abs(n ?? 0) % 100;
  const b = a % 10;

  if (a > 10 && a < 20) {
    return forms[2];
  }
  if (b > 1 && b < 5) {
    return forms[1];
  }

  return b === 1 ? forms[0] : forms[2];
}

const CHAT_KIND: Record<string, string> = {
  get private() {
    return translate('core.telegramLichnyyChat');
  },
  get group() {
    return translate('core.telegramGruppa');
  },
  get supergroup() {
    return translate('core.telegramSupergruppa');
  },
  get channel() {
    return translate('core.telegramKanal');
  },
};

const chatKind = (c: TelegramChat) => [
  CHAT_KIND[c.type ?? ''] || c.type || translate('core.telegramChatWord'),
  c.isForum ? translate('core.coreSTemami') : '',
].filter(Boolean).join(', ');

// Что написать про опрос. Отдельно от «бот подключён»: токен может быть цел, а
// апдейты забирать второй экземпляр — тогда сообщения не придут вообще, и это
// должно быть видно словами, а не отсутствием чатов в списке.
const pollState = computed<PollNote | null>(() => {
  if (connected.value && !providerWritable.value) {
    return {
      kind: 'warn',
      text: translate('core.telegramProviderSeychasNeGotov'),
    };
  }

  const p = poll.value;

  if (!p) {
    return null;
  }
  if (p.lastError) {
    return { kind: 'warn', text: p.lastError.message };
  }
  if (!p.running) {
    return {
      kind: 'warn',
      text: translate('core.telegramOprosNeIdetServer'),
    };
  }

  const parts = [translate('core.coreBotSlushaetTelegram')];

  if (p.lastMessageAt) {
    parts.push(
      translate('core.corePosledneeSoobschenieLastmessageat', { lastMessageAt: fmtMs(p.lastMessageAt) }),
    );
  } else if (p.lastPollAt) {
    parts.push(translate('core.coreSoobscheniyPokaNeBylo', { lastPollAt: fmtMs(p.lastPollAt) }));
  }

  return { kind: 'good', text: parts.join(' ') };
});

// Список чатов вторичен и грузится отдельно от статуса: бот подключён и без
// него, а отказ архива не должен стирать с экрана рабочее подключение.
async function loadChats(): Promise<void> {
  try {
    chats.value = await telegramApi.chats();
  } catch (e) {
    // Список чатов вторичен: из-за него не должно пропадать подключение бота.
    if (!telegramPluginDisabled(e)) {
      error.value = errorMessage(e, translate('core.coreNeUdalosZagruzitSpisok'));
    }
  }
}

// --- служебный чат ---

// Куда бот пересылает сам себе сообщение, которого нет в архиве (копия удаляется
// сразу). Выбор закрыт с двух сторон, и обе — про утечку: произвольный номер тут
// значил бы «шли рабочую переписку, куда скажу», а групповой чат не годится даже
// свой — служебная копия видна всем участникам, и уведомление о ней успевает
// уйти до удаления. Поэтому в списке только личка, которую бот уже слышал.
const serviceOptions = computed(() => {
  const out = new Map<string, string>();

  for (const c of chats.value) {
    if (c.type === 'private') {
      out.set(String(c.id), c.title || translate('core.telegramChatId', { id: String(c.id) }));
    }
  }

  // Назначенный чат остаётся в списке, даже если архив о нём молчит: иначе селект
  // показывал бы «не выбран» при работающей пересылке.
  const cur = bot.value?.serviceChatId;

  if (cur && !out.has(String(cur))) {
    out.set(
      String(cur),
      bot.value?.serviceChatTitle || translate('core.telegramChatId', { id: String(cur) }),
    );
  }

  return [...out].map(([value, label]) => ({ value, label }));
});

const serviceChoice = ref('');
const serviceSaved = computed(() => (bot.value?.serviceChatId ? String(bot.value.serviceChatId) : ''));

// Селект идёт за сервером: bot.value присваивается в пяти местах (загрузка,
// подключение, перепроверка, отключение, само сохранение), и ловить их поимённо
// — верный способ забыть одно.
watch(serviceSaved, (id) => {
  serviceChoice.value = id;
}, { immediate: true });

const serviceDirty = computed(() => serviceChoice.value !== serviceSaved.value);

// Пересылка служебной копии включается и снимается одной ручкой: сервер отвечает
// уже нормализованным ботом, и подпись под селектом берётся из его ответа.
async function saveService(): Promise<void> {
  if (busy.value || !providerWritable.value) {
    return;
  }

  busy.value = 'service';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.setServiceChat(
      bot.value?.botId,
      serviceChoice.value ? Number(serviceChoice.value) : null,
    );

    bot.value = res.bot;
    note.value = bot.value.serviceChatId
      ? translate('core.coreSluzhebnyyChatServicechatid', { serviceChatId: bot.value.serviceChatTitle
                      || bot.value.serviceChatId })
      : translate('core.coreSluzhebnyyChatSnyatPeresylat');
  } catch (e) {
    error.value = errorMessage(e, translate('core.coreNeUdalosSohranitSluzhebnyy'));
    // Отказ сервера не должен оставлять в селекте то, чего сервер не принял.
    serviceChoice.value = serviceSaved.value;
  } finally {
    busy.value = '';
  }
}

// --- пульт: карточки и кнопки решений в личке владельца ---

// Блок `pult` приходит из /api/telegram/status и не содержит сырого id чата
// (маска + заголовок). Владелец — только личка, которую бот уже слышал,
// включение — 6-значным кодом в неё же (двустороннее доказательство владения).
const pult = ref<TelegramPult | null>(null);
const pultChoice = ref('');
const pultCode = ref('');

const pultOptions = computed(() => chats.value
  .filter((c) => c.type === 'private')
  .map((c) => ({ value: String(
    c.id,
  ), label: c.title || translate('core.telegramChatId', { id: String(c.id) }) })));

// Запрос кода: сервер шлёт его в саму личку, и это первая половина доказательства
// владения — вторая приходит обратно введённым кодом.
async function pultRequest(): Promise<void> {
  if (busy.value || !providerWritable.value || !pultChoice.value) {
    return;
  }

  busy.value = 'pult';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.requestPult(bot.value?.botId, Number(pultChoice.value));

    pult.value = res.pult;
    note.value = translate('core.coreKodOtpravlenVLichku');
  } catch (e) {
    error.value = errorMessage(e, translate('core.coreNeUdalosOtpravitKod'));
  } finally {
    busy.value = '';
  }
}

// Подтверждение кода включает пульт. Текст отказа сервер уже пишет по-человечески
// (код не совпал, код протух), поэтому наружу он идёт как есть.
async function pultConfirm(): Promise<void> {
  if (busy.value || !providerWritable.value || !pultCode.value.trim()) {
    return;
  }

  busy.value = 'pult';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.confirmPult(bot.value?.botId, pultCode.value.trim());

    pult.value = res.pult;
    pultCode.value = '';
    note.value = translate('core.corePultVklyuchenBotSlushaet', {
      chatHint: pult.value?.chatTitle || pult.value?.chatHint || '',
    });
  } catch (e) {
    // Текст сервера уже человеческий (код не совпал / протух) — показываем как есть.
    error.value = errorMessage(e, translate('core.coreNeUdalosVklyuchitPult'));
  } finally {
    busy.value = '';
  }
}

// Выключение пульта спрашивает человека: выбор чата переживёт выключение, а вот
// код придётся получать заново, и молча терять его нельзя.
async function pultDisable(): Promise<void> {
  const ok = await confirmDialog(
    messageRef('core.telegramVyklyuchitPultBotPerestanet'),
    {
      danger: true,
      okText: translate('core.usageConfirmOff'),
    },
  );

  if (!ok || busy.value) {
    return;
  }

  busy.value = 'pult';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.disablePult(bot.value?.botId);

    pult.value = res.pult;
    note.value = translate('core.corePultVyklyuchen');
  } catch (e) {
    error.value = errorMessage(e, translate('core.coreNeUdalosVyklyuchitPult'));
  } finally {
    busy.value = '';
  }
}

// --- правила «чат или тема → проект» ---

const trackerUsers = ref<TrackerUser[]>([]);

// Ростер портала для селекта ответственного. Пустой список — не беда: задача
// без ответственного уходит на владельца сессии, и это разумный дефолт.
async function loadUsers(): Promise<void> {
  try {
    const res = await api.get('/api/tracker/users') as { users?: TrackerUser[] };

    trackerUsers.value = res?.users || [];
  } catch {
    // Портал не настроен или не отвечает — правила от этого не ломаются.
  }
}

const trackerGroups = ref<TrackerGroup[]>([]);
const trackerGroupsFailed = ref(false);

// Проекты портала для GROUP_ID задачи. В форме показываем имена, числовой id
// остаётся только значением option и уезжает в уже существующий контракт правила.
async function loadGroups(): Promise<void> {
  try {
    const res = await api.get('/api/tracker/groups') as { groups?: TrackerGroup[] };

    trackerGroups.value = res?.groups || [];
    trackerGroupsFailed.value = false;
  } catch {
    // Сохранённые правила всё равно остаются редактируемыми: ниже подмешиваем
    // неизвестный id отдельным option, а новый проект просто нельзя выбрать.
    trackerGroupsFailed.value = true;
  }
}

/**
 * Положительное целое из поля ввода; пусто и мусор — «не задано».
 *
 * Ноль и отрицательное тоже «не задано»: id ответственного и проекта портал
 * нумерует с единицы, а нулём поле обнулилось бы молча.
 */
function toId(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') {
    return null;
  }

  const n = Number(v);

  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Проект могли архивировать или убрать из доступных уже после сохранения правила.
// Не подменяем такое значение на «без проекта» при следующей несвязанной правке.
const trackerGroupOptions = computed<TrackerGroupOption[]>(() => {
  const out = new Map<number, TrackerGroupOption>();

  for (const group of trackerGroups.value) {
    const id = toId(group?.id);
    const name = String(group?.name || '').trim();

    if (id && name) {
      out.set(id, {
        id,
        name,
        missing: false,
      });
    }
  }

  for (const rule of rules.value) {
    const id = toId(rule.b24?.groupId);

    if (id && !out.has(id)) {
      out.set(id, {
        id,
        name: translate('core.coreProektIdSohranenNo', { id: id }),
        missing: true,
      });
    }
  }

  return [...out.values()];
});

// --- автомат «заводить задачи без меня» ---

// Те же дефолты, что у сервера (lib/telegram/rulesStore.ts). Копия здесь
// осознанная: форма обязана показать новое правило до того, как сервер его
// увидит, а тянуть ради трёх чисел общий модуль в браузер незачем.
const AUTO_TASK: AutoTaskForm = {
  enabled: false,
  minConfidence: 0.7,
  maxPerDay: 10,
};

/**
 * Число в границах; «не задано» — это дефолт, а НЕ ноль.
 *
 * Тот же довод, что на сервере: в полях ввода всё строки, стёртое поле приезжает
 * пустой строкой, а `Number('')` — ноль. Нулевой порог означал бы «заводи задачу
 * по любому разбору» — стирание поля не имеет права ослаблять автомат.
 */
function toNum(v: unknown, lo: number, hi: number, def: number): number {
  if (v === null || v === undefined || String(v).trim() === '') {
    return def;
  }

  const n = Number(v);

  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

/** Половина автомата у правила. Читаем, не дописывая: правило могло приехать без неё. */
const autoOf = (r: RuleForm): AutoTaskForm => (
  r.autoTask && typeof r.autoTask === 'object' ? r.autoTask : AUTO_TASK
);

function setAuto(r: RuleForm, key: keyof AutoTaskForm, value: boolean | number): void {
  r.autoTask = { ...autoOf(r), [key]: value } as AutoTaskForm;
}

// Порог показываем процентами: «0.7» человек читает хуже, чем «70».
const pctOf = (r: RuleForm) => Math.round(
  toNum(autoOf(r).minConfidence, 0, 1, AUTO_TASK.minConfidence) * 100,
);

function setPct(r: RuleForm, value: unknown): void {
  setAuto(r, 'minConfidence', Math.round(toNum(value, 0, 100, AUTO_TASK.minConfidence * 100)) / 100);
}

function setCap(r: RuleForm, value: unknown): void {
  setAuto(r, 'maxPerDay', Math.round(toNum(value, 0, 100, AUTO_TASK.maxPerDay)));
}

/**
 * То, что уедет на сервер. Форма приводится здесь, а не в разметке: в полях
 * ввода всё строки, а правило хранит числа — иначе тема «42» приехала бы
 * строкой, а стёртое поле пустой строкой вместо «весь чат».
 */
function payload(): unknown[] {
  return rules.value.map((r) => {
    // agentSearch server-owned для обычного PUT: его меняет только отдельный
    // opt-in endpoint. Иначе несвязанная правка B24 могла бы снять или выдать
    // агентский доступ одним spread старой формы.
    const humanRule = { ...r };

    delete humanRule.agentSearch;

    const thread = Number(r.threadId);
    const chatId = Number(r.chatId);
    const trackerSettings = r.b24 || {};
    const priority = Number(trackerSettings.priority);

    return {
      ...humanRule,
      project: String(r.project || '').trim(),
      chatId: r.chatId === null || r.chatId === undefined
        || String(r.chatId) === '' || !Number.isSafeInteger(chatId)
        ? null
        : chatId,
      // Пустое поле имени — это «имя ещё не введено», а не имя из пустой строки.
      username: String(r.username ?? '').trim() || null,
      threadId: Number.isSafeInteger(thread) && thread > 0 ? thread : null,
      kind: r.kind === 'wish' ? 'wish' : 'bug',
      b24: {
        ...trackerSettings,
        responsibleId: toId(trackerSettings.responsibleId),
        groupId: toId(trackerSettings.groupId),
        priority: [0, 1, 2].includes(priority) ? priority : 1,
      },
      // Границы повторяют серверные, чтобы сохранение не возвращало другие числа
      // и «есть несохранённое» не загоралось сразу после успешного сохранения.
      autoTask: {
        ...autoOf(r),
        enabled: !!autoOf(r).enabled,
        minConfidence: toNum(autoOf(r).minConfidence, 0, 1, AUTO_TASK.minConfidence),
        maxPerDay: Math.round(toNum(autoOf(r).maxPerDay, 0, 100, AUTO_TASK.maxPerDay)),
      },
      notifyTaskCreated: r.notifyTaskCreated === true,
    };
  });
}

// «Есть несохранённое» считаем по тому, что уедет, а не по буквам в полях:
// стёртая и заново набранная тема — это не изменение.
const dirty = computed(() => JSON.stringify(payload()) !== savedRules.value);

// Чаты для выбора: услышанные плюс те, что уже привязаны правилом. Второе
// обязательно — бота могли убрать из чата, и без своей строки правило нельзя
// было бы ни увидеть, ни снять, хотя разрешение продолжает действовать.
const chatOptions = computed(() => {
  const out = new Map<number, string>();

  for (const c of chats.value) {
    out.set(c.id, c.title || translate('core.telegramChatId', { id: String(c.id) }));
  }

  for (const r of rules.value) {
    if (r.chatId !== null && r.chatId !== undefined && !out.has(Number(r.chatId))) {
      out.set(Number(r.chatId), r.title || translate('core.telegramChatId', { id: String(r.chatId) }));
    }
  }

  return [...out].map(([id, label]) => ({ value: `id:${id}`, label }));
});

// HTTP Bot API не умеет перечислять форумные темы. Сервер собирает их из
// `message_thread_id` уже услышанных сообщений и отдаёт только для выбранного
// чата — так открытие страницы не сканирует архивы всех групп подряд.
const topicsByChat = ref<Record<string, TelegramTopic[]>>({});
const topicLoading = ref<Record<string, boolean>>({});
const topicErrors = ref<Record<string, string>>({});

// Числовой id чата у правила: либо задан прямо, либо ищется по публичному имени
// среди услышанных — у ссылки `t.me/имя` числового id нет вовсе.
function ruleChatId(r: RuleForm): number | null {
  const direct = Number(r.chatId);

  if (Number.isSafeInteger(direct) && direct !== 0) {
    return direct;
  }

  const username = String(r.username || '').replace(/^@/, '').toLowerCase();

  if (!username) {
    return null;
  }

  return chats.value.find((c) => String(c.username || '').toLowerCase() === username)?.id ?? null;
}

const topicKey = (chatId: number | null) => String(chatId);
const topicsOf = (r: RuleForm) => topicsByChat.value[topicKey(ruleChatId(r))] || [];
const topicsLoaded = (r: RuleForm) => Object.prototype.hasOwnProperty.call(
  topicsByChat.value, topicKey(ruleChatId(r)),
);
const topicsBusy = (r: RuleForm) => !!topicLoading.value[topicKey(ruleChatId(r))];
const topicsError = (r: RuleForm) => topicErrors.value[topicKey(ruleChatId(r))] || '';
const topicChoice = (r: RuleForm) => (toId(r.threadId) ? String(toId(r.threadId)) : '');
const topicKnown = (r: RuleForm) => topicsOf(r).some((t) => t.id === toId(r.threadId));

const topicLabel = (t: TelegramTopic) => {
  if (t.title) {
    return translate('core.coreTitleTemaId', { title: t.title, id: t.id });
  }

  const count = Number(t.messages || 0);

  return translate('core.coreTemaIdCountPluralcount', {
                          id: t.id,
                          count: count,
                          pluralcount: translate('core.telegramMessageWord', { count }),
                        });
};

/**
 * Корень темы открывается как обычное сообщение с id, равным thread_id.
 *
 * Публичный чат адресуется именем, приватная супергруппа — своим `-100`-номером;
 * всё остальное ссылки не имеет, и выдумывать её вместо пустой строки нельзя.
 */
function topicLink(r: RuleForm): string {
  const threadId = toId(r.threadId);
  const chatId = ruleChatId(r);

  if (!threadId || chatId === null) {
    return '';
  }

  const chat = chats.value.find((c) => Number(c.id) === Number(chatId));
  const username = String(chat?.username || r.username || '').replace(/^@/, '').trim();

  if (/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username)) {
    return `https://t.me/${username}/${threadId}`;
  }

  const id = String(chatId);

  return /^-100\d+$/.test(id) ? `https://t.me/c/${id.slice(4)}/${threadId}` : '';
}

// Темы одного чата. Повторный заход по тому же чату молчит, если справочник уже
// прочитан: `force` нужен кнопке «обновить», а обычное открытие правила — нет.
async function loadTopics(chatId: unknown, { force = false }: { force?: boolean } = {}): Promise<void> {
  const id = Number(chatId);

  if (!Number.isSafeInteger(id) || id === 0) {
    return;
  }

  const key = topicKey(id);
  const known = Object.prototype.hasOwnProperty.call(topicsByChat.value, key);

  if (topicLoading.value[key] || (!force && known)) {
    return;
  }

  topicLoading.value[key] = true;
  topicErrors.value[key] = '';

  try {
    topicsByChat.value[key] = await telegramApi.topics(id);
  } catch (e) {
    // Ручной ввод остаётся рабочим даже со старым сервером или временной ошибкой
    // архива; общей красной плашкой вторичный справочник страницу не перекрывает.
    topicErrors.value[key] = errorMessage(e, translate('core.coreNeUdalosZagruzitTemy'));
  } finally {
    topicLoading.value[key] = false;
  }
}

const loadTopicsForRule = (r: RuleForm, force = false) => loadTopics(ruleChatId(r), { force });

async function loadRuleTopics(): Promise<void> {
  const ids = [...new Set(rules.value.map(ruleChatId).filter((id) => id !== null))];

  await Promise.all(ids.map((id) => loadTopics(id)));
}

function setThread(r: RuleForm, value: string | number | null): void {
  r.threadId = value === '' ? null : toId(value);
}

// Проект из правила, которого нет в списке (переименовали, убрали профиль),
// показываем как есть: пустой селект означал бы «проект не выбран», и первое
// же сохранение увело бы правило не туда.
const projectOptions = computed(() => {
  const out = new Set(projects.value);

  for (const r of rules.value) {
    if (r.project) {
      out.add(r.project);
    }
  }

  return [...out];
});

// Чем адресован чат правила: номером из списка, публичным именем или ничем.
// Пустая строка и «name» — разные состояния, и селект обязан их различать.
const chatMode = (r: RuleForm) => {
  if (r.chatId !== null && r.chatId !== undefined && String(r.chatId) !== '') {
    return `id:${r.chatId}`;
  }

  return r.username === null || r.username === undefined ? '' : 'name';
};

// Смена адреса обнуляет всё, что к нему привязано: заголовок и тема относятся к
// прежнему чату, и оставить их значило бы показать правило чужим местом.
function setChat(r: RuleForm, value: string | number | null): void {
  // Селект отдаёт строку, число или «не выбрано»: приводим один раз, иначе
  // пустое значение пришлось бы ловить отдельной веткой в каждом сравнении.
  const choice = String(value ?? '');

  r.title = '';
  r.threadId = null;

  if (choice === 'name') {
    // Публичный чат привязывается именем: в ссылке t.me/имя числового id нет вовсе.
    r.chatId = null;
    r.username = '';

    return;
  }

  r.username = null;
  r.chatId = choice ? Number(choice.slice(3)) : null;

  const known = chatOptions.value.find((o) => o.value === choice);

  if (known) {
    r.title = known.label;
  }
  if (r.chatId !== null) {
    loadTopics(r.chatId);
  }
}

// Новое правило заводится закрытым: ни ответов в чат, ни доступа агентов, ни
// автомата — каждое из трёх включается отдельным осознанным решением.
function addRule(): void {
  if (!providerWritable.value) {
    return;
  }

  rules.value.push({
    project: '',
    chatId: null,
    username: null,
    title: '',
    threadId: null,
    // Вид по умолчанию — баг: тема с жалобами и есть главный источник поводов,
    // «Идея» ставится осознанно. Приоритет 1 — средний, коды портала: 0/1/2.
    kind: 'bug',
    b24: {
      responsibleId: null,
      groupId: null,
      priority: 1,
    },
    // Ответы выключены: включение — осознанное решение для конкретного чата/темы.
    notifyTaskCreated: false,
    // Human allowlist не подразумевает право модели читать внешний источник.
    agentSearch: false,
    // Автомат выключен у нового правила: сначала посмотри, что вообще прилетает
    // в этот чат, и только потом отдавай его роботу.
    autoTask: { ...AUTO_TASK },
  });
}

// Правила и темы их чатов одним ходом: без справочника тем селект показывал бы
// пустой список там, где тема у правила уже выбрана.
async function loadRules(): Promise<void> {
  try {
    await readRulesSnapshot();
    await loadRuleTopics();
  } catch (e) {
    if (!telegramPluginDisabled(e)) {
      error.value = errorMessage(e, translate('core.coreNeUdalosZagruzitPravila'));
    }
  }
}

// Снимок политики на экран. Отпечаток проверен уже на границе сети, поэтому
// «состояние доступа известно» здесь означает ровно «ответ сервера прочитан».
function applyRulesSnapshot(res: TelegramRules): void {
  rules.value = res.rules;
  projects.value = res.projects ?? [];
  rulesPolicyFingerprint.value = res.policyFingerprint;
  agentSearchStateKnown.value = Boolean(rulesPolicyFingerprint.value);
  savedRules.value = JSON.stringify(payload());
}

// Перечитывание правил. `requireFingerprint` нужен разбору потерянного ответа:
// там без достоверного CAS показывать состояние доступа нельзя вовсе.
async function readRulesSnapshot({ requireFingerprint = false }: {
  requireFingerprint?: boolean;
} = {}): Promise<TelegramRules> {
  const res = await telegramApi.rules();

  applyRulesSnapshot(res);

  if (requireFingerprint && !agentSearchStateKnown.value) {
    throw new Error(translate('core.telegramServerNeVernulDostovernyy'));
  }

  return res;
}

// Сохранение allowlist целиком под своим CAS. Ответ сервера — уже нормализованные
// правила: берём их, а не свою копию, иначе на экране осталась бы форма до
// проверки, а на диске другая.
async function saveRules(): Promise<void> {
  if (busy.value || !providerWritable.value) {
    return;
  }
  if (!isTelegramPolicyFingerprint(rulesPolicyFingerprint.value)) {
    error.value = translate('core.coreNePoluchenOtpechatokPravil');

    return;
  }

  busy.value = 'rules';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.saveRules(
      payload(),
      bot.value?.botId,
      rulesPolicyFingerprint.value,
    );

    rules.value = res.rules;
    rulesPolicyFingerprint.value = res.policyFingerprint;
    agentSearchStateKnown.value = true;
    savedRules.value = JSON.stringify(payload());
    note.value = rules.value.length
      ? translate('core.coreSohranenoLengthLength2', {
    length: rules.value.length,
    length2: translate('core.telegramRuleWord', { count: rules.value.length }),
  })
      : translate('core.corePravilNeOstalosChaty');
  } catch (e) {
    // Текст валидатора уже человеческий и с номером правила — показываем как есть.
    error.value = errorMessage(e, translate('core.coreNeUdalosSohranitPravila'));
  } finally {
    busy.value = '';
  }
}

// Адрес правила в том виде, в каком его понимает отдельная ручка доступа агентов:
// четыре поля, по которым сервер находит ту же запись в своей политике.
function agentSearchRuleRef(r: RuleForm) {
  return {
    project: String(r.project || '').trim(),
    chatId: r.chatId === null || r.chatId === undefined ? null : Number(r.chatId),
    username: String(r.username ?? '').trim() || null,
    threadId: toId(r.threadId),
  };
}

/**
 * Разбор потерянного ответа на изменение доступа. Прежнее значение перестаёт быть
 * фактом: сервер мог commit-нуть решение и не донести ответ, поэтому состояние
 * перечитывается, а несовпадение с запрошенным называется человеку прямо.
 */
async function confirmAgentSearch(
  requestedRule: ReturnType<typeof agentSearchRuleRef>,
  enabled: boolean,
  mutationMessage: string,
): Promise<void> {
  await readRulesSnapshot({ requireFingerprint: true });

  const current = rules.value.find((candidate) => {
    const ref = agentSearchRuleRef(candidate);

    return ref.project === requestedRule.project
      && ref.chatId === requestedRule.chatId
      && ref.username === requestedRule.username
      && ref.threadId === requestedRule.threadId;
  });

  if (!current) {
    note.value = '';
    error.value =
             translate(
               'core.coreMutationmessagePovtornayaProverkaPodtverdila',
               { mutationMessage: mutationMessage },
             );

    return;
  }

  const actual = current.agentSearch === true;

  if (actual === enabled) {
    error.value = '';
    note.value = translate('core.corePovtornayaProverkaPodtverdilaAgentskiy', {
      actual: actual ? translate('core.coreRazreshen') : translate('core.routeZakryt'),
    });

    return;
  }

  note.value = '';
  error.value = translate('core.coreMutationmessagePovtornayaProverkaPodtverdila2', {
    mutationMessage: mutationMessage,
    actual: actual ? translate('core.coreRazreshen') : translate('core.routeZakryt'),
    enabled: enabled ? translate('core.coreVklyuchenie') : translate('core.coreVyklyuchenie'),
  });
}

/**
 * Доступ агентов к переписке — не обычная галочка: у неё CAS по отпечатку политики,
 * подтверждение человека на включение и свой разбор потерянного ответа. Пока сервер
 * не подтвердил решение, на экране остаётся прежнее известное состояние.
 */
async function setAgentSearch(r: RuleForm, event: Event): Promise<void> {
  const target = event.target instanceof HTMLInputElement ? event.target : null;
  const enabled = target?.checked === true;
  const requestedRule = agentSearchRuleRef(r);

  // DOM уже переставил checkbox, но policy ещё не commit-нута. Возвращаем
  // authoritative вид сразу и меняем его только ответом сервера.
  if (target) {
    target.checked = agentSearchStateKnown.value && r.agentSearch === true;
  }
  if (busy.value || !providerWritable.value) {
    return;
  }
  if (dirty.value) {
    error.value = translate('core.coreSnachalaSohraniteObychnyeIzmeneniya');

    return;
  }
  if (!agentSearchStateKnown.value || !isTelegramPolicyFingerprint(rulesPolicyFingerprint.value)) {
    error.value = translate('core.coreNePoluchenOtpechatokPravil2');

    return;
  }
  if (enabled) {
    const confirmed = await confirmDialog(
      messageRef('core.telegramRazreshitAgentamIskatSoobscheniya'),
      { okText: translate('core.allow') },
    );

    if (!confirmed) {
      return;
    }
  }

  busy.value = 'agent-search';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.setAgentSearch({
      botId: bot.value?.botId,
      rule: requestedRule,
      enabled,
      expectedPolicyFingerprint: rulesPolicyFingerprint.value,
    });

    rules.value = res.rules;
    rulesPolicyFingerprint.value = res.policyFingerprint;
    agentSearchStateKnown.value = true;
    savedRules.value = JSON.stringify(payload());
    note.value = enabled
      ? translate('core.coreAgentskiyPoiskRazreshenDlya')
      : translate('core.coreAgentskiyPoiskDlyaVybrannogo');
  } catch (e) {
    const mutationMessage = errorMessage(e, translate('core.coreOtvetIzmeneniyaDostupaNe'));

    try {
      await confirmAgentSearch(requestedRule, enabled, mutationMessage);
    } catch (refreshError) {
      rulesPolicyFingerprint.value = '';
      agentSearchStateKnown.value = false;
      note.value = '';
      error.value = translate('core.coreMutationmessageSostoyanieDostupaNe', {
        mutationMessage: mutationMessage,
        errorMessagerefreshError: errorMessage(refreshError, translate('core.corePravilaNeUdalosPerechitat')),
      });
    }
  } finally {
    busy.value = '';
  }
}

// Первая загрузка раздела. Справочники тянутся только у подключённого бота: без
// токена сервер о чатах ничего не знает, а пустые списки выглядели бы как ответ.
async function load(): Promise<void> {
  loading.value = true;

  try {
    const res = await telegramApi.status();

    bot.value = res.bot;
    poll.value = res.poll ?? null;
    pult.value = res.pult ?? null;
    providerConnection.value = res.connection
      ?? (res.bot.configured ? 'connected' : 'disconnected');
    providerReason.value = res.reason ?? '';
    error.value = '';

    if (bot.value.configured) {
      await loadChats();
      await loadRules();
      await loadUsers();
      await loadGroups();
    }
  } catch (e) {
    // Выключенный плагин — не ошибка: заглушку покажет pluginOff.
    if (!telegramPluginDisabled(e)) {
      error.value = errorMessage(e, translate('core.coreNeUdalosZagruzitRazdel'));
    }
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// Подключение бота: сервер сам проверяет токен через getMe и оставляет секрет у
// себя. Справочники тянутся тем же ходом — до подключения их просто не было.
async function connect(): Promise<void> {
  if (!token.value.trim() || busy.value || !canConnect.value) {
    return;
  }

  busy.value = 'connect';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.connect(token.value.trim());

    bot.value = res.bot;
    poll.value = res.poll ?? null;
    providerConnection.value = 'connected';
    providerReason.value = '';
    token.value = '';   // проверенный токен уже на сервере, в поле ему делать нечего
    note.value = translate('core.coreBotUsernamePodklyuchen', { username: bot.value.username ?? '' });
    await loadChats();
    // И правила тоже: до подключения карточки «Разрешённые чаты» не было, значит
    // не было и списка проектов — без этого селект проекта пустой до F5.
    await Promise.all([loadRules(), loadUsers(), loadGroups()]);
  } catch (e) {
    error.value = errorMessage(e, translate('core.coreNeUdalosPodklyuchitBota'));
  } finally {
    busy.value = '';
  }
}

// Перепроверка токена и режима приватности. Она же лечит опрос, не заведшийся
// при старте сервера: ответ getMe возвращает канал в рабочее состояние.
async function recheck(): Promise<void> {
  if (busy.value) {
    return;
  }

  busy.value = 'recheck';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.recheck();

    bot.value = res.bot;
    poll.value = res.poll ?? null;
    providerConnection.value = 'connected';
    providerReason.value = '';
    note.value = bot.value.canReadAllGroupMessages
      ? translate('core.coreProverenoBotChitaetPerepisku')
      : translate('core.coreProverenoRezhimPrivatnostiVse');
    await loadChats();
  } catch (e) {
    error.value = errorMessage(e, translate('core.coreNeUdalosPereproveritBota'));
  } finally {
    busy.value = '';
  }
}

// Отключение стирает токен на сервере и гасит приём. Спрашиваем: принятые
// обращения останутся, но вернуть бота без нового токена будет нечем.
async function disconnect(): Promise<void> {
  const ok = await confirmDialog(
    messageRef('core.telegramOtklyuchitBotaUsernameToken', { username: bot.value?.username || '' }),
    { danger: true, okText: translate('core.telegramOtklyuchit') },
  );

  if (!ok || busy.value) {
    return;
  }

  busy.value = 'disconnect';
  error.value = '';
  note.value = '';

  try {
    const res = await telegramApi.disconnect();

    bot.value = res.bot;
    poll.value = res.poll ?? null;
    providerConnection.value = 'disconnected';
    providerReason.value = '';
    chats.value = [];
    topicsByChat.value = {};
    topicLoading.value = {};
    topicErrors.value = {};
    // Настройка пульта живёт в namespace бота и переживёт возврат того же бота,
    // но без подключения показывать её нечем.
    pult.value = null;
    note.value = translate('core.coreBotOtklyuchenTokenStert');
  } catch (e) {
    error.value = errorMessage(e, translate('core.coreNeUdalosOtklyuchitBota'));
  } finally {
    busy.value = '';
  }
}
</script>

<style scoped>
.tg {
  --tg-soft: color-mix(in srgb, var(--accent) 9%, var(--surface));
  display: flex; flex-direction: column; gap: 16px;
}

.eyebrow, .section-kicker {
  color: var(--accent); font-size: 10.5px; font-weight: 720; letter-spacing: .09em;
  line-height: 1.25; text-transform: uppercase;
}
.ttl { margin: 5px 0 8px; font-size: clamp(21px, 2vw, 28px); line-height: 1.2; letter-spacing: -.025em; }
.lead { max-width: 76ch; margin: 0; font-size: 13.5px; line-height: 1.6; }

.setup-summary, .hero-loading {
  position: relative; z-index: 1; display: flex; flex-direction: column; gap: 5px;
  max-width: 260px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 11px;
  background: color-mix(in srgb, var(--ground) 58%, transparent); color: var(--ink-mid); font-size: 12.5px;
}
.setup-time { color: var(--good); font-size: 18px; font-weight: 680; }
.hero-loading { flex-direction: row; align-items: center; }

.feedback { padding: 11px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.err { color: var(--bad); font-size: 13px; margin: 0; }
.ok { color: var(--good); font-size: 13px; margin: 0; }

/* Маршрут настройки — не вкладки: каждый пункт ведёт к своему блоку и показывает,
   какой обязательный шаг ещё не завершён. */
.setup-path {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px;
  padding: 1px; border: 1px solid var(--line); border-radius: 13px; background: var(--line); overflow: hidden;
}
.path-step {
  min-width: 0; min-height: 66px; display: flex; align-items: center; gap: 11px; padding: 11px 15px;
  background: var(--surface); transition: background .14s;
}
.path-step:hover { background: var(--surface-2); }
.path-mark {
  width: 28px; height: 28px; flex: none; display: grid; place-items: center;
  border: 1px solid var(--line-2); border-radius: 50%; color: var(--ink-mid); font-size: 12px; font-weight: 720;
}
.path-step.done .path-mark { border-color: color-mix(in srgb, var(--good) 60%, var(--line)); color: var(--good); }
.path-step.done .path-mark::after { content: '✓'; }
.path-step.done .path-mark { font-size: 0; }
.path-step.done .path-mark::after { font-size: 13px; }
.path-step.attention .path-mark { border-color: var(--warn); color: var(--warn); }
.path-copy { min-width: 0; display: flex; flex-direction: column; }
.path-copy b { font-size: 12.5px; }
.path-copy small { overflow: hidden; color: var(--ink-mid); font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }

.tg-grid {
  display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(320px, .75fr);
  align-items: start; gap: 16px;
}
/* Правая колонка — независимая стопка, а не общие грид-ряды с левой: высокая
   карточка правил иначе раздувает ряд, и карточка ниже (пульт) уезжает под её
   конец, оставляя дыру. Aside занимает обе строки и пакует детей флексом. */
.side-stack {
  min-width: 0; display: flex; flex-direction: column; gap: 16px;
  grid-column: 2; grid-row: 1 / span 2;
}
.bot-card { grid-column: 1; grid-row: 1; }
.rules-card { grid-column: 1; grid-row: 2; }
.pult-code { margin-top: 8px; }
.code-input {
  flex: 1; min-width: 0; font-variant-numeric: tabular-nums;
}
[id^='tg-'] { scroll-margin-top: 16px; }

.card {
  min-width: 0; padding: 18px; display: flex; flex-direction: column; gap: 13px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow);
}
.native-editor { min-width: 0; margin: 0; padding: 0; border: 0; }
.rules-editor { display: flex; flex-direction: column; gap: 13px; }
.h { font-size: 15px; font-weight: 680; letter-spacing: -.01em; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.compact-head { align-items: center; }
.section-title { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
.name { font-size: 16px; font-weight: 680; }
.sub { font-size: 12.5px; margin: 0; line-height: 1.5; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.count {
  min-width: 22px; height: 22px; padding: 0 7px; display: inline-grid; place-items: center;
  border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 720;
  font-variant-numeric: tabular-nums;
}
.count.subtle { border: 1px solid var(--line); background: var(--surface-2); color: var(--ink-mid); }

summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.field-label { color: var(--ink-mid); font-size: 11.5px; font-weight: 590; }
.field-label em { margin-left: 3px; color: var(--ink-mid); font-size: 10px; font-style: normal; font-weight: 440; }
.control { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.steps code, .sub code, .security-note code, .info-note code, .technical code {
  padding: 1px 5px; border-radius: 5px; background: var(--surface-2); font-family: var(--mono); font-size: 12px;
}

.state {
  padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--surface-2); color: var(--ink-mid); font-size: 12.5px; line-height: 1.5;
}
.state.good { border-color: color-mix(in srgb, var(--good) 28%, var(--line)); color: var(--good); background: color-mix(in srgb, var(--good) 7%, var(--surface-2)); }
.state.warn { border-color: color-mix(in srgb, var(--warn) 32%, var(--line)); color: var(--warn); background: color-mix(in srgb, var(--warn) 7%, var(--surface-2)); }
.state a { text-decoration: underline; text-underline-offset: 2px; }

.explain, .technical { border-top: 1px solid var(--line); padding-top: 10px; }
.explain summary, .technical summary {
  width: fit-content; color: var(--ink-mid); font-size: 12px; cursor: pointer; user-select: none;
}
.explain[open] summary, .technical[open] summary { color: var(--ink); }
.explain p { margin: 8px 0 0; }
.technical-data { margin-top: 8px; overflow-wrap: anywhere; }

/* --- Provider и native stores --- */
.bot-name { min-width: 0; display: flex; align-items: center; gap: 10px; }
.status-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 10%, transparent); }
.status-dot.on { background: var(--good); box-shadow: 0 0 0 4px color-mix(in srgb, var(--good) 10%, transparent); }
.bot-actions { display: flex; gap: 8px; }
.bot-actions .btn:first-child { flex: 1; }
.bot-actions .disconnect { display: inline-flex; }
.chats { max-height: 310px; overflow: auto; list-style: none; margin: 0; padding: 0 3px 0 0; display: flex; flex-direction: column; gap: 7px; }
.chat { padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); }
.cname { font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
.chat-meta { margin-top: 2px; font-size: 10.5px; overflow-wrap: anywhere; }
.card-foot { padding-top: 10px; border-top: 1px solid var(--line); }
.mini-empty { padding: 12px; border: 1px dashed var(--line-2); border-radius: 9px; background: color-mix(in srgb, var(--ground) 28%, transparent); }
.mini-empty b { font-size: 12.5px; }
.mini-empty p { margin-top: 3px; }
.optional-chip { padding: 3px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-mid); font-size: 10.5px; }
.service-control { display: flex; align-items: stretch; gap: 8px; }
.service-control > .ui-select-wrap { flex: 1; }
.compact-explain { padding-top: 8px; }

/* --- Правила --- */
.rules-head { align-items: center; }
.rules-callout {
  display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--line)); border-radius: 9px; background: var(--tg-soft);
}
.callout-mark {
  width: 22px; height: 22px; flex: none; display: grid; place-items: center;
  border-radius: 50%; background: color-mix(in srgb, var(--accent) 16%, var(--surface-2)); color: var(--accent); font-weight: 760;
}
.rules-callout b { font-size: 12.5px; }
.rules-callout p { margin-top: 2px; }
.empty-rules {
  display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px;
  border: 1px dashed var(--line-2); border-radius: 10px; background: color-mix(in srgb, var(--ground) 28%, transparent);
}
.empty-rules p { margin-top: 3px; }
.rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; counter-reset: none; }
.rule { overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: color-mix(in srgb, var(--ground) 24%, var(--surface)); }
.rule-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.rule-head > div { min-width: 0; display: flex; align-items: baseline; gap: 9px; }
.rule-head b { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.rule-number { flex: none; color: var(--ink-mid); font-size: 11px; }
.rule-builder { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.rule-part { min-width: 0; padding: 14px; }
.rule-part + .rule-part { border-left: 1px solid var(--line); }
.part-head { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
.part-number {
  width: 24px; height: 24px; flex: none; display: grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 7px; color: var(--accent); font-size: 11px; font-weight: 720;
}
.part-head > div { display: flex; flex-direction: column; line-height: 1.3; }
.part-head b { font-size: 13px; }
.part-head small { color: var(--ink-mid); font-size: 10.5px; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.field-grid .full { grid-column: 1 / -1; }
.topic-control { grid-column: 1 / -1; }
.topic-status {
  min-height: 17px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 10.5px; line-height: 1.4;
}
.manual-topic { margin-top: 2px; }
.manual-topic summary {
  width: fit-content; color: var(--ink-mid); font-size: 10.5px; cursor: pointer; user-select: none;
}
.manual-topic[open] summary { color: var(--ink); }
.manual-topic-field { display: flex; flex-direction: column; gap: 5px; margin-top: 8px; }
.part-hint { margin-top: 10px; }
.task-reply-option, .agent-search-option {
  display: flex; align-items: flex-start; gap: 8px; margin-top: 11px; padding: 10px 11px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); cursor: pointer;
}
.task-option-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.task-reply-option b, .agent-search-option b { font-size: 12px; }
.task-reply-option small, .agent-search-option small { color: var(--ink-mid); font-size: 10.5px; line-height: 1.4; }
.rrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.auto-panel { padding: 12px 14px; border-top: 1px solid var(--line); background: var(--surface-2); }
.auto-panel.enabled { background: color-mix(in srgb, var(--accent) 7%, var(--surface-2)); }
.lbl { padding: 2px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink-mid); font-size: 9.5px; text-transform: uppercase; }
.auto-copy { min-width: 150px; display: flex; flex: 1; flex-direction: column; }
.auto-copy b { font-size: 12.5px; }
.chk, .num { display: flex; align-items: center; gap: 6px; color: var(--ink-mid); font-size: 12px; }
.num-f { width: 56px; min-width: 0; text-align: center; }
.rules-explain { margin-top: -2px; }
.savebar {
  position: sticky; bottom: -1px; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 14px;
  margin: 1px -6px -6px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warn) 28%, var(--line));
  border-radius: 10px; background: color-mix(in srgb, var(--surface) 92%, var(--warn)); box-shadow: 0 -6px 22px #0005;
  color: var(--warn); font-size: 12px;
}

/* --- Первое подключение --- */
.setup-grid { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(330px, .88fr); align-items: stretch; gap: 16px; }
.setup-card { padding: 21px; }
.setup-card-head { display: flex; align-items: center; gap: 11px; }
.setup-number {
  width: 34px; height: 34px; flex: none; display: grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 10px; color: var(--accent); font-size: 14px; font-weight: 760;
}
.steps { list-style: none; margin: 3px 0 0; padding: 0; display: flex; flex-direction: column; gap: 9px; font-size: 13px; }
.steps li { display: grid; grid-template-columns: 23px minmax(0, 1fr); align-items: start; gap: 9px; }
.step-mark {
  width: 21px; height: 21px; display: grid; place-items: center; margin-top: 1px;
  border-radius: 50%; background: var(--surface-2); color: var(--ink-mid); font-size: 10px; font-weight: 700;
}
.info-note, .security-note {
  padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px;
  background: var(--surface-2); color: var(--ink-mid); font-size: 12px; line-height: 1.55;
}
.token-card { background: linear-gradient(145deg, color-mix(in srgb, var(--surface) 95%, var(--accent)), var(--surface)); }
.token-card > .muted { margin: 3px 0 6px; font-size: 13px; }
.token-control { margin-top: auto; }
.connect-btn { width: 100%; }
.security-note { display: flex; flex-direction: column; gap: 3px; }
.security-note b { color: var(--ink); }
.after-connect { padding: 2px 4px; }
.after-title { margin-bottom: 9px; color: var(--ink-mid); font-size: 11px; font-weight: 670; letter-spacing: .06em; text-transform: uppercase; }
.after-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.after-step { display: flex; align-items: center; gap: 10px; padding: 12px 13px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--surface) 75%, transparent); }
.after-step > span { color: var(--accent); font-size: 11px; font-weight: 760; }
.after-step > div { min-width: 0; display: flex; flex-direction: column; }
.after-step b { font-size: 12px; }
.after-step small { color: var(--ink-mid); font-size: 10.5px; }

.disabled-card { min-height: 150px; flex-direction: row; align-items: center; gap: 16px; }
.disabled-mark {
  width: 48px; height: 48px; flex: none; display: grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius: 14px;
  background: var(--tg-soft); color: var(--accent); font-weight: 760;
}
.disabled-card .ttl { margin-top: 0; }

/* Средние экраны: native-карточки становятся одной колонкой. */
@media (max-width: 1100px) {

  .setup-summary { max-width: none; flex-direction: row; align-items: baseline; }
  .setup-grid { grid-template-columns: minmax(0, 1fr) minmax(310px, .82fr); }
}

@media (max-width: 860px) {
  .tg-grid { grid-template-columns: minmax(0, 1fr); }
  .bot-card, .side-stack, .rules-card { grid-column: 1; grid-row: auto; }
  .side-stack { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 16px; }
  .setup-grid { grid-template-columns: minmax(0, 1fr); }
  .rule-builder { grid-template-columns: minmax(0, 1fr); }
  .rule-part + .rule-part { border-left: 0; border-top: 1px solid var(--line); }
}

@media (max-width: 640px) {
  .tg { gap: 12px; }

  .ttl { font-size: 21px; }

  .setup-summary { flex-direction: column; }
  .setup-path { grid-template-columns: minmax(0, 1fr); }
  .path-step { min-height: 58px; }
  .side-stack { grid-template-columns: minmax(0, 1fr); }
  .bot-card { grid-column: 1; }
  .card { padding: 14px; }
  .head { flex-wrap: wrap; }
  .bot-card .head { flex-wrap: nowrap; }
  .field-grid { grid-template-columns: minmax(0, 1fr); }
  .field-grid .full { grid-column: 1; }
  .auto-panel { align-items: flex-start; }
  .auto-copy { flex-basis: calc(100% - 70px); }
  .chk { flex-basis: 100%; }
  .service-control { flex-direction: column; }
  .savebar { position: static; align-items: flex-start; flex-direction: column; }
  .savebar .row, .savebar .btn { width: 100%; }
  .empty-rules { align-items: stretch; flex-direction: column; }
  .after-grid { grid-template-columns: minmax(0, 1fr); }
}

.setup-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
.setup-card { padding: 16px; }
.token-control { margin-top: 0; }
.setup-guide > summary { cursor: pointer; }
@media (max-width: 900px) {
  .setup-grid { grid-template-columns: minmax(0, 1fr); }
  .setup-path { display: none; }
}
</style>
