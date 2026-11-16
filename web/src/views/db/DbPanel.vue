<template>
  <section
    class="db-panel ui-workspace"
    data-ui-workspace
    :class="{
      'is-active': props.active,
      'is-compact': props.compact,
      'is-dock': props.presentation === 'dock',
    }"
    :data-pane="showCreate ? 'create' : activeSession || mobilePane === 'activity' ? mobilePane : 'profiles'"
    aria-labelledby="db-panel-title"
    :aria-busy="refreshLoading || undefined"
  >
    <div class="db-panel__surface">
      <div class="db-panel__heading">
        <UiPaneHeader class="db-panel__header">
          <template #title>
            <div class="db-panel__title">
              <h2 id="db-panel-title">{{ t('core.databases') }}</h2>
              <span class="ui-maturity-chip" data-product-maturity="beta" :aria-label="t('core.dbBetaVersiya')"> {{ t('core.dbBeta') }} </span>
            </div>
          </template>
          <template #meta>
            <span class="db-panel__summary" :aria-label="t('core.dbSvodkaPoBazam')">
              {{ t('core.dbDesignSummary', {
                profiles: store.profiles?.length || 0,
                sessions: store.sessions?.length || 0,
              }) }}
            </span>
            <span v-if="activeQueryCount" class="db-running-label">
              {{ t('core.dbDesignRunning', { count: activeQueryCount }) }}
            </span>
          </template>
          <template #actions>
            <UiIconButton class="db-refresh" role="embedded" data-context="workspace-toolbar"
                          :label="t('core.dbObnovitBazy')" v-tooltip="t('core.trackerUpdate')" :loading="refreshLoading"
                          :loading-label="t('core.updating')" @click="refresh">
              <UiRefreshIcon />
            </UiIconButton>
            <UiButton data-context="workspace-toolbar" :aria-label="t('core.dbInstallDriver')"
                      v-tooltip="t('core.dbInstallDriver')" @click="openDriverInstall('install', false)">
              {{ t('core.dbDriverAction') }}
            </UiButton>
            <UiCreateButton :label="showCreate ? t('core.dbDesignHideForm') : t('core.dbDesignAddProfile')"
                            :expanded="showCreate" aria-controls="db-create" @click="toggleCreate" />
          </template>
        </UiPaneHeader>
      </div>

      <div class="db-panel__body">
        <div v-show="!showCreate" class="db-panel__navigation">
          <UiTabs v-model="mobileWorkspace" data-ui-workspace-tabs size="compact" :label="t('core.dbRabochayaOblastBazy')">
            <UiTab value="profiles" controls="db-profiles-pane"> {{ t('core.dbProfili') }} {{ store.profiles?.length || 0 }}
            </UiTab>
            <UiTab value="console" controls="db-session-panel" :disabled="!activeSession">{{ t('core.dbKonsol') }}</UiTab>
            <UiTab value="activity" controls="db-queries-pane">{{ t('core.dbZaprosy') }} {{ store.queries?.length || 0 }}</UiTab>
          </UiTabs>
        </div>
        <UiInlineMessage v-if="visibleError" tone="danger">
          {{ visibleError }}
        </UiInlineMessage>

        <UiInlineMessage v-for="error in store.engineErrors" :key="error.id" tone="warning">
          {{ error.id }}: {{ error.message }}
        </UiInlineMessage>
        <UiInlineMessage v-if="store.installHealth" tone="warning">
          {{ store.installHealth.message }}
        </UiInlineMessage>
        <PluginSourcePanel v-if="selectedDriver" :plugin="selectedDriver" package-kind="db-engine"
                           @update="openDriverInstall('update')" @bind="openDriverInstall('install')" />
        <PluginInstallDialog v-if="driverDialogOpen" v-model:open="driverDialogOpen"
                             :mode="driverDialogMode" :plugin="driverDialogSubject" package-kind="db-engine" />

        <div class="db-layout">
          <div id="db-workspace-pane" class="db-workspace">
            <section v-show="showCreate" id="db-create" class="db-create ui-workspace-section"
                     aria-labelledby="db-create-title">
              <UiPaneHeader>
                <template #title><h3 id="db-create-title">{{ t('core.dbDesignNewProfile') }}</h3></template>
                <template #actions>
                  <UiButton data-context="workspace-toolbar" @click="toggleCreate">
                    {{ t('core.dbDesignCancel') }}
                  </UiButton>
                </template>
              </UiPaneHeader>
              <form class="db-profile-form" @submit.prevent="saveProfile">
                <UiField :label="t('core.taskEditProject')" required>
                  <UiSelect
                    v-model="draft.projectId"
                    required
                    :disabled="!projectOptions.length"
                    :aria-label="t('core.taskEditProject')"
                    data-db-project-select
                  >
                    <option value="" disabled>{{ projectPlaceholder }}</option>
                    <option v-for="project in projectOptions" :key="project.id" :value="project.id">
                      {{ project.id }}
                    </option>
                  </UiSelect>
                </UiField>

                <UiField :label="t('core.dbMetka')" required>
                  <UiInput
                    v-model.trim="draft.label"
                    required
                    :placeholder="t('core.dbNaprimerAnalitika')"
                    :aria-label="t('core.dbMetkaProfilya')"
                  />
                </UiField>

                <UiField :label="t('core.dbDvizhok')" required>
                  <UiSelect v-model="draft.engine" required :aria-label="t('core.dbDvizhokBazy')">
                    <option value="" disabled>{{ t('core.dbVyberiteDvizhok') }}</option>
                    <option v-for="engine in store.engines" :key="engine.id" :value="engine.id">
                      {{ engine.label }}
                    </option>
                  </UiSelect>
                </UiField>

                <UiField :label="t('core.dbRol')">
                  <UiSelect v-model="draft.role" :aria-label="t('core.dbRolProfilya')">
                    <option value="read">{{ t('core.agentModeReadOnly') }}</option>
                    <option value="write">{{ t('core.dbChtenieIZapis') }}</option>
                  </UiSelect>
                </UiField>

                <UiField :label="t('core.browserAddress')" required>
                  <UiInput
                    v-model.trim="draft.host"
                    required
                    :placeholder="'db.internal'"
                    :aria-label="t('core.dbAdresBazy')"
                  />
                </UiField>

                <UiField :label="t('settings.port')" required>
                  <UiNumberInput
                    v-model="draft.port"
                    :min="1"
                    :max="65535"
                    required
                    placeholder="3306"
                    :aria-label="t('core.dbPortBazy')"
                  />
                </UiField>

                <UiField :label="t('settings.user')" required>
                  <UiInput
                    v-model.trim="draft.user"
                    required
                    autocomplete="username"
                    :placeholder="'reader'"
                    :aria-label="t('core.dbPolzovatelBazy')"
                  />
                </UiField>

                <UiField :label="t('core.dbBazaNomer')">
                  <UiInput
                    v-model.trim="draft.database"
                    :placeholder="t('settings.optional')"
                    :aria-label="t('core.dbImyaIliNomerBazy')"
                  />
                </UiField>

                <UiField :label="t('core.dbMarshrut')">
                  <UiSelect v-model="draft.via" :aria-label="t('core.dbMarshrutPodklyucheniya')">
                    <option value="direct">{{ t('core.dbNapryamuyu') }}</option>
                    <option value="ssh">{{ t('core.dbCherezOtkrytuyuSshSessiyu') }}</option>
                  </UiSelect>
                </UiField>

                <div class="db-profile-form__environment">
                  <UiSwitch v-model="draft.prod">{{ t('core.dbProdSreda') }}</UiSwitch>
                </div>

                <UiInlineMessage v-if="store.projectsError" tone="danger">
                  {{ store.projectsError }}
                </UiInlineMessage>

                <UiFormActions class="db-profile-form__actions">
                  <UiButton
                    type="submit"
                    variant="solid"
                    tone="accent"
                    :loading="savingProfile"
                    :loading-label="t('core.dbSohranyayuProfil')"
                    :disabled="!profileDraftValid"
                  > {{ t('core.dbSohranitProfil') }} </UiButton>
                </UiFormActions>
              </form>
            </section>

            <details
              v-show="!showCreate"
              class="db-live-queries ui-workspace-disclosure"
              data-context="workspace-inline"
              :open="activeQueryCount > 0 || mobilePane === 'activity'"
              :class="{ 'has-active': activeQueryCount }"
              id="db-queries-pane"
              data-db-queries
              :aria-label="t('core.dbZhivayaLentaZaprosov')"
            >
              <summary>
                <span>{{ t('core.dbZhivayaLentaZaprosov') }}</span>
                <span class="db-live-queries__status">
                  <span class="db-activity-label">
                    {{ activeQueryCount
                      ? t('core.dbDesignRunning', { count: activeQueryCount })
                      : t('core.dbDesignNoActiveQueries') }}
                  </span>
                  <span class="db-count" :class="{ 'is-running': activeQueryCount }">
                    {{ store.queries?.length || 0 }}
                  </span>
                </span>
              </summary>

              <div v-if="store.queries?.length" class="db-query-list">
                <article
                  v-for="item in visibleQueries"
                  :key="item.id"
                  class="db-query-row"
                  :class="queryTone(item.state)"
                >
                  <div class="db-query-row__main">
                    <div class="db-query-row__meta">
                      <span>{{ queryActorLabel(item.actor) }} · {{ queryStateLabel(item.state) }}</span>
                      <time v-if="item.startedAt">{{ formatDate(item.startedAt) }}</time>
                    </div>
                    <code>{{ item.text }}</code>
                  </div>
                  <div class="db-query-row__actions">
                    <UiButton
                      v-if="item.result"
                      variant="text"
                      :disabled="!querySessionOpen(item)"
                      v-tooltip="querySessionOpen(item)
                        ? t('core.dbPokazatRezultatVEgo')
                        : t('core.dbSessiyaEtogoZaprosaUzhe')"
                      @click="inspectQuery(item)"
                    >
                      {{ querySessionOpen(item) ? t('core.stageResult') : t('core.dbSessiyaZakryta') }}
                    </UiButton>
                    <UiButton
                      v-show="item.state === 'running'"
                      data-db-cancel
                      tone="danger"
                      :disabled="!item.id || item.state !== 'running'"
                      @click="cancelQuery(item.id)"
                    > {{ t('core.dbPrervat') }} </UiButton>
                  </div>
                </article>
              </div>

              <div v-else class="db-query-list__empty" data-db-cancel> {{ t('core.dbNovyeZaprosyPoyavyatsyaZdes') }} </div>

            </details>

            <UiInlineMessage v-if="!showCreate && store.cancelNotice" tone="warning" data-db-cancel-notice>
              {{ store.cancelNotice }}
            </UiInlineMessage>

            <section
              v-show="!showCreate"
              id="db-session-panel"
              class="db-console"
              :class="{ 'has-session': activeSession }"
              data-db-sessions
              :aria-label="t('core.dbRabochayaSessiyaBazyDannyh')"
            >
              <header class="db-console__header">
                <div v-if="store.sessions?.length" class="db-session-switcher">
                  <span class="db-session-switcher__label">{{ t('core.dbSessii') }}</span>
                  <UiTabs v-model="selectedSessionId" class="db-tabs" :label="t('core.dbSessiiBazDannyh')">
                    <UiTab
                      v-for="session in store.sessions"
                      :id="sessionTabId(session.id)"
                      :key="session.id"
                      class="db-tab"
                      :value="session.id"
                      :aria-label="sessionTabTitle(session)"
                      controls="db-workbench"
                      v-tooltip="sessionTabTitle(session)"
                    >
                      <span class="db-tab__content" aria-hidden="true">
                        <span class="db-tab__dot"></span>
                        <span class="db-tab__copy">
                          <strong>{{ session.label }}</strong>
                          <small>{{ session.projectId }} · {{ engineLabel(session.engine) }}</small>
                        </span>
                      </span>
                    </UiTab>
                  </UiTabs>
                </div>

                <UiIconButton
                  v-if="activeSession"
                  class="db-session-close"
                  role="embedded"
                  tone="danger"
                  :label="t('core.dbZakrytAktivnuyuSessiyuLabel', { label: activeSession.label })"
                  v-tooltip="t('core.dbZakrytLabel', { label: activeSession.label })"
                  :loading="closingSessionId === activeSession.id"
                  :loading-label="t('core.dbZakryvayuSessiyu')"
                  @click="closeActiveSession"
                >
                  ×
                </UiIconButton>

                <div v-else class="db-console__title">
                  <span aria-hidden="true">{{ t('core.dbSql') }}</span> {{ t('core.dbKonsol') }} </div>

                <div v-if="activeSession" class="db-console__context">
                  <span class="db-role-badge">{{ roleLabel(activeSession.role) }}</span>
                  <span v-if="activeSession.prod" class="db-prod-badge">{{ t('core.dbProd') }}</span>
                  <span class="db-live-label">
                    <i aria-hidden="true"></i> {{ t('core.machineConnected') }} </span>
                </div>
              </header>

              <div v-if="activeSession" class="db-console__navigation">
                <UiTabs v-model="mobilePane" data-ui-workspace-tabs size="compact" :label="t('core.dbRabochayaOblastBazy')">
                  <UiTab value="query" controls="db-workbench">{{ t('core.dbZapros') }}</UiTab>
                  <UiTab value="result" controls="db-workbench">{{ t('core.stageResult') }}</UiTab>
                  <UiTab value="schema" controls="db-workbench">{{ t('core.dbShema') }}</UiTab>
                </UiTabs>
              </div>

              <div
                id="db-workbench"
                class="db-workbench"
                :class="{ 'is-empty': !activeSession }"
                role="tabpanel"
                :aria-labelledby="activeSession ? sessionTabId(activeSession.id) : undefined"
              >
                <aside class="db-schema" data-db-schema :aria-label="t('core.dbShemaBazyDannyh')">
                  <header class="db-subsection-heading">
                    <div>
                      <h3>{{ t('core.dbShema') }}</h3>
                      <small v-if="activeSession">{{ activeSession.label }}</small>
                    </div>
                    <UiIconButton
                      role="embedded"
                      :label="t('core.dbObnovitShemu')"
                      v-tooltip="t('core.dbObnovitShemu')"
                      :loading="schemaLoadingIds.has(selectedSessionId)"
                      :disabled="!selectedSessionId"
                      @click="loadSchema"
                    >
                      <UiRefreshIcon />
                    </UiIconButton>
                  </header>

                  <UiLoadingState v-if="schemaLoadingIds.has(selectedSessionId) && !schemaLoaded"
                    variant="document" >
                    <UiSkeletonLayout layout="list" :header="false" />
                  </UiLoadingState>
                  <ul v-else-if="schemaItems.length" class="db-schema__list">
                    <li v-for="(item, index) in schemaItems" :key="`${item}-${index}`">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M4 6h16 M4 12h16 M4 18h16 M9 3v18" />
                      </svg>
                      <span>{{ item }}</span>
                    </li>
                  </ul>

                  <pre v-else-if="schemaLoaded" class="db-schema__raw">{{ formattedSchema }}</pre>

                  <div v-else class="db-schema__empty">
                    <span aria-hidden="true">⌘</span>
                    <strong>{{ activeSession ? t('core.dbShemaEscheNeZagruzhena') : t('core.dbNetSessii') }}</strong>
                    <small v-if="activeSession">{{ t('core.dbNazhmiteKnopkuObnovleniya') }}</small>
                    <small v-else>{{ t('core.dbOtkroyteProfilBazy') }}</small>
                  </div>
                </aside>

                <section class="db-query-console" data-db-console>
                  <div class="db-query-editor">
                    <header>
                      <div>
                        <h3>{{ t('core.dbKonsolCheloveka') }}</h3>
                        <small>
                          {{ activeSession
                            ? t('core.dbEngineRole', { engine: engineLabel(activeSession.engine), role: roleLabel(activeSession.role) })
                            : t('core.dbSnachalaOtkroyteSessiyu') }}
                        </small>
                      </div>
                      <span class="db-query-shortcut">{{ t('core.dbCtrl') }}</span>
                    </header>

                    <UiField :label="t('core.dbZapros')">
                      <UiTextarea
                        v-model="query"
                        data-role="db-query"
                        rows="7"
                        spellcheck="false"
                        :placeholder="'SELECT …'"
                        :disabled="!activeSession"
                        @keydown.ctrl.enter.prevent="runQuery"
                        @keydown.meta.enter.prevent="runQuery"
                      />
                    </UiField>

                    <div class="db-query-editor__actions">
                      <small>{{ t('core.dbRezultatSchitaetsyaNedoverennymiDannymi') }}</small>
                      <UiButton
                        class="db-run-button"
                        variant="solid"
                        tone="accent"
                        :loading="submittingQuery"
                        :loading-label="t('core.dbZapuskayuZapros')"
                        :disabled="!selectedSessionId || !query.trim()"
                        @click="runQuery"
                      >
                        <template #leading>
                          <svg
                            viewBox="0 0 24 24"
                            width="14"
                            height="14"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path d="m8 5 11 7-11 7z" />
                          </svg>
                        </template> {{ t('core.dbVypolnit') }} </UiButton>
                    </div>
                  </div>

                  <div class="db-result-stage" aria-live="polite">
                    <header class="db-result-stage__header">
                      <div>
                        <h3>{{ t('core.stageResult') }}</h3>
                        <span v-if="limitedResult" class="db-untrusted-badge"> {{ t('core.dbNedoverennyeDannye') }} </span>
                      </div>
                      <span v-if="limitedResult" class="db-result-count"> {{ t('core.dbPokazano') }} {{ limitedResult.shownRows }} {{ t('settings.from') }} {{ limitedResult.totalRows ?? '?' }}
                      </span>
                    </header>

                    <div v-if="queryInFlight" class="db-result-state is-running">
                      <span class="db-result-state__pulse" aria-hidden="true"></span>
                      <strong>{{ queryStateLabel(activeResultQuery?.state || '') }}</strong>
                      <small>{{ t('core.dbLentaObnovitsyaPosleOtveta') }}</small>
                    </div>

                    <UiInlineMessage v-else-if="failedResult" tone="danger" data-db-query-error>
                      <strong>{{ failedResult.message || t('core.dbQueryFailed') }}</strong>
                      <br />
                      <small>{{ failedResult.error }}</small>
                    </UiInlineMessage>

                    <div
                      v-else-if="displayedResult && resultRows.length"
                      class="db-result-table-wrap"
                    >
                      <table class="db-result-table">
                        <thead>
                          <tr>
                            <th v-for="column in resultColumns" :key="column">
                              {{ column }}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="(row, rowIndex) in resultRows" :key="rowIndex">
                            <td v-for="column in resultColumns" :key="column">
                              {{ resultCell(row, column) }}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    <pre v-else-if="displayedResult" class="db-result__raw">{{ formattedResult }}</pre>

                    <div v-else class="db-result-state">
                      <span class="db-result-state__icon" aria-hidden="true">{ }</span>
                      <strong>{{ t('core.dbRezultatovPokaNet') }}</strong>
                      <small v-if="activeSession">{{ t('core.dbVvediteZaprosIZapustite') }}</small>
                      <small v-else>{{ t('core.dbOtkroyteSessiyuIzProfilya') }}</small>
                    </div>
                  </div>
                </section>
              </div>

              <footer v-if="activeSession" class="db-session-tools">
                <div class="db-session-endpoint">
                  <span class="db-database-icon is-small" aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <ellipse cx="12" cy="5" rx="8" ry="3" />
                      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
                      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
                    </svg>
                  </span>
                  <span>
                    <strong>{{ activeSession.label }}</strong>
                    <small>{{ activeSession.projectId }} {{ t('core.dbSessiyaHranitsyaVGrigdesk') }}</small>
                  </span>
                </div>

                <div class="db-agent-access">
                  <span>
                    <strong>{{ t('core.dbZaprosyAgenta') }}</strong>
                    <small>{{ t('core.dbIzmeneniyaVsegdaTrebuyutPodtverzhdeniya') }}</small>
                  </span>
                  <UiSwitch
                    :model-value="activeSession.agentAllowed === true"
                    :aria-label="t('core.dbDostupAgentaKLabel', { label: activeSession.label })"
                    @update:model-value="setAgentAccess(activeSession.id, $event)"
                  />
                </div>
              </footer>
            </section>

            <details v-show="!showCreate" class="db-audit ui-workspace-disclosure"
                     data-context="workspace-inline" data-db-audit>
              <summary>
                <span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5" />
                  </svg> {{ t('core.dbZhurnalZaprosov') }} </span>
                <span class="db-count">{{ store.audit?.length || 0 }}</span>
              </summary>

              <UiInlineMessage v-if="store.auditError" tone="warning" data-db-audit-error>
                {{ store.auditError }}
              </UiInlineMessage>
              <UiInlineMessage v-if="store.auditSkippedRecords" tone="warning" data-db-audit-warning>
                {{ t('core.dbAuditSkipped', { count: store.auditSkippedRecords }) }}
              </UiInlineMessage>

              <div v-if="store.audit?.length" class="db-audit__list">
                <article v-for="item in store.audit" :key="item.at">
                  <header>
                    <span>{{ queryActorLabel(item.actor) }}</span>
                    <strong :class="outcomeTone(item.outcome)">
                      {{ outcomeLabel(item.outcome) }}
                    </strong>
                    <time>{{ formatDate(item.at) }}</time>
                  </header>
                  <code>{{ item.query }}</code>
                  <small v-if="item.rows != null">
                    {{ item.rows }} {{ t('core.dbStrok') }} {{ formatBytes(item.bytes) }}
                  </small>
                </article>
              </div>
              <p v-else-if="!store.auditError && !store.auditSkippedRecords" class="db-audit__empty"> {{ t('core.dbZaprosovVZhurnaleEsche') }} </p>
            </details>
          </div>

          <aside id="db-profiles-pane" class="db-profiles" data-db-profiles :aria-label="t('core.dbProfiliBazDannyh')">
            <UiPaneHeader class="db-catalog-heading">
              <template #title><h3>{{ t('core.dbProfili2') }}</h3></template>
              <template #meta>{{ store.profiles?.length || 0 }}</template>
            </UiPaneHeader>
            <div class="db-catalog-search">
              <UiSearchInput v-model="search" size="compact" :placeholder="t('core.dbDesignSearchPlaceholder')"
                             :aria-label="t('core.dbDesignSearchLabel')" />
            </div>
            <div class="db-profiles__body">
              <UiLoadingState v-if="refreshLoading && !store.profiles?.length && !store.error">
                <UiSkeletonLayout layout="list" :header="false" />
              </UiLoadingState>
              <div v-else-if="store.profiles?.length" class="db-profile-list">
                <section v-for="group in profileGroups" :key="group.projectId" class="db-profile-group">
                  <h4 class="db-profile-group__heading">
                    <span>{{ group.projectId }}</span>
                    <span>{{ group.profiles.length }}</span>
                  </h4>
                  <UiButton v-for="profile in group.profiles" :key="profile.id"
                            class="db-profile" variant="ghost" data-context="workspace-catalog-row"
                            data-db-profile-card :data-profile-id="profile.id"
                            :pressed="selectedProfileId === profile.id"
                            :disabled="Boolean(openingProfileId)" @click="selectProfile(profile.id)">
                    <span class="db-profile__heading">
                      <strong>{{ profile.label }}</strong>
                      <span v-if="profile.prod" class="db-prod-badge">{{ t('core.dbProd') }}</span>
                      <span v-if="profileSessionCount(profile.id)" class="db-live-badge"
                            :aria-label="t('core.dbDesignSessionCount', {
                              count: profileSessionCount(profile.id),
                            })">
                        <i aria-hidden="true"></i>{{ profileSessionCount(profile.id) }}
                      </span>
                    </span>
                    <code class="db-profile__address">{{ profile.host }}:{{ profile.port }}</code>
                    <span class="db-profile__meta">
                      {{ engineLabel(profile.engine) }} · {{ roleLabel(profile.role) }}
                      <span v-if="profile.via === 'ssh'" class="db-via-badge">SSH</span>
                    </span>
                  </UiButton>
                </section>
                <div v-if="!profileGroups.length" class="db-catalog-empty" role="status">
                  <strong>{{ t('core.dbDesignNoMatches') }}</strong>
                  <span>{{ t('core.dbDesignChangeSearch') }}</span>
                  <UiButton variant="text" size="compact" @click="search = ''">
                    {{ t('core.dbDesignClearSearch') }}
                  </UiButton>
                </div>
              </div>
              <div v-else-if="!store.error" class="db-profiles__empty db-catalog-empty" role="status">
                <strong>{{ t('core.dbProfileyPokaNet') }}</strong>
                <span>{{ t('core.dbDesignEmptyHint') }}</span>
                <UiButton tone="accent" @click="toggleCreate">{{ t('core.dbDesignAddProfile') }}</UiButton>
              </div>
              <div v-if="selectedProfile" class="db-profiles__footer">
                <section class="db-selected" :aria-label="t('core.dbDesignSelectedProfile')">
                  <p class="db-selected__project">{{ selectedProfile.projectId }}</p>
                  <div class="db-selected__heading">
                    <strong>{{ selectedProfile.label }}</strong>
                    <span v-if="selectedProfile.prod" class="db-prod-badge">{{ t('core.dbProd') }}</span>
                  </div>
                  <code class="db-selected__address">
                    {{ selectedProfile.user }}@{{ selectedProfile.host }}:{{ selectedProfile.port }}
                  </code>
                  <span class="db-selected__meta">
                    {{ engineLabel(selectedProfile.engine) }} · {{ roleLabel(selectedProfile.role) }}
                    <span v-if="selectedProfile.database"> · {{ selectedProfile.database }}</span>
                  </span>
                  <div v-if="profileSessionCount(selectedProfile.id)" class="db-selected__actions">
                    <UiButton tone="accent" data-context="workspace-form"
                              @click="openProfileSession(selectedProfile.id)">
                      {{ t('core.dbDesignOpenConsole') }}
                    </UiButton>
                    <UiButton variant="text" data-context="workspace-form"
                              :aria-expanded="showNewLogin" aria-controls="db-login"
                              @click="showNewLogin = !showNewLogin">
                      {{ showNewLogin ? t('core.dbDesignHideLogin') : t('core.dbDesignNewSession') }}
                    </UiButton>
                  </div>
                  <form v-if="!profileSessionCount(selectedProfile.id) || showNewLogin"
                        id="db-login" class="db-connect-form" @submit.prevent="openSession">
                    <UiField :label="t('core.dbParolNaOdinVhod')">
                      <UiPasswordInput ref="passwordInput" v-model="password" autocomplete="current-password"
                                       :aria-label="t('core.dbParolDlyaLabel', { label: selectedProfile.label })"
                                       :placeholder="t('core.trackerPassword')" :disabled="Boolean(openingProfileId)" />
                    </UiField>
                    <UiField v-if="selectedProfile.via === 'ssh'" :label="t('core.dbSshSessiya')" :hint="sshSessionHint">
                      <UiSelect v-model="sshSessionId" data-db-ssh-session :disabled="Boolean(openingProfileId)">
                        <option value="">{{ t('core.dbVyberiteSshSessiyu') }}</option>
                        <option v-for="session in availableSshSessions" :key="session.id" :value="session.id">
                          {{ session.label || session.id }}
                        </option>
                      </UiSelect>
                    </UiField>
                    <UiButton type="submit" block variant="solid" tone="accent" data-context="workspace-form"
                              :loading="openingProfileId === selectedProfile.id" :loading-label="t('core.dbOtkryvayuSessiyu')"
                              :disabled="!password || (selectedProfile.via === 'ssh' && !sshSessionId)"> {{ t('core.dbOtkrytSessiyu') }} </UiButton>
                  </form>
                </section>
                <p class="db-secret-note">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m5 12 4 4L19 6" />
                  </svg> {{ t('core.dbParolNeSohranyaetsyaI') }} </p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import PluginInstallDialog from '../settings/PluginInstallDialog.vue';
import PluginSourcePanel from '../settings/PluginSourcePanel.vue';
import type { InstallSubject } from '../../stores/packageInstall.ts';

import { toolWindowText } from '../../shared/tools/toolWindowMessages.ts';
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { errorMessage } from '../../../../shared/lib/errors.ts';

import {
  UiRefreshIcon,
  UiButton,
  UiField,
  UiFormActions,
  UiIconButton,
  UiCreateButton,
  UiInlineMessage,
  UiInput,
  UiNumberInput,
  UiPasswordInput,
  UiPaneHeader,
  UiSearchInput,
  UiSkeletonLayout,
  UiSelect,
  UiSwitch,
  UiTab,
  UiTabs,
  UiTextarea,
  alertDialog,
  t,
  vTooltip,
  UiLoadingState, uiLocale
} from '../../ui';
import type {
  DbEngine,
  DbQuery,
  DbResult,
  DbSession,
} from '../../../../shared/plugins/db/dbContracts.ts';
import {
  cancelDbQuery,
  closeDbSession,
  loadDb,
  loadDbProjects,
  loadDbSchema,
  loadDbSshSessions,
  openDbSession,
  runDbQuery,
  saveDbProfile,
  setDbAgentAccess,
  useDbStore,
  watchDb,
} from '../../actions/db';

const props = withDefaults(
  defineProps<{
    active?: boolean;
    compact?: boolean;
    presentation?: string;
  }>(),
  {
    active: true,
    compact: false,
    presentation: 'page',
  },
);

const store = useDbStore();

watchDb();

const search = ref('');
const showCreate = ref(false);
const showNewLogin = ref(false);
const passwordInput = ref<InstanceType<typeof UiPasswordInput> | null>(null);
const selectedProfileId = ref('');
const selectedSessionId = ref('');
const sshSessionId = ref('');
const password = ref('');
const query = ref('');
const mobilePane = ref('profiles');
const resultQueryIds = reactive<Record<string, string>>({});
const fallbackResults = reactive<Record<string, DbResult | null>>({});
const localError = ref('');
const openingProfileId = ref('');
const closingSessionId = ref('');
const schemaLoadingIds = reactive(new Set<string>());
const submittingQuery = ref(false);
const savingProfile = ref(false);

const draft = reactive({
  projectId: '',
  label: '',
  engine: '',
  role: 'read',
  host: '',
  // Пустое поле порта — это «не задан», а не ноль: ноль был бы настоящим портом.
  port: '' as number | '',
  user: '',
  database: '',
  via: 'direct',
  prod: false,
});

const driverDialogOpen = ref(false);
const driverDialogMode = ref<'install' | 'update'>('install');
const driverDialogSubject = ref<InstallSubject | null>(null);
const selectedDriver = computed<InstallSubject | null>(() => {
  const id = showCreate.value ? draft.engine : selectedProfile.value?.engine;
  const engine = store.engines?.find((item) => item.id === id);

  if (!engine || !Object.hasOwn(store.engineInstalls ?? {}, engine.id)) {
    return null;
  }

  return {
    id: engine.id,
    name: engine.label,
    install: store.engineInstalls[engine.id],
  };
});

/**
 * Установка открывает общий wizard с отдельным серверным родом пакета.
 * Карточка выбранного движка передаётся только при обновлении или привязке источника.
 */
function openDriverInstall(mode: 'install' | 'update', selected = true): void {
  driverDialogMode.value = mode;
  driverDialogSubject.value = selected ? selectedDriver.value : null;
  driverDialogOpen.value = true;
}

const visibleError = computed(() => localError.value || store.error || '');

const mobileWorkspace = computed({
  get: () => ['profiles', 'activity'].includes(mobilePane.value) ? mobilePane.value : 'console',
  set: (value: string) => {
    mobilePane.value = value === 'console' ? 'query' : value;
  },
});

const refreshLoading = computed(() => store.loading || store.projectsLoading);
const selectedProfile = computed(() => (
  (store.profiles || []).find((profile) => profile.id === selectedProfileId.value) || null
));
const profileGroups = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  const groups = new Map<string, typeof store.profiles>();

  for (const profile of store.profiles || []) {
    const text = [profile.projectId, profile.label, profile.host, profile.port, profile.user,
      profile.database, engineLabel(profile.engine), roleLabel(profile.role), profile.via].join(' ');

    if (needle && !text.toLocaleLowerCase().includes(needle)) {
      continue;
    }

    const profiles = groups.get(profile.projectId) || [];

    profiles.push(profile);
    groups.set(profile.projectId, profiles);
  }

  return [...groups].map(([projectId, profiles]) => ({ projectId, profiles }));
});
const activeSession = computed(() => (
  (store.sessions || []).find((session) => session.id === selectedSessionId.value) || null
));
// Новый профиль базы заводят только на активный проект: архивным уже не работают,
// а профили, заведённые до архива, остаются на месте вместе со своим проектом.
const projectOptions = computed(() => (store.projects || []).filter((project) => !project.archivedAt));

watch(projectOptions, (projects) => {
  if (draft.projectId && !projects.some((project) => project.id === draft.projectId)) {
    draft.projectId = '';
  }
});

const activeQueryCount = computed(() => (store.queries || []).filter((item) => (
  ['checking', 'waiting', 'running'].includes(item.state)
)).length);
const visibleQueries = computed(() => [...(store.queries || [])].sort((left, right) => (
  String(right.startedAt || '').localeCompare(String(left.startedAt || ''))
)));
const availableSshSessions = computed(() => (store.sshSessions || []).filter((session) => (
  !selectedProfile.value?.projectId || session.projectId === selectedProfile.value.projectId
)));
const sshSessionHint = computed(() => (
  availableSshSessions.value.length
    ? t('core.dbTunnelPoydetCherezUzhe')
    : t('core.dbDlyaEtogoProektaNet')
));
const projectPlaceholder = computed(() => {
  if (store.projectsLoading && !projectOptions.value.length) {
    return t('core.dbZagruzkaProektov');
  }

  return projectOptions.value.length ? t('core.taskFormChooseProject') : t('core.dbProektovPokaNet');
});
const profileDraftValid = computed(() => Boolean(
  draft.projectId
  && draft.label
  && draft.engine
  && draft.host
  && Number(draft.port) >= 1
  && Number(draft.port) <= 65_535
  && draft.user,
));

const currentSchema = computed(() => store.schemas?.[selectedSessionId.value] || null);
const schemaRows = computed(() => rowsOf(currentSchema.value));
const schemaItems = computed(() => schemaRows.value
  .map((row, index) => schemaItemLabel(row, index))
  .filter(Boolean));
const schemaLoaded = computed(() => currentSchema.value !== null);
const formattedSchema = computed(() => (
  currentSchema.value ? JSON.stringify(currentSchema.value, null, 2) : t('core.dbShemaEscheNeZagruzhena')
));

const activeResultId = computed(() => resultQueryIds[selectedSessionId.value] || '');
const activeResultQuery = computed(() => (
  (store.queries || []).find((item) => item.id === activeResultId.value) || null
));
const displayedResult = computed(() => (
  activeResultQuery.value?.result
  || fallbackResults[selectedSessionId.value]
  || null
));
const failedResult = computed(() => {
  const value = displayedResult.value;

  return value && 'ok' in value && value.ok === false ? value : null;
});

// Счётчик строк относится только к настоящему ответу базы. У отказа его нет, и
// показать «0 из 0» вместо ошибки значило бы выдать неудачу за пустой результат.
const limitedResult = computed<DbResult | null>(() => {
  const value = displayedResult.value;

  return value && (value as DbResult).untrusted === true ? value as DbResult : null;
});
const queryInFlight = computed(() => Boolean(activeResultId.value) && (
  !activeResultQuery.value
  || ['checking', 'waiting', 'running'].includes(activeResultQuery.value.state)
));
const resultRows = computed(() => rowsOf(displayedResult.value));
const resultColumns = computed(() => {
  const columns: string[] = [];

  for (const row of resultRows.value) {
    const names = row && typeof row === 'object' && !Array.isArray(row)
      ? Object.keys(row)
      : [t('core.dbZnachenie')];

    for (const name of names) {
      if (!columns.includes(name)) {
        columns.push(name);
      }
    }
  }

  return columns;
});
const formattedResult = computed(() => JSON.stringify(displayedResult.value, null, 2));

// Ответ базы приходит либо ограниченным результатом, либо отказом без строк.
// Обе формы законны, и отсутствие строк не должно ронять показ.
function rowsOf(value: unknown): unknown[] {
  const source = (value ?? {}) as { rows?: unknown };

  if (Array.isArray(source.rows)) {
    return source.rows;
  }

  return Array.isArray(value) ? value : [];
}

// Название движка берётся из живого реестра: адаптеры объявляют себя сами, и
// зашитый здесь список разошёлся бы с ними при первом же новом движке.
function engineLabel(engine: string | DbEngine | null | undefined): string {
  const id = typeof engine === 'string' ? engine : engine?.id;
  const known = (store.engines || []).find((item) => item.id === id);

  return known?.label
    || (typeof engine === 'string' ? '' : engine?.label)
    || id
    || t('core.dbDvizhok');
}

function roleLabel(role: string): string {
  return role === 'write' ? t('core.videoZapis3') : t('core.chatChtenie');
}

function queryActorLabel(actor: string | null | undefined): string {
  return actor === 'agent' ? t('core.dbAgent') : t('core.dbChelovek');
}

function queryStateLabel(state: string): string {
  return ({
    checking: t('settings.checking'),
    waiting: t('core.dbZhdetPodtverzhdeniya'),
    running: t('settings.running'),
    done: t('core.dbZavershen'),
    denied: t('core.dbOtklonen'),
    error: t('settings.error'),
    cancelled: t('core.interrupted'),
  } as Record<string, string>)[state] || t('core.showcaseOzhidanie');
}

function queryTone(state: string): string {
  return ({
    checking: 'is-waiting',
    waiting: 'is-waiting',
    running: 'is-running',
    done: 'is-done',
    denied: 'is-danger',
    error: 'is-danger',
    cancelled: 'is-muted',
  } as Record<string, string>)[state] || 'is-muted';
}

function outcomeLabel(outcome: string | null | undefined): string {
  return ({
    success: t('core.dbUspeshno'),
    query_failed: t('core.dbOshibkaZaprosa'),
    cancelled: t('core.interrupted'),
    session_lost: t('core.dbSessiyaPoteryana'),
  } as Record<string, string>)[String(outcome)] || t('core.dbOtklonen');
}

function outcomeTone(outcome: string | null | undefined): string {
  return outcome === 'success' ? 'is-good' : 'is-bad';
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return value || '';
  }

  return new Intl.DateTimeFormat(uiLocale.value, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

// Объём ответа человеку. Неизвестный размер называется словами: ноль байт и
// «не посчитали» — разные вещи, и путать их на экране нельзя.
function formatBytes(value: unknown): string {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes < 0) {
    return t('core.dbObemNeizvesten');
  }
  if (bytes < 1_024) {
    return t('core.docBytesB', { bytes: bytes });
  }

  return t('core.dbTofixedbytes1024010Kib', { toFixedbytes1024010: (bytes / 1_024).toFixed(bytes < 10_240
                        ? 1
                        : 0) });
}

function sessionTabId(sessionId: string): string {
  return `db-session-tab-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function sessionTabTitle(session: DbSession): string {
  return [
    session.label,
    session.projectId,
    engineLabel(session.engine),
    roleLabel(session.role),
  ].filter(Boolean).join(' — ');
}

function profileSessions(profileId: string): DbSession[] {
  return (store.sessions || []).filter((session) => session.profileId === profileId);
}

function profileSessionCount(profileId: string): number {
  return profileSessions(profileId).length;
}

/**
 * Форма добавления занимает рабочую область, но не пересоздаёт консоль и её запрос.
 * При закрытии черновик остаётся доступным для следующего открытия.
 */
function toggleCreate(): void {
  showCreate.value = !showCreate.value;
}

/**
 * Выбор подключённого профиля возвращает его живую сессию без нового входа.
 * Фильтр каталога не участвует в выборе и не сбрасывает одноразовый пароль.
 */
function selectProfile(profileId: string): void {
  selectedProfileId.value = profileId;
  showCreate.value = false;

  if (profileSessionCount(profileId)) {
    openProfileSession(profileId);
  }
}

/**
 * Возвращаемся в текущую сессию профиля либо первую доступную, сохраняя её результат.
 * На узком экране переход сразу показывает консоль вместо каталога.
 */
function openProfileSession(profileId: string): void {
  const sessions = profileSessions(profileId);
  const session = sessions.find((item) => item.id === selectedSessionId.value) || sessions[0];

  if (session) {
    selectedSessionId.value = session.id;
    mobilePane.value = 'query';
    showCreate.value = false;
  }
}

function querySessionOpen(item: DbQuery | null | undefined): boolean {
  return (store.sessions || []).some((session) => session.id === item?.sessionId);
}

// Строка схемы приходит из чужой базы и формы не обещает: у одного движка это
// объект с именем таблицы, у другого — просто строка.
function schemaItemLabel(row: unknown, index: number): string {
  if (row === null || row === undefined) {
    return t('core.dbElementIndex1', { index1: index + 1 });
  }
  if (typeof row !== 'object') {
    return String(row);
  }
  if (Array.isArray(row)) {
    return (row as unknown[]).map((item) => String(item)).join(', ');
  }

  const named = row as Record<string, unknown>;
  const preferred = ['name', 'table', 'TABLE_NAME']
    .map((key) => named[key])
    .find((value) => value !== undefined);
  const value = preferred ?? Object.values(named)[0];

  return value === undefined ? t('core.dbElementIndex1', { index1: index + 1 }) : String(value);
}

// Ячейка ответа базы: null показывается как есть, отсутствующая колонка — пустым
// местом, а вложенный объект сериализуется, а не даёт «[object Object]».
function resultCell(row: unknown, column: string): string {
  const value = row && typeof row === 'object' && !Array.isArray(row)
    ? (row as Record<string, unknown>)[column]
    : row;

  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '';
  }

  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * После общей загрузки выбор остаётся на живых сущностях и не указывает в пустоту:
 * профиль мог удалить другой человек, а сессию — закрыть таймаут простоя.
 */
function reconcileSelections(): void {
  const profiles = store.profiles || [];
  const sessions = store.sessions || [];

  if (!profiles.some((profile) => profile.id === selectedProfileId.value)) {
    selectedProfileId.value = profiles[0]?.id || '';
  }
  if (!sessions.some((session) => session.id === selectedSessionId.value)) {
    selectedSessionId.value = sessions[0]?.id || '';
  }

  const firstEngine = store.engines?.[0];

  if (!draft.engine && firstEngine) {
    draft.engine = firstEngine.id;
  }
}

/**
 * Перечитываем каталог и проекты независимо друг от друга.
 * После ответов сохраняем выбор только среди существующих профилей и сессий.
 */
async function refresh(): Promise<void> {
  localError.value = '';
  await Promise.all([loadDb(), loadDbProjects()]);
  reconcileSelections();
}

/**
 * Вход в базу. Пароль очищается независимо от исхода — он одноразовый и в
 * состоянии не хранится, — а новая сессия сразу становится рабочей вкладкой.
 */
async function openSession(): Promise<void> {
  const profile = selectedProfile.value;
  const sshSessionSelected = profile?.via !== 'ssh' || availableSshSessions.value
    .some((session) => session.id === sshSessionId.value);

  if (!profile || !password.value || !sshSessionSelected || openingProfileId.value) {
    return;
  }

  openingProfileId.value = profile.id;
  localError.value = '';

  try {
    const session = await openDbSession(
      profile.id,
      password.value,
      profile.via === 'ssh' ? sshSessionId.value : '',
    );

    if (session.id) {
      selectedSessionId.value = session.id;
      mobilePane.value = 'query';
      showNewLogin.value = false;
    }
  } catch (error) {
    localError.value = errorMessage(error, t('core.dbNeUdalosOtkrytSessiyu'));
  } finally {
    password.value = '';
    openingProfileId.value = '';
  }
}

/**
 * Схема привязана к идентификатору сессии, чтобы поздний ответ не сменил состояние
 * другой вкладки: человек к этому моменту мог уйти на соседнюю базу.
 */
async function loadSchema(): Promise<void> {
  const sessionId = selectedSessionId.value;

  if (!sessionId || schemaLoadingIds.has(sessionId)) {
    return;
  }

  schemaLoadingIds.add(sessionId);
  localError.value = '';

  try {
    await loadDbSchema(sessionId);
  } catch (error) {
    localError.value = errorMessage(error, t('core.dbNeUdalosZagruzitShemu'));
  } finally {
    schemaLoadingIds.delete(sessionId);
  }
}

/**
 * Запуск запоминает идентификатор запроса, а результат подхватывается из общей
 * живой ленты: ответ базы приходит позже и может идти минутами.
 */
async function runQuery(): Promise<void> {
  if (!selectedSessionId.value || !query.value.trim() || submittingQuery.value) {
    return;
  }

  const sessionId = selectedSessionId.value;

  submittingQuery.value = true;
  localError.value = '';

  try {
    resultQueryIds[sessionId] = await runDbQuery(sessionId, query.value);
    fallbackResults[sessionId] = null;
    mobilePane.value = 'result';
  } catch (error) {
    localError.value = errorMessage(error, t('core.dbNeUdalosZapustitZapros'));
  } finally {
    submittingQuery.value = false;
  }
}

// Переход к чужому запросу открывает его сессию и показывает сохранённый ответ:
// живая лента могла уже уйти вперёд, а человек смотрит именно на этот запрос.
function inspectQuery(item: DbQuery): void {
  const matchingSession = (store.sessions || []).find((session) => session.id === item.sessionId);

  if (!matchingSession) {
    return;
  }

  selectedSessionId.value = matchingSession.id;
  mobilePane.value = 'result';
  resultQueryIds[matchingSession.id] = item.id || '';
  fallbackResults[matchingSession.id] = rowsOf(item.result).length
    ? item.result as DbResult
    : null;
}

/**
 * Отмена сохраняет серверное объяснение и не маскирует невозможность прервать
 * запрос: часть команд снять нечем, и человек должен знать об этом, а не ждать.
 */
async function cancelQuery(queryId: string): Promise<void> {
  try {
    await cancelDbQuery(queryId);
  } catch (error) {
    localError.value = errorMessage(error, t('core.dbNeUdalosPrervatZapros'));
  }
}

/**
 * После закрытия вкладки выбирается соседняя живая сессия, как в SSH-панели:
 * иначе рабочее место человека остаётся пустым посреди открытых подключений.
 */
async function closeActiveSession(): Promise<void> {
  const sessionId = selectedSessionId.value;

  if (!sessionId || closingSessionId.value) {
    return;
  }

  const sessions = store.sessions || [];
  const index = sessions.findIndex((session) => session.id === sessionId);
  const replacementId = sessions[index + 1]?.id || sessions[index - 1]?.id || '';

  closingSessionId.value = sessionId;

  try {
    await closeDbSession(sessionId);
    delete resultQueryIds[sessionId];
    delete fallbackResults[sessionId];
    selectedSessionId.value = (store.sessions || [])
      .some((session) => session.id === replacementId) ? replacementId : '';
  } catch (error) {
    await alertDialog(errorMessage(error, t('core.dbNeUdalosZakrytSessiyu')), { title: t('core.databases') });
  } finally {
    closingSessionId.value = '';
  }
}

// Доступ агента к живой сессии. Это решение человека, и отказ по нему должен быть
// виден сразу: молчаливо оставленный тумблер обещал бы доступ, которого нет.
async function setAgentAccess(sessionId: string, allowed: boolean): Promise<void> {
  try {
    await setDbAgentAccess(sessionId, allowed);
  } catch (error) {
    await alertDialog(
      errorMessage(error, t('core.dbNeUdalosIzmenitDostup')),
      { title: t('core.databases') },
    );
  }
}

/**
 * Новый профиль сохраняет только описание подключения. Пароля в форме нет вовсе:
 * он спрашивается отдельно при входе и не переживает его.
 */
async function saveProfile(): Promise<void> {
  if (!profileDraftValid.value || savingProfile.value) {
    return;
  }

  savingProfile.value = true;

  try {
    const saved = await saveDbProfile({
      ...draft,
      port: Number(draft.port),
    });

    Object.assign(draft, {
      projectId: '',
      label: '',
      engine: store.engines?.[0]?.id || '',
      role: 'read',
      host: '',
      port: '',
      user: '',
      database: '',
      via: 'direct',
      prod: false,
    });

    if (saved?.id) {
      selectedProfileId.value = saved.id;
    }

    search.value = '';
    showCreate.value = false;
    mobilePane.value = 'profiles';
  } catch (error) {
    await alertDialog(
      errorMessage(error, t('core.dbNeUdalosSohranitProfil')),
      { title: t('core.databases') },
    );
  } finally {
    savingProfile.value = false;
  }
}

watch(selectedProfileId, async () => {
  password.value = '';
  sshSessionId.value = '';
  showNewLogin.value = false;

  if (selectedProfile.value?.via === 'ssh') {
    try {
      await loadDbSshSessions();
    } catch (error) {
      localError.value = errorMessage(error, t('core.dbNeUdalosZagruzitSsh'));
    }
  }
});

watch(showNewLogin, async (visible) => {
  if (visible) {
    await nextTick();
    passwordInput.value?.focus();
  } else {
    password.value = '';
  }
});

watch(selectedSessionId, (sessionId, previousId) => {
  if (sessionId && sessionId !== previousId) {
    void loadSchema();

    if (!previousId) {
      mobilePane.value = 'query';
    }
  }
});

watch(
  () => (store.profiles || []).map((profile) => profile.id).join('|'),
  reconcileSelections,
);
watch(
  () => (store.sessions || []).map((session) => session.id).join('|'),
  reconcileSelections,
);

/**
 * Снимок хранит выбор и SQL-черновик без пароля и результатов запроса.
 * Выполняющийся запрос не переносится и не запускается повторно.
 */
function exportState() {
  if (queryInFlight.value) {
    throw new Error(toolWindowText('toolDbBusy'));
  }

  return {
    profileId: selectedProfileId.value,
    sessionId: selectedSessionId.value,
    query: query.value,
  };
}

/**
 * Выбор применяется к перечитанным профилям и сессиям без исполнения SQL.
 * Исчезнувшие сущности остаются в прежнем состоянии пустого выбора.
 */
async function importState(state: Record<string, unknown>) {
  await refresh();
  selectedProfileId.value = typeof state.profileId === 'string' ? state.profileId : '';
  selectedSessionId.value = typeof state.sessionId === 'string' ? state.sessionId : '';
  reconcileSelections();
  query.value = typeof state.query === 'string' ? state.query : '';
}

defineExpose({ exportState, importState });
onMounted(refresh);
</script>

<style scoped>
.db-panel {
  box-sizing: border-box;
  container: db-panel / inline-size;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--ink);
}

.db-panel__surface {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.db-panel__heading {
  flex: none;
  min-width: 0;
  background: var(--topbar);
}

.db-panel.is-compact.is-dock .db-panel__heading {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.db-panel__title,
.db-live-queries__status,
.db-profile__heading,
.db-profile__meta,
.db-selected__heading,
.db-selected__actions,
.db-console__header,
.db-console__context,
.db-live-label,
.db-live-badge,
.db-subsection-heading,
.db-query-editor > header,
.db-query-editor__actions,
.db-result-stage__header,
.db-result-stage__header > div,
.db-session-endpoint,
.db-agent-access,
.db-audit article header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.db-panel__title {
  gap: 6px;
}

.db-panel__summary,
.db-activity-label {
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 400;
}

.db-running-label {
  color: var(--warn);
  font-size: 11px;
}

.db-panel h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}

.db-panel__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.db-panel__navigation,
.db-console__navigation {
  display: none;
  flex: none;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
}

.db-layout {
  display: grid;
  flex: 1;
  grid-template-columns: 288px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

.db-profiles {
  display: flex;
  flex-direction: column;
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.db-catalog-search {
  flex: none;
  padding: 10px;
  border-bottom: 1px solid var(--line);
}

.db-profiles__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 0 10px;
  overflow: auto;
}

.db-profile-list {
  padding-block: 4px 8px;
}

.db-profile-group__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 9px 10px 5px;
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}

.db-profile-group__heading > span:first-child,
.db-profile__heading strong,
.db-selected__heading strong,
.db-selected__project {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-profile__heading {
  gap: 6px;
}

.db-profile__heading strong {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
}

.db-profile__address {
  display: block;
  overflow: hidden;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-profile__meta,
.db-selected__meta {
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 17px;
  overflow-wrap: anywhere;
}

.db-live-badge {
  flex: none;
  gap: 4px;
  color: var(--good);
  font-size: 10px;
}

.db-live-badge i,
.db-live-label i,
.db-tab__dot {
  display: block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--good);
}

.db-profiles__footer {
  position: sticky;
  z-index: 2;
  bottom: 0;
  display: grid;
  flex: none;
  gap: 8px;
  margin-inline: -10px;
  padding: 10px;
  border-top: 1px solid var(--line);
  background: var(--sidebar);
}

.db-selected {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
}

.db-selected__project {
  margin: 0;
  color: var(--ink-low);
  font-size: 11px;
  line-height: 15px;
}

.db-selected__heading strong {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 18px;
}

.db-selected__address {
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 16px;
  overflow-wrap: anywhere;
}

.db-selected__actions {
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.db-connect-form {
  display: grid;
  gap: 10px;
  min-width: 0;
  margin-top: 4px;
}

.db-secret-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--ink-low);
  font-size: 10.5px;
  line-height: 15px;
}

.db-secret-note svg {
  flex: none;
  width: 13px;
  height: 15px;
}

.db-catalog-empty {
  display: grid;
  justify-items: start;
  gap: 8px;
  padding: 20px 10px;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.db-catalog-empty strong {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.db-workspace {
  display: flex;
  flex-direction: column;
  grid-column: 2;
  grid-row: 1;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}

.db-create {
  flex: none;
  width: 100%;
  max-width: 760px;
}

.db-profile-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  min-width: 0;
  padding: 16px;
}

.db-profile-form__environment {
  display: flex;
  align-items: center;
  min-height: var(--control-height);
}

.db-profile-form__actions,
.db-profile-form > .ui-inline-message {
  grid-column: 1 / -1;
}

.db-live-queries,
.db-audit {
  flex: none;
  min-width: 0;
}

.db-live-queries > summary,
.db-audit > summary {
  display: list-item;
  position: relative;
  padding-right: 32px;
}

.db-live-queries__status {
  float: right;
  margin-left: 10px;
}

.db-audit > summary > span:first-child {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  vertical-align: middle;
}

.db-audit > summary svg {
  width: 14px;
  height: 14px;
  color: var(--ink-mid);
}

.db-audit > summary > .db-count {
  position: absolute;
  right: 0;
  top: 7px;
}

.db-count {
  display: inline-grid;
  flex: none;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding-inline: 5px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 10px;
  line-height: 14px;
}

.db-count.is-running {
  color: var(--warn);
}

.db-query-list,
.db-audit__list {
  max-height: 240px;
  overflow: auto;
}

.db-query-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}

.db-query-row__main {
  flex: 1;
  min-width: 0;
}

.db-query-row__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-bottom: 4px;
  color: var(--ink-mid);
  font-size: 10px;
}

.db-query-row.is-running .db-query-row__meta {
  color: var(--warn);
}

.db-query-row.is-danger .db-query-row__meta {
  color: var(--bad);
}

.db-query-row code,
.db-audit article code {
  display: block;
  overflow: hidden;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-query-row__actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.db-query-list__empty,
.db-audit__empty {
  margin: 0;
  padding: 12px 0;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 17px;
}

.db-console {
  display: flex;
  flex: 1 0 440px;
  flex-direction: column;
  min-width: 0;
  min-height: 440px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--ground);
}

.db-console__header {
  flex: none;
  min-height: 40px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.db-session-switcher {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.db-session-switcher__label {
  flex: none;
  color: var(--ink-low);
  font-size: 10px;
}

.db-tabs {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
}

.db-tab__content {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 1px 4px;
}

.db-tab__copy {
  display: grid;
  min-width: 0;
  gap: 1px;
  text-align: left;
}

.db-tab__copy strong,
.db-tab__copy small {
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-tab__copy strong {
  font-size: 11px;
  line-height: 15px;
}

.db-tab__copy small {
  color: var(--ink-mid);
  font-size: 10px;
  line-height: 13px;
}

.db-console__title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-mid);
  font-size: 12px;
}

.db-console__title > span {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 11px;
}

.db-console__context {
  flex: none;
  margin-left: auto;
}

.db-live-label {
  gap: 5px;
  color: var(--good);
  font-size: 11px;
  white-space: nowrap;
}

.db-role-badge,
.db-prod-badge,
.db-via-badge,
.db-untrusted-badge {
  flex: none;
  padding: 3px 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 400;
  line-height: 13px;
}

.db-role-badge {
  background: var(--surface-2);
  color: var(--ink-mid);
}

.db-prod-badge {
  background: color-mix(in srgb, var(--bad) 12%, transparent);
  color: var(--bad);
}

.db-via-badge,
.db-untrusted-badge {
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  color: var(--warn);
}

.db-workbench {
  display: grid;
  flex: 1;
  grid-template-columns: 200px minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

.db-schema {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.db-subsection-heading {
  flex: none;
  justify-content: space-between;
  min-height: 40px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
}

.db-subsection-heading small,
.db-query-editor header small,
.db-session-endpoint small,
.db-agent-access small {
  display: block;
  margin-top: 2px;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 16px;
  overflow-wrap: anywhere;
}

.db-schema__list {
  display: grid;
  align-content: start;
  gap: 2px;
  margin: 0;
  padding: 6px;
  overflow: auto;
  list-style: none;
}

.db-schema__list li {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 6px 4px;
  color: var(--ink-mid);
  font-size: 11px;
}

.db-schema__list svg {
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ink-low);
}

.db-schema__list span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-schema__raw,
.db-result__raw {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 10px;
  overflow: auto;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 17px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.db-schema__empty,
.db-result-state {
  display: grid;
  flex: 1;
  place-content: center;
  justify-items: center;
  gap: 6px;
  min-height: 0;
  padding: 24px 16px;
  color: var(--ink-mid);
  text-align: center;
}

.db-schema__empty > span,
.db-result-state__icon {
  margin-bottom: 4px;
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 22px;
  line-height: 28px;
}

.db-schema__empty strong,
.db-result-state strong {
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 500;
}

.db-schema__empty small,
.db-result-state small {
  max-width: 32ch;
  color: var(--ink-low);
  font-size: 11px;
  line-height: 17px;
}

.db-query-console {
  display: grid;
  grid-template-rows: auto minmax(140px, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.db-query-editor {
  display: grid;
  align-content: start;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}

.db-query-editor > header,
.db-result-stage__header,
.db-query-editor__actions {
  justify-content: space-between;
}

.db-query-shortcut {
  flex: none;
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 10px;
}

.db-query-editor__actions > small {
  color: var(--ink-low);
  font-size: 10.5px;
  line-height: 16px;
}

.db-run-button {
  flex: none;
}

.db-result-stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ground);
}

.db-result-stage__header {
  flex: none;
  flex-wrap: wrap;
  min-height: 36px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.db-result-stage__header > div {
  flex-wrap: wrap;
  gap: 6px;
}

.db-result-count {
  color: var(--ink-mid);
  font-size: 11px;
}

.db-result-state__pulse {
  width: 14px;
  height: 14px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: db-spin 0.8s linear infinite;
}

.db-result-table-wrap {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.db-result-table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 11px;
}

.db-result-table th,
.db-result-table td {
  max-width: 420px;
  padding: 7px 10px;
  overflow: hidden;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-result-table th {
  position: sticky;
  z-index: 1;
  top: 0;
  background: var(--topbar);
  color: var(--ink-mid);
  font-weight: 600;
}

.db-session-tools {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  background: var(--topbar);
}

.db-session-endpoint,
.db-agent-access {
  flex: 1 1 180px;
}

.db-session-endpoint > span:last-child,
.db-agent-access > span {
  flex: 1;
  min-width: 0;
}

.db-session-endpoint strong,
.db-agent-access strong {
  display: block;
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-database-icon {
  display: grid;
  flex: none;
  place-items: center;
  color: var(--ink-low);
}

.db-database-icon svg {
  width: 16px;
  height: 16px;
}

.db-audit article {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}

.db-audit article header,
.db-audit article small {
  color: var(--ink-mid);
  font-size: 10px;
}

.db-audit article header strong {
  font-weight: 500;
}

.db-audit article time {
  margin-left: auto;
}

.db-audit .is-good {
  color: var(--good);
}

.db-audit .is-bad {
  color: var(--bad);
}

@keyframes db-spin {
  to {
    transform: rotate(360deg);
  }
}

/* Выбор областей зависит от ширины самой панели, включая узкий док.
   Скрытие сохраняет сессию, результаты и черновики смонтированными. */
@container db-panel (max-width: 940px) {
  .db-panel__navigation {
    display: block;
  }

  .db-console__navigation {
    display: block;
  }

  .db-layout {
    display: flex;
  }

  .db-workspace,
  .db-profiles {
    flex: 1;
  }

  .db-catalog-heading {
    display: none;
  }

  .db-profiles {
    border-right: 0;
  }

  .db-panel[data-pane='profiles'] .db-workspace,
  .db-panel:not([data-pane='profiles']) .db-profiles,
  .db-panel:not([data-pane='activity']) .db-live-queries,
  .db-panel[data-pane='activity'] .db-console,
  .db-panel[data-pane='activity'] .db-audit,
  .db-panel:not([data-pane='schema']) .db-schema,
  .db-panel[data-pane='schema'] .db-query-console,
  .db-panel[data-pane='result'] .db-query-editor,
  .db-panel[data-pane='query'] .db-result-stage {
    display: none;
  }

  .db-console {
    flex: 1 0 auto;
    min-height: 0;
  }

  .db-workbench {
    grid-template-columns: minmax(0, 1fr);
  }

  .db-query-console {
    grid-template-rows: auto;
  }

  .db-result-stage,
  .db-schema {
    min-height: 220px;
  }

  .db-schema {
    border-right: 0;
  }

  .db-live-queries__status {
    float: none;
    display: inline-flex;
  }
}

@container db-panel (max-width: 560px) {
  .db-panel__summary {
    display: none;
  }

  .db-profile-form {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    padding: 12px;
  }

  .db-workspace {
    padding: 10px;
  }

  .db-console__header {
    flex-wrap: wrap;
  }

  .db-session-switcher__label {
    display: none;
  }

  .db-session-switcher {
    max-width: calc(100% - 40px);
  }

  .db-console__context {
    flex-wrap: wrap;
    width: 100%;
    margin-left: 0;
  }

  .db-query-row {
    align-items: stretch;
    flex-direction: column;
  }

  .db-query-row code {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .db-query-row__actions {
    justify-content: flex-end;
  }

  .db-query-editor__actions {
    flex-wrap: wrap;
  }

  .db-query-editor__actions > small {
    flex: 1 1 120px;
  }

  .db-tab__copy strong,
  .db-tab__copy small {
    max-width: 17ch;
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-result-state__pulse {
    animation: none;
  }
}
</style>
