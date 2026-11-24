<template>
  <section
    class="ssh-panel ui-workspace"
    data-ui-workspace
    :class="{
      'is-compact': props.compact,
      'is-dock': props.presentation === 'dock',
      'show-connections': showConnections,
    }"
    aria-labelledby="ssh-panel-title"
    :aria-busy="refreshLoading || undefined"
  >
    <div class="ssh-panel__surface">
      <div class="ssh-panel__heading">
        <UiPaneHeader class="ssh-panel__header">
          <template #title>
            <div class="ssh-panel__title">
              <h2 id="ssh-panel-title">SSH</h2>
              <span class="ui-maturity-chip" data-product-maturity="beta" :aria-label="t('core.dbBetaVersiya')"> {{ t('core.dbBeta') }} </span>
            </div>
          </template>
          <template #meta>
            <span class="ssh-panel__summary" :aria-label="t('core.sshSvodkaSsh')"> {{ t('core.sshServerov') }} {{ store.connections?.length || 0 }} {{ t('core.sshSessiy') }} {{ store.sessions?.length || 0 }}
            </span>
            <UiButton v-if="sshApprovals.length" variant="text" size="compact" class="ssh-waiting"
                      @click="showApprovals">
              {{ sshApprovals.length }} {{ t('core.sshZhdetResheniya') }}
            </UiButton>
          </template>
          <template #actions>
            <UiIconButton class="ssh-refresh" role="embedded" data-context="workspace-toolbar"
                          :label="t('core.sshObnovitSsh')" v-tooltip="t('core.trackerUpdate')" :loading="refreshLoading"
                          :loading-label="t('core.updating')" @click="refresh">
              <UiRefreshIcon />
            </UiIconButton>
            <UiCreateButton :label="showCreate ? t('core.dbDesignHideForm') : t('core.sshDobavitServer')"
                            :expanded="showCreate" aria-controls="ssh-create" @click="toggleCreate" />
          </template>
        </UiPaneHeader>
      </div>

    <div class="ssh-panel__navigation">
      <UiTabs v-model="mobileWorkspace" size="compact" data-ui-workspace-tabs :label="t('core.sshRabochayaOblastSsh')">
        <UiTab value="connections" controls="ssh-connections"> {{ t('core.sshServery') }} {{ store.connections?.length || 0 }}
        </UiTab>
        <UiTab value="workspace" controls="ssh-workspace">
          {{ showCreate ? t('core.sshNovyyServer') : t('core.terminal') }}
        </UiTab>
      </UiTabs>
    </div>

    <div class="ssh-panel__body">
      <UiInlineMessage v-if="store.error" tone="danger"
    :data-perf-error="store.error && !refreshLoading && !store.connections?.length ? '' : undefined">
        {{ store.error }}
      </UiInlineMessage>

      <div class="ssh-layout">
      <div id="ssh-workspace" class="ssh-workspace">
        <section v-show="showCreate" id="ssh-create" class="ssh-create ui-workspace-section"
                 aria-labelledby="ssh-create-title">
          <UiPaneHeader>
            <template #title><h3 id="ssh-create-title">{{ t('core.sshNovyyServer') }}</h3></template>
            <template #actions>
              <UiButton data-context="workspace-toolbar" @click="toggleCreate">{{ t('core.cancel') }}</UiButton>
            </template>
          </UiPaneHeader>
          <form class="ssh-profile-form" @submit.prevent="saveConnection">
            <UiField :label="t('core.taskEditProject')" required>
              <UiSelect
                v-model="draft.projectId"
                required
                :disabled="!projectOptions.length"
                :aria-label="t('core.taskEditProject')"
                data-ssh-project-select
              >
                <option value="" disabled>{{ projectPlaceholder }}</option>
                <option
                  v-for="project in projectOptions"
                  :key="project.id"
                  :value="project.id"
                >
                  {{ project.id }}
                </option>
              </UiSelect>
            </UiField>

            <UiField :label="t('core.sshMetkaServera')" required>
              <UiInput
                v-model="draft.label"
                required
                :placeholder="t('core.sshNaprimerProduction')"
                :aria-label="t('core.sshMetkaServera')"
              />
            </UiField>

            <UiField :label="t('core.dbRol')" required>
              <UiInput
                v-model="draft.role"
                required
                :placeholder="t('core.sshNaprimerPrilozhenie')"
                :aria-label="t('core.sshRolServera')"
              />
            </UiField>

            <UiField :label="t('core.browserAddress')" required>
              <UiInput
                v-model="draft.host"
                required
                :placeholder="'server.example.org'"
                :aria-label="t('core.sshAdresServera')"
              />
            </UiField>

            <UiField :label="t('settings.port')">
              <UiNumberInput
                v-model="draft.port"
                :min="1"
                :max="65535"
                placeholder="22"
                :aria-label="t('settings.port')"
              />
            </UiField>

            <UiField :label="t('settings.user')" required>
              <UiInput
                v-model="draft.user"
                required
                autocomplete="username"
                :placeholder="'deploy'"
                :aria-label="t('settings.user')"
              />
            </UiField>

            <UiInlineMessage
              v-if="store.projectsError"
              class="ssh-project-message"
              tone="danger"
            > {{ t('core.sshSpisokProektovNeObnovlen') }} {{ store.projectsError }}
            </UiInlineMessage>
            <UiInlineMessage
              v-else-if="!store.projectsLoading && !projectOptions.length"
              class="ssh-project-message"
            > {{ t('core.sshSnachalaSozdayteProektV') }} </UiInlineMessage>

            <UiFormActions class="ssh-profile-form__actions">
              <UiButton
                type="submit"
                variant="solid"
                tone="accent"
                :loading="savingConnection"
                :loading-label="t('core.sshSohranyayu')"
                :disabled="!draft.projectId"
              > {{ t('core.save') }} </UiButton>
            </UiFormActions>
          </form>
        </section>


        <section
          v-show="!showCreate"
          class="ssh-console"
          :aria-label="t('core.sshSshTerminal')"
        >
          <header v-if="store.sessions?.length || !workspaceSession" class="ssh-console__header">
            <div v-if="store.sessions?.length" class="ssh-session-switcher">
              <UiTabs
                ref="sessionTabs"
                v-model="selectedSessionId"
                class="ssh-tabs"
                :label="t('core.sshSshSessii')"
              >
                <UiTab
                  v-for="session in store.sessions"
                  :key="session.id"
                  class="ssh-session-tab"
                  :id="sessionTabId(session.id)"
                  :value="session.id"
                  controls="ssh-terminal-panel"
                  :data-session-id="session.id"
                  :aria-label="sessionTabAriaLabel(session)"
                  v-tooltip="sessionTabTitle(session)"
                >
                  <span class="ssh-tab__content" aria-hidden="true">
                    <span class="ssh-tab__dot"></span>
                    <span class="ssh-tab__copy">
                      <span class="ssh-tab__project-line">
                        <small>{{ t('core.taskEditProject') }}</small>
                        <strong data-ssh-session-project>
                          {{ sessionProjectLabel(session) }}
                        </strong>
                      </span>
                      <small data-ssh-session-target>
                        {{ sessionTargetLabel(session) }}
                      </small>
                    </span>
                  </span>
                </UiTab>
              </UiTabs>
            </div>

            <UiIconButton
              v-if="activeSession"
              class="ssh-session-close"
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

            <div v-if="!workspaceSession" class="ssh-console__title">
              <span aria-hidden="true">›_</span> {{ t('core.terminal') }} </div>
          </header>

          <div v-if="workspaceSession" class="ssh-active-session" role="group" :aria-label="t('core.sshActiveSession')">
            <div class="ssh-active-session__identity" aria-live="polite">
              <div class="ssh-active-session__name">
                <span>{{ sessionProjectLabel(workspaceSession) }}</span>
                <span aria-hidden="true">/</span>
                <strong>{{ sessionTargetLabel(workspaceSession) }}</strong>
              </div>
              <code>{{ sessionAddress(workspaceSession) }}</code>
            </div>
            <div class="ssh-active-session__status">
              <span class="ssh-live-label" :data-state="workspaceStatus" role="status">
                <i aria-hidden="true"></i>{{ workspaceStatusLabel }}
              </span>
              <UiButton v-if="workspaceStatus === 'detached'" variant="outline" size="compact"
                        @click="restoreTerminal">
                {{ t('core.sshRestoreTerminal') }}
              </UiButton>
              <UiButton v-if="workspaceStatus === 'lost' && lostConnection" variant="outline" size="compact"
                        aria-haspopup="dialog" @click="openLogin(lostConnection.id)">
                {{ t('core.sshReconnect') }}
              </UiButton>
            </div>
          </div>

          <div
            id="ssh-terminal-panel"
            class="ssh-terminal-stage"
            role="tabpanel"
            :aria-labelledby="activeSession ? sessionTabId(activeSession.id) : undefined"
            :aria-label="activeSession ? t('core.sshTerminalLabel', { label: activeSession.label }) : t('core.sshSshTerminal')"
          >
            <div
              v-show="activeSession"
              ref="terminalHost"
              class="ssh-terminal"
              :data-connecting="workspaceStatus === 'connecting' || undefined"
              data-ssh-terminal-host
              data-escape-owner="terminal"
            ></div>

            <div v-if="lostSession" class="ssh-console__empty">
              <p>{{ t('core.sshLostSessionHint') }}</p>
            </div>
            <div v-else-if="!activeSession" class="ssh-console__empty" role="status">
              <span class="ssh-console__empty-icon" aria-hidden="true">›_</span>
              <strong>{{ t('core.sshNetAktivnoySshSessii') }}</strong>
              <span>{{ t('core.sshVyberiteSohranennyyServerTerminal') }}</span>
            </div>
          </div>

          <footer v-if="activeSession" class="ssh-session-tools">
            <UiSwitch
              :model-value="activeSession.agentAllowed"
              :aria-label="t('core.dbDostupAgentaKLabel', { label: activeSession.label })"
              @update:model-value="toggleAgentAccess(activeSession.id, $event)"
            > {{ t('core.sshKomandyAgenta') }} </UiSwitch>
            <p>{{ t('core.sshKazhdayaKomandaPoslePodtverzhdeniya') }}</p>

          </footer>
        </section>

        <section
          v-if="sshApprovals.length"
          ref="approvalsRegion"
          tabindex="-1"
          class="ssh-approvals"
          :aria-label="t('core.sshPodtverzhdeniyaKomand')"
        >
          <header class="ssh-approvals__heading">
            <span class="ssh-approvals__icon" aria-hidden="true">!</span>
            <div>
              <h3>{{ t('core.sshAgentZhdetResheniya') }}</h3>
              <small>{{ t('core.sshKomandaNeVypolnitsyaBez') }}</small>
            </div>
            <span class="ssh-count is-waiting">{{ sshApprovals.length }}</span>
          </header>

          <div class="ssh-approval-list">
            <article
              v-for="approval in sshApprovals"
              :key="approval.pid"
              class="ssh-approval"
              data-ssh-approval
            >
              <div class="ssh-approval__server" data-ssh-server>
                <span v-if="approval.tab?.projectId">{{ approval.tab.projectId }}</span>
                <strong>{{ approval.tab?.label || approval.server?.label }}</strong>
                <code>{{ approval.server?.host }}:{{ approval.server?.port }}</code>
              </div>
              <div class="ssh-approval__identity"> {{ t('core.sshPolzovatel') }} <strong>{{ approval.user }}</strong>
                <span v-if="approval.isRoot" class="ssh-badge">{{ 'root' }}</span>
                <span v-if="approval.usesSudo" class="ssh-badge">{{ 'sudo' }}</span>
              </div>
              <pre data-ssh-command>{{ approval.command }}</pre>
              <UiInput
                v-model="comments[approval.pid]"
                :placeholder="t('core.sshPoyasnenieKOtkazuNeobyazatelno')"
                :aria-label="t('core.sshPoyasnenieKKomandePid', { pid: approval.pid })"
              />
              <div class="ssh-approval__actions">
                <UiButton tone="danger" @click="deny(approval)">{{ t('core.sshOtkazat') }}</UiButton>
                <UiButton
                  variant="solid"
                  tone="accent"
                  @click="allow(approval)"
                > {{ t('core.allow') }} </UiButton>
              </div>
            </article>
          </div>
        </section>

        <details v-if="activeSession" v-show="!showCreate" :key="activeSession.id"
                 class="ssh-sftp ui-workspace-disclosure" data-context="workspace-inline">
          <summary>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7h7l2 2h9v10H3z" />
              <path d="M3 7V5h6l2 2" />
            </svg> {{ t('core.sshFaylySessii') }} </summary>
          <div class="ssh-sftp__body ui-workspace-section__body">
            <p class="ssh-files-context">
              <strong>{{ sessionTargetLabel(activeSession) }}</strong>
              <code>{{ sessionAddress(activeSession) }}</code>
            </p>
            <div class="ssh-files-bar">
              <UiInput v-model="remotePath" :aria-label="t('core.sshPutNaServere')" />
              <UiButton :loading="store.filesStatus === 'loading'" @click="openRemotePath">
                {{ t('core.open') }}
              </UiButton>
              <UiFilePicker
                :label="t('core.sshZagruzitFayl')"
                :disabled="store.filesStatus !== 'ready'"
                @change="uploadFiles"
              />
            </div>
            <UiInlineMessage v-if="store.filesStatus === 'error'" tone="danger">
              {{ store.filesError }}
            </UiInlineMessage>
            <p v-if="store.filesStatus === 'ready'" class="ssh-files-context">
              {{ t('core.sshOpenFolder', { path: store.remotePath }) }}
            </p>
            <ul v-if="store.filesStatus === 'ready' && store.files?.length" class="ssh-files">
              <li v-for="file in store.files" :key="file.name">
                <span>
                  <i aria-hidden="true">{{ file.type === 'directory' ? '▸' : '·' }}</i>
                  {{ file.name }}
                </span>
                <a
                  v-if="file.type !== 'directory'"
                  :href="sshDownloadUrl(file.name)"
                > {{ t('core.mediaDownload') }} </a>
              </li>
            </ul>
            <small v-else-if="store.filesStatus === 'ready'" class="ssh-files__empty">
              {{ t('core.sshEmptyFolder') }}
            </small>
            <small v-else-if="!store.filesStatus || store.filesStatus === 'idle'" class="ssh-files__empty">
              {{ t('core.sshKatalogPokaNeOtkryt') }}
            </small>
          </div>
        </details>

        <details v-show="!showCreate" class="ssh-audit ui-workspace-disclosure"
                 data-context="workspace-inline">
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
              </svg> {{ t('core.sshZhurnalKomandAgenta') }} </span>
            <span class="ssh-count">{{ store.audit?.length || 0 }}</span>
          </summary>
          <div v-if="store.audit?.length" class="ssh-audit__list">
            <article
              v-for="entry in store.audit"
              :key="`${entry.at}-${entry.sessionId}-${entry.command}`"
            >
              <header>
                <strong>{{ entry.label }}</strong>
                <span class="ssh-audit__decision" :class="entry.decision">
                  {{ auditDecisionLabel(entry.decision) }}
                </span>
                <time>{{ formatAuditDate(entry.at) }}</time>
              </header>
              <pre>{{ entry.command }}</pre>
              <pre v-if="entry.output" class="ssh-audit__output">{{ auditOutputText(entry) }}</pre>
            </article>
          </div>
          <p v-else class="ssh-audit__empty">{{ t('core.sshKomandAgentaEscheNe') }}</p>
        </details>
      </div>

      <section
        id="ssh-connections"
        ref="connectionsRegion"
        class="ssh-connections"
        :aria-label="t('core.sshServery2')"
        tabindex="-1"
      >
        <UiPaneHeader class="ssh-connections__header">
          <template #title><h3>{{ t('core.sshServery2') }}</h3></template>
          <template #meta>
            <span class="ssh-catalog-count" data-ssh-server-count>
              {{ store.connections?.length || 0 }}
            </span>
          </template>
        </UiPaneHeader>

        <p v-if="workspaceSession" class="ssh-catalog-target">
          <strong>{{ sessionProjectLabel(workspaceSession) }} / {{ sessionTargetLabel(workspaceSession) }}</strong>
          <code>{{ sessionAddress(workspaceSession) }}</code>
          <span>{{ workspaceStatusLabel }}</span>
        </p>

        <div v-if="store.connections?.length" class="ssh-catalog-search">
          <UiSearchInput
            v-model="search"
            size="compact"
            :aria-label="t('core.sshPoiskServera')"
            :placeholder="t('core.sshNaytiServer')"
          />
        </div>

        <div class="ssh-connections__body">
          <UiLoadingState v-if="refreshLoading && !store.connections?.length && !store.error">
            <UiSkeletonLayout layout="list" :header="false" />
          </UiLoadingState>
          <div v-else-if="store.connections?.length" class="ssh-connection-list">
            <section
              v-for="group in connectionGroups"
              :key="group.projectId"
              class="ssh-connection-group"
            >
              <h4 class="ssh-connection-group__heading">
                <UiDisclosureButton
                  class="ssh-project-toggle"
                  data-context="ssh-project-toggle"
                  :open="projectIsExpanded(group.projectId)"
                  :controls="projectGroupId(group.projectId)"
                  :data-ssh-project="group.projectId"
                  :aria-label="projectGroupLabel(
                    group.projectId,
                    group.connections.length,
                    group.sessionCount,
                  )"
                  :disabled="Boolean(search.trim() || connectingId)"
                  v-tooltip="search.trim() ? t('core.sshPoiskRaskryvaetPodhodyaschieProekty') : undefined"
                  @update:open="expandedProjectId = $event ? group.projectId : null"
                >
                  <span class="ssh-project-heading">
                    <span class="ssh-project-heading__name">
                      <strong>{{ group.projectId }}</strong>
                      <span
                        v-if="group.sessionCount"
                        class="ssh-session-pill"
                        :aria-label="sessionCountLabel(group.sessionCount)"
                        v-tooltip="sessionCountLabel(group.sessionCount)"
                      >
                        <span class="ssh-session-pill__dot" aria-hidden="true"></span>
                        <span aria-hidden="true">{{ group.sessionCount }}</span>
                      </span>
                    </span>
                    <span class="ssh-server-total">
                      {{ serverCountLabel(group.connections.length) }}
                    </span>
                  </span>
                </UiDisclosureButton>
              </h4>
              <div
                v-show="projectIsExpanded(group.projectId)"
                :id="projectGroupId(group.projectId)"
                class="ssh-connection-group__body"
              >
                <div
                  v-for="connection in group.connections"
                  :key="connection.id"
                  class="ssh-connection-row"
                >
                  <UiButton
                    class="ssh-connection"
                    variant="ghost"
                    data-context="workspace-catalog-row"
                    :data-connection-id="connection.id"
                    :pressed="connectionIsActive(connection.id)"
                    :aria-current="connectionIsActive(connection.id) ? 'true' : undefined"
                    :aria-haspopup="connectionSessionCount(connection.id) === 1 ? undefined : 'dialog'"
                    :disabled="Boolean(connectingId)"
                    @click="selectConnection(connection)"
                  >
                    <span class="ssh-connection__top">
                      <span class="ssh-connection__label">{{ connection.label }}</span>
                      <span class="ssh-connection__separator" aria-hidden="true">·</span>
                      <span class="ssh-connection__role">{{ connection.role }}</span>
                    </span>
                    <code class="ssh-connection__address">{{ sessionAddress(connection) }}</code>
                    <span class="ssh-connection__action">
                      <span v-if="connectionIsActive(connection.id)" class="ssh-current-label">
                        {{ t('core.sshCurrentServer') }}
                      </span>
                      {{ connectionActionLabel(connection.id) }}
                    </span>
                  </UiButton>
                  <UiIconButton
                    v-if="connectionSessionCount(connection.id)"
                    role="embedded"
                    :label="t('core.sshNewSessionOnServer', { label: connection.label, role: connection.role })"
                    aria-haspopup="dialog"
                    :disabled="Boolean(connectingId)"
                    v-tooltip="t('core.sshNewSessionOnServer', { label: connection.label, role: connection.role })"
                    @click="openLogin(connection.id)"
                  >＋</UiIconButton>
                </div>
              </div>
            </section>
            <div v-if="!connectionGroups.length" class="ssh-catalog-empty" role="status">
              <strong>{{ t('core.sshPodhodyaschihServerovNet') }}</strong>
              <span>{{ t('core.dbDesignChangeSearch') }}</span>
              <UiButton variant="text" size="compact" @click="search = ''"> {{ t('core.dbDesignClearSearch') }} </UiButton>
            </div>
          </div>

          <div v-else-if="!store.error" class="ssh-catalog-empty">
            <svg
              class="ssh-catalog-empty__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="m7 9 3 3-3 3 M13 15h4" />
            </svg>
            <strong>{{ t('core.sshServerovPokaNet') }}</strong>
            <span>{{ t('core.sshDobavtePervoeSshPodklyuchenie') }}</span>
            <UiButton variant="solid" tone="accent" @click="toggleCreate"> {{ t('core.sshDobavitServer') }} </UiButton>
          </div>
        </div>
      </section>

      </div>
    </div>
    </div>

    <UiDialog
      :open="Boolean(chooserConnection) && props.active"
      :title="t('core.sshChooseSession')"
      size="compact"
      mobile-sheet
      data-ssh-session-chooser
      initial-focus="[data-ssh-session-choice]"
      :return-focus="!chooserActivated"
      :close-label="t('core.close')"
      @update:open="chooserConnectionId = ''"
    >
      <div v-if="chooserConnection" class="ssh-chooser">
        <div class="ssh-login__target">
          <strong>{{ chooserConnection.projectId }} / {{ chooserConnection.label }} · {{ chooserConnection.role }}</strong>
          <code>{{ sessionAddress(chooserConnection) }}</code>
        </div>
        <UiButton
          v-for="session in connectionSessions(chooserConnection.id)"
          :key="session.id"
          variant="outline"
          data-ssh-session-choice
          :tone="session.id === activeSession?.id ? 'accent' : 'neutral'"
          :pressed="session.id === activeSession?.id"
          @click="openChosenSession(session.id)"
        >
          <span>{{ sessionTargetLabel(session) }}</span>
          <span v-if="session.id === activeSession?.id" class="ssh-chooser__current">
            {{ t('core.sshCurrentSession') }}
          </span>
        </UiButton>
        <UiInlineMessage v-if="!connectionSessionCount(chooserConnection.id)">
          {{ t('core.sshNetAktivnoySshSessii') }}
        </UiInlineMessage>
      </div>
      <template #footer>
        <UiButton @click="chooserConnectionId = ''">{{ t('core.cancel') }}</UiButton>
        <UiButton v-if="chooserConnection" @click="openLoginFromChooser(chooserConnection.id)">
          {{ t('core.sshNewSession') }}
        </UiButton>
      </template>
    </UiDialog>

    <UiDialog
      :open="Boolean(loginConnection) && props.active"
      :title="t('core.sshConnectToServer')"
      size="compact"
      data-ssh-login-dialog
      mobile-sheet
      initial-focus="[data-ssh-login-password]"
      :return-focus="!loginSucceeded"
      :busy="Boolean(connectingId)"
      :dismissible="!connectingId"
      :close-label="t('core.close')"
      @update:open="closeLogin"
    >
      <form
        v-if="loginConnection"
        id="ssh-login"
        class="ssh-login"
        @submit.prevent="openConnection(loginConnection)"
      >
        <div class="ssh-login__target">
          <strong>{{ loginConnection.projectId }} / {{ loginConnection.label }} · {{ loginConnection.role }}</strong>
          <code>{{ loginConnection.user }}@{{ loginConnection.host }}:{{ loginConnection.port }}</code>
        </div>
        <UiField :label="t('core.dbParolNaOdinVhod')" :hint="t('core.sshParoliNeSohranyayutsyaI')">
          <UiPasswordInput
            v-model="loginPassword"
            data-ssh-login-password
            :aria-label="t('core.dbParolDlyaLabel', { label: loginConnection.label })"
            autocomplete="current-password"
            :readonly="Boolean(connectingId)"
          />
        </UiField>
        <UiInlineMessage v-if="loginError" tone="danger">{{ loginError }}</UiInlineMessage>
      </form>

      <template #footer>
        <UiButton :disabled="Boolean(connectingId)" @click="closeLogin">{{ t('core.cancel') }}</UiButton>
        <UiButton
          type="submit"
          form="ssh-login"
          variant="solid"
          tone="accent"
          :loading="Boolean(connectingId)"
          :loading-label="t('core.sshPodklyuchayu')"
        >
          {{ t('core.connect') }}
        </UiButton>
      </template>
    </UiDialog>
  </section>
</template>

<script setup lang="ts">
import { toolWindowText } from '../../shared/tools/toolWindowMessages.ts';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { errorMessage } from '../../../../shared/lib/errors.ts';
import { sshSessionTabLabel } from '../../../../shared/plugins/ssh/sessionLabels.ts';

import {
  UiRefreshIcon, UiButton, UiDialog, UiDisclosureButton, UiField, UiFilePicker, UiFormActions,
  UiIconButton, UiCreateButton, UiInlineMessage, UiInput, UiNumberInput, UiPasswordInput,
  UiPaneHeader, UiSearchInput, UiSelect, UiSwitch, UiTab, UiTabs, alertDialog, confirmDialog,
  vTooltip, UiLoadingState, UiSkeletonLayout, t, messageRef, uiLocale
} from '../../ui';
import type {
  SshAuditEntry,
  SshConnection,
  SshSession,
} from '../../../../shared/plugins/ssh/sshContracts.ts';
import {
  activateSshSession,
  bindSshTerminal,
  closeSshSession,
  connectSshSession,
  decideSshHostKey,
  detachSshTerminal,
  listSshFiles,
  loadSsh,
  loadSshProjects,
  probeSshHostKey,
  resizeSshTerminal,
  saveSshConnection,
  sendSshInput,
  setSshAgentAccess,
  sshDownloadUrl,
  uploadSshFile,
  useSshStore,
  watchSsh,
} from '../../actions/ssh';
import { useChatApprovals } from '../../shared/chatApprovals.ts';
import type { ChatApproval } from '../../shared/chatApprovals.ts';

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

const store = useSshStore();
const chat = useChatApprovals();

watchSsh();

const terminalHost = ref<HTMLElement | null>(null);
const sessionTabs = ref<{ $el?: HTMLElement } | HTMLElement | null>(null);
const connectionsRegion = ref<HTMLElement | null>(null);
const approvalsRegion = ref<HTMLElement | null>(null);
const comments = reactive<Record<string, string>>({});
const remotePath = ref('.');
const showConnections = ref(!store.sessions?.length);
const showCreate = ref(false);
const createReturnToConnections = ref(false);
const chooserConnectionId = ref('');
const chooserActivated = ref(false);
const lostSession = ref<SshSession | null>(null);
const loginConnectionId = ref('');
const loginPassword = ref('');
const loginError = ref('');
const loginSucceeded = ref(false);
const search = ref('');
const expandedProjectId = ref<string | null>(null);
const savingConnection = ref(false);
const connectingId = ref('');
const closingSessionId = ref('');
let terminalFocusId = '';
const draft = reactive({
  projectId: '',
  label: '',
  role: '',
  host: '',
  port: 22,
  user: '',
});

const sshApprovals = computed(() => Object.values(chat.pending || {})
  .filter((item) => item.origin === 'ssh'));
const activeSession = computed(() => (store.sessions || [])
  .find((item) => item.id === store.activeId));
const workspaceSession = computed(() => activeSession.value || lostSession.value);
const workspaceStatus = computed(() => activeSession.value ? store.terminalStatus : 'lost');
const workspaceStatusLabel = computed(() => {
  switch (workspaceStatus.value) {
    case 'ready':
      return t('core.machineConnected');
    case 'detached':
      return t('core.sshTerminalDetached');
    case 'lost':
      return t('core.sshSessionLost');
    default:
      return t('core.sshTerminalOpening');
  }
});
const lostConnection = computed(() => store.connections
  .find((connection) => connection.id === lostSession.value?.connectionId));
const mobileWorkspace = computed({
  get: () => showConnections.value ? 'connections' : 'workspace',
  set: (value: string) => {
    showConnections.value = value === 'connections';
  },
});
const selectedSessionId = computed({
  get: () => store.activeId,
  set: (sessionId: string) => {
    if (sessionId && sessionId !== store.activeId) {
      void activateSession(sessionId);
    }
  },
});
// Новый сервер заводят только на активный проект: архивным уже не работают, а
// связи, заведённые до архива, остаются в списке со своим проектом.
const projectOptions = computed(() => store.projects || []);
const projectPlaceholder = computed(() => {
  if (store.projectsLoading && !projectOptions.value.length) {
    return t('core.dbZagruzkaProektov');
  }

  return projectOptions.value.length ? t('core.taskFormChooseProject') : t('core.dbProektovPokaNet');
});
const refreshLoading = computed(() => store.loading || store.projectsLoading);

const sessionsByConnection = computed(() => {
  const groups = new Map<string, SshSession[]>();

  for (const session of store.sessions || []) {
    const sessions = groups.get(session.connectionId) || [];

    sessions.push(session);
    groups.set(session.connectionId, sessions);
  }

  return groups;
});

const chooserConnection = computed(() => (store.connections || [])
  .find((connection) => connection.id === chooserConnectionId.value));
const loginConnection = computed(() => (store.connections || [])
  .find((connection) => connection.id === loginConnectionId.value));
const connectionGroups = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  const groups = new Map<string, SshConnection[]>();

  for (const connection of store.connections || []) {
    const text = [connection.projectId, connection.label, connection.role, connection.host,
      connection.user, connection.port].join(' ').toLocaleLowerCase();

    if (query && !text.includes(query)) {
      continue;
    }

    const connections = groups.get(connection.projectId) || [];

    connections.push(connection);
    groups.set(connection.projectId, connections);
  }

  return [...groups].map(([projectId, connections]) => ({
    projectId,
    connections,
    sessionCount: connections.reduce((count, connection) => (
      count + (sessionsByConnection.value.get(connection.id)?.length || 0)
    ), 0),
  }));
});

function projectGroupId(projectId: string): string {
  return `ssh-project-${encodeURIComponent(projectId)}`;
}

function projectIsExpanded(projectId: string): boolean {
  return Boolean(search.value.trim()) || expandedProjectId.value === projectId;
}

/**
 * После обновления раскрытый проект сохраняется, пока в нём остались серверы.
 * При первом наполнении открываем проект терминала или первую группу каталога.
 */
watch(() => store.connections, (connections, previous) => {
  if (!expandedProjectId.value && previous?.length) {
    return;
  }
  if (connections?.some((connection) => connection.projectId === expandedProjectId.value)) {
    return;
  }

  const active = connections?.find((connection) => connection.id === activeSession.value?.connectionId);

  expandedProjectId.value = active?.projectId || connections?.[0]?.projectId || null;
}, { immediate: true, deep: true });

watch(loginConnection, (connection, previous) => {
  if (!connection || (previous && sessionAddress(connection) !== sessionAddress(previous))) {
    resetLogin();
  }
});

watch(chooserConnection, (connection) => {
  if (!connection) {
    chooserConnectionId.value = '';
  }
});

function resetLogin(): void {
  loginConnectionId.value = '';
  loginPassword.value = '';
  loginError.value = '';
}

function closeLogin(): void {
  if (!connectingId.value) {
    resetLogin();
  }
}

function openLogin(connectionId: string): void {
  loginSucceeded.value = false;
  loginConnectionId.value = connectionId;
}

/**
 * Строка сразу ведёт к действию: входу, единственной сессии или явному выбору
 * вкладки одного сервера. Пока диалог открыт, цель текущей оболочки сохраняется.
 */
function selectConnection(connection: SshConnection): void {
  const sessions = connectionSessions(connection.id);
  const [firstSession] = sessions;

  if (!firstSession) {
    openLogin(connection.id);
  } else if (sessions.length === 1) {
    void openChosenSession(firstSession.id);
  } else {
    chooserActivated.value = false;
    chooserConnectionId.value = connection.id;
  }
}

/**
 * Форма сохраняет черновик и при закрытии возвращает ту часть узкой панели,
 * из которой её открыли. Сохранение ведёт к строке созданного сервера.
 */
function toggleCreate(): void {
  if (!showCreate.value) {
    createReturnToConnections.value = showConnections.value;
  }

  showCreate.value = !showCreate.value;
  showConnections.value = !showCreate.value && createReturnToConnections.value;
}

const connectionSessions = (connectionId: string) => (
  sessionsByConnection.value.get(connectionId) || []
);
const connectionSessionCount = (connectionId: string) => connectionSessions(connectionId).length;
const connectionIsActive = (connectionId: string) => (
  activeSession.value?.connectionId === connectionId
);

/**
 * Подпись в строке объясняет следующий шаг. У активного сервера состояние уже
 * выделено отдельно, поэтому для единственной активной сессии достаточно метки.
 */
function connectionActionLabel(connectionId: string): string {
  const count = connectionSessionCount(connectionId);

  if (count > 1) {
    return sessionCountLabel(count);
  }
  if (count === 1) {
    return connectionIsActive(connectionId) ? '' : t('core.open');
  }

  return t('core.connect');
}

/**
 * Русская форма счётчика по правилам 11–14 и младших цифр. Одна формула на все
 * подписи каталога: иначе «2 сесс.» и «1 сервер» начинали говорить по-разному.
 */
function pluralize(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;

  if (mod100 >= 11 && mod100 <= 14) {
    return many;
  }
  if (mod10 === 1) {
    return one;
  }

  return mod10 >= 2 && mod10 <= 4 ? few : many;
}

function serverCountLabel(count: number): string {
  return `${count} ${pluralize(count, t('core.sshServer'), t('core.server'), t('core.sshServerov'))}`;
}

function sessionCountLabel(count: number): string {
  return `${count} ${pluralize(
    count,
    t('core.sshZhivayaSessiya'),
    t('core.sshZhivyeSessii'),
    t('core.sshZhivyhSessiy'),
  )}`;
}

// Заголовок проекта озвучивает имя, серверы и сессии сразу: у свёрнутой группы
// это единственное место, где её состояние ещё видно.
function projectGroupLabel(projectId: string, servers: number, sessions: number): string {
  const live = sessions ? `, ${sessionCountLabel(sessions)}` : '';

  return t('core.sshProektProjectidServercountlabelserversLive', {
                      projectId: projectId,
                      serverCountLabelservers: serverCountLabel(servers),
                      live: live,
                    });
}

const auditDecisionLabel = (decision: string | null | undefined) => ({
  allow: t('core.sshRazresheno'),
  deny: t('core.sshOtkazano'),
}[String(decision)] || decision || t('core.sshNoDecision'));

/**
 * Время записи журнала человеку. Непонятное значение показывается как есть: подменять
 * его «сегодня» нельзя — рядом стоит команда, и время должно быть её.
 */
function formatAuditDate(value: string): string {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(uiLocale.value, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

// Вывод команды агента журнал хранит вместе со счётом байт, а показывает человеку
// сам текст: срез виден отдельной строкой рядом.
function auditOutputText(entry: SshAuditEntry): string {
  return entry.output ? entry.output.text : '';
}

let terminal: Terminal | null = null;
let fit: FitAddon | null = null;
let terminalInput: IDisposable | undefined;
let terminalObserver: ResizeObserver | undefined;
let resizeFrame = 0;
let lastTerminalSize = '';
let disposed = false;

/**
 * Xterm создаётся только перед реальным подключением. Так пустая SSH-панель не
 * показывает чёрный терминал с курсором и не платит за невостребованный renderer.
 */
async function ensureTerminal(): Promise<boolean> {
  if (disposed) {
    return false;
  }
  if (terminal) {
    return true;
  }

  await nextTick();

  if (disposed || !terminalHost.value) {
    return false;
  }
  if (terminal) {
    return true;
  }

  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    disableStdin: store.terminalStatus !== 'ready',
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: {
      background: '#0a0c10',
      foreground: '#e7eaf0',
      cursor: '#5aa2ff',
      selectionBackground: '#2e3742',
      black: '#0a0c10',
      brightBlack: '#39424f',
      red: '#f0564c',
      green: '#3fb950',
      yellow: '#e0a33a',
      blue: '#5aa2ff',
      magenta: '#b47cff',
      cyan: '#37b7c3',
      white: '#e7eaf0',
      brightWhite: '#ffffff',
    },
  });
  fit = new FitAddon();
  terminal.loadAddon?.(fit);
  terminal.open(terminalHost.value);

  const openedTerminal = terminal;

  bindSshTerminal({
    // Сброс ставится в очередь xterm после уже полученных байтов прежней вкладки.
    reset: (done) => openedTerminal.write('\u001bc', done),
    write: (data) => openedTerminal.write(data),
  });
  terminalInput = terminal.onData?.((data: string) => sendSshInput(data));

  if (typeof ResizeObserver !== 'undefined') {
    terminalObserver = new ResizeObserver(scheduleTerminalFit);
    terminalObserver.observe(terminalHost.value);
  }

  return true;
}

/**
 * Видимая геометрия xterm и удалённого PTY меняется одним шагом. Последний
 * размер запоминается, чтобы ResizeObserver не засыпал SSH одинаковыми пакетами.
 */
function fitTerminal(): void {
  if (!props.active || !activeSession.value || !terminal || !fit) {
    return;
  }

  try {
    fit.fit?.();
  } catch {
    return;
  }

  const cols = Number(terminal.cols);
  const rows = Number(terminal.rows);

  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
    return;
  }

  const size = `${cols}:${rows}`;

  if (size === lastTerminalSize) {
    return;
  }

  lastTerminalSize = size;
  resizeSshTerminal(cols, rows);
}

// Кадр анимации вместо прямого вызова: ResizeObserver срабатывает пачкой, а перетяжка
// границы дока даёт их десятками подряд.
function scheduleTerminalFit(): void {
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }

  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    fitTerminal();
  });
}

// Раздел и каталог проектов читаются вместе: форма нового сервера бесполезна без
// списка проектов, а список сессий — без самих серверов.
async function refresh(): Promise<void> {
  await Promise.all([loadSsh(), loadSshProjects()]);
}

/**
 * Выбор сеанса возвращает терминал, в том числе при повторном выборе того же сервера.
 * Каталог скрывается после подготовки xterm, а само соединение остаётся в store.
 */
async function activateSession(sessionId: string): Promise<void> {
  const ready = await ensureTerminal();

  if (!ready || disposed) {
    return;
  }

  activateSshSession(sessionId);
  showConnections.value = false;
}

function sessionTabId(sessionId: string): string {
  return `ssh-session-tab-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function sessionProjectLabel(session: SshSession): string {
  const connection = (store.connections || [])
    .find((item) => item.id === session.connectionId);

  return String(session.projectId || connection?.projectId || t('core.routeNeUkazan'));
}

/**
 * Общая подпись совпадает с серверным подтверждением SSH-команды.
 * Для старых снимков без проекта сохраняется привязка через соединение.
 */
function sessionTargetLabel(session: SshSession): string {
  const tabs = (store.sessions || []).map((item) => ({
    ...item,
    projectId: sessionProjectLabel(item),
  }));

  return sshSessionTabLabel({ ...session, projectId: sessionProjectLabel(session) }, tabs);
}

// Подсказка вкладки называет проект, саму сессию и адрес входа: одной метки мало,
// когда в проекте открыто несколько одинаковых по названию серверов.
function sessionTabTitle(session: SshSession): string {
  const endpoint = [session.host, session.port].filter(Boolean).join(':');
  const identity = [session.user, endpoint].filter(Boolean).join('@');
  const parts = [
    t('core.sshProjectPart', { label: sessionProjectLabel(session) }),
    sessionTargetLabel(session),
    identity,
  ].filter(Boolean);

  return parts.join(' — ');
}

// То же для чтения с экрана: порядок частей общий, но разделитель — запятая, иначе
// длинное тире читается вслух как часть адреса.
function sessionTabAriaLabel(session: SshSession): string {
  const endpoint = [session.host, session.port].filter(Boolean).join(':');
  const identity = [session.user, endpoint].filter(Boolean).join('@');
  const parts = [
    t('core.sshProjectPart', { label: sessionProjectLabel(session) }),
    t('core.sshSessionPart', { label: sessionTargetLabel(session) }),
    identity,
  ].filter(Boolean);

  return parts.join(', ');
}

// Фокус переносится на вкладку по её сессии, а не по позиции: список к этому моменту
// мог уже перестроиться ответом сервера.
async function focusSessionTab(sessionId: string): Promise<void> {
  await nextTick();

  const root = sessionTabs.value;
  const tabsRoot = (root && '$el' in root ? root.$el : root) as HTMLElement | null;
  const tab = [...(tabsRoot?.querySelectorAll?.('[role="tab"]') || [])]
    .find((item) => (item as HTMLElement).dataset.sessionId === sessionId);

  (tab as HTMLElement | undefined)?.focus();
}

function sessionAddress(target: Pick<SshConnection, 'user' | 'host' | 'port'>): string {
  return `${target.user}@${target.host}:${target.port}`;
}

/**
 * Возврат к живой сессии использует её вкладку. При выборе в диалоге фокус
 * переходит в терминал и не возвращается к строке скрытого каталога.
 */
async function openChosenSession(sessionId: string): Promise<void> {
  if (!store.sessions.some((session) => session.id === sessionId)) {
    return;
  }

  chooserActivated.value = true;
  chooserConnectionId.value = '';

  if (store.activeId !== sessionId) {
    await activateSession(sessionId);
  }

  showCreate.value = false;
  showConnections.value = false;

  await nextTick();
  focusTerminalWhenReady();
}

/**
 * Второй вход открывается после закрытия выбора сессии, чтобы общее окно успело
 * вернуть фокус строке каталога и использовало её для закрытия формы пароля.
 */
async function openLoginFromChooser(connectionId: string): Promise<void> {
  chooserConnectionId.value = '';
  await nextTick();
  await nextTick();
  openLogin(connectionId);
}

/**
 * При возврате из каталога и восстановлении канала фокус ждёт готовности xterm.
 * Обычное переключение вкладок сохраняет фокус на переключателе.
 */
function focusTerminalWhenReady(): void {
  if (store.terminalStatus === 'ready') {
    terminal?.focus?.();
  } else if (store.terminalStatus === 'connecting') {
    terminalFocusId = store.activeId;
  }
}

async function restoreTerminal(): Promise<void> {
  if (activeSession.value) {
    await activateSession(activeSession.value.id);
    focusTerminalWhenReady();
  }
}

/**
 * Счётчик подтверждений открывает очередь и на узком экране, пока человек
 * просматривает каталог или заполняет черновик новой связи.
 */
async function showApprovals(): Promise<void> {
  showConnections.value = false;
  showCreate.value = false;
  await nextTick();
  approvalsRegion.value?.focus();
}

/**
 * Закрытие активной вкладки выбирает соседа и сохраняет непрерывный roving focus:
 * иначе фокус улетает в начало страницы, и клавиатурная работа обрывается.
 */
async function closeActiveSession(): Promise<void> {
  const sessionId = store.activeId;

  if (!sessionId || closingSessionId.value) {
    return;
  }

  const sessions = store.sessions || [];
  const index = sessions.findIndex((session) => session.id === sessionId);
  const replacementId = sessions[index + 1]?.id || sessions[index - 1]?.id || '';

  closingSessionId.value = sessionId;

  try {
    await closeSshSession(sessionId);

    if (disposed || (store.activeId && store.activeId !== sessionId)) {
      return;
    }
    if (!replacementId) {
      await nextTick();
      connectionsRegion.value?.focus();

      return;
    }
    if (!(store.sessions || []).some((session) => session.id === replacementId)) {
      return;
    }

    await activateSession(replacementId);
    await focusSessionTab(replacementId);
  } catch (error) {
    if (!disposed && !store.activeId && store.sessions.some((session) => session.id === sessionId)) {
      await activateSession(sessionId);
      await focusSessionTab(sessionId);
    }

    await alertDialog(errorMessage(error, t('core.sshNeUdalosZakrytSsh')), { title: 'SSH' });
  } finally {
    if (closingSessionId.value === sessionId) {
      closingSessionId.value = '';
    }
  }
}

onMounted(async () => {
  await refresh();

  if (disposed) {
    return;
  }

  const sessionId = store.activeId || store.sessions?.[0]?.id;

  if (sessionId) {
    await activateSession(sessionId);
    scheduleTerminalFit();
  }
});

watch(activeSession, async (session, previous) => {
  if (session?.id === previous?.id) {
    return;
  }

  remotePath.value = '.';

  if (session) {
    lostSession.value = null;
    showCreate.value = false;
    showConnections.value = false;
    await ensureTerminal();
    await nextTick();
    scheduleTerminalFit();

    return;
  }

  if (previous && previous.id !== closingSessionId.value) {
    lostSession.value = previous;
  }

  showConnections.value = !lostSession.value;
  lastTerminalSize = '';
});

watch([() => store.terminalStatus, () => store.activeId], ([status, id]) => {
  if (terminal?.options) {
    terminal.options.disableStdin = status !== 'ready';
  }
  if (status === 'ready' && id && terminalFocusId === id
    && props.active && !showConnections.value && !showCreate.value && !loginConnection.value) {
    terminal?.focus?.();
  }
  if (status !== 'connecting' || terminalFocusId !== id) {
    terminalFocusId = '';
  }
}, { flush: 'post' });

watch(() => props.active, async (active) => {
  if (!active) {
    resetLogin();
    chooserConnectionId.value = '';

    return;
  }
  if (!activeSession.value) {
    return;
  }

  await nextTick();
  scheduleTerminalFit();
});

watch([showConnections, showCreate], async ([show, creating]) => {
  if (!show && !creating) {
    await nextTick();
    scheduleTerminalFit();
  }
});

watch(projectOptions, (projects) => {
  if (draft.projectId && !projects.some((project) => project.id === draft.projectId)) {
    draft.projectId = '';
  }
});

onBeforeUnmount(() => {
  disposed = true;

  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
  }

  terminalObserver?.disconnect?.();
  terminalInput?.dispose?.();
  detachSshTerminal();
  bindSshTerminal(null);
  terminal?.dispose?.();
});

/**
 * Вход на сервер. Ключ хоста проверяется до пароля: молчаливое доверие первому
 * ответившему означало бы отдать пароль root тому, кто занял адрес. Диалог держит
 * свою цель до конца попытки, а одноразовый пароль очищается при любом исходе.
 */
async function openConnection(connection: SshConnection): Promise<void> {
  if (connectingId.value) {
    return;
  }

  connectingId.value = connection.id;
  loginError.value = '';

  const isCurrentLogin = () => !disposed && props.active && loginConnection.value?.id === connection.id;

  try {
    const check = await probeSshHostKey(connection.id);

    if (!isCurrentLogin()) {
      return;
    }

    if (check.status !== 'trusted') {
      const changed = check.status === 'changed';
      const accepted = await confirmDialog(
        messageRef('core.sshValueOtpechatokFingerprint', {
          value: changed ? t('core.sshKlyuchServeraIzmenilsya') : t('core.sshPervoePodklyuchenieKServeru'),
          fingerprint: check.current?.fingerprint || t('core.sshFingerprintUnknown'),
        }),
        {
          title: changed ? t('core.sshProveritNovyyHostKey') : t('core.sshDoveryatHostKey'),
          okText: changed ? t('core.sshZamenitKlyuch') : t('core.sshDoveryat'),
          danger: changed,
        },
      );

      if (!accepted || !isCurrentLogin()) {
        return;
      }

      await decideSshHostKey(String(check.challengeId), changed ? 'replace' : 'trust');
    }

    const terminalReady = isCurrentLogin() && await ensureTerminal();

    if (!terminalReady || !isCurrentLogin()) {
      return;
    }

    await connectSshSession(connection.id, loginPassword.value);

    if (!isCurrentLogin()) {
      return;
    }

    loginSucceeded.value = true;
    resetLogin();
    showCreate.value = false;
    showConnections.value = false;

    await nextTick();
    focusTerminalWhenReady();
  } catch (error) {
    if (isCurrentLogin()) {
      loginError.value = errorMessage(error, t('core.sshNeUdalosPodklyuchitsya'));
    }
  } finally {
    loginPassword.value = '';
    connectingId.value = '';
  }
}

/**
 * Сохранение нового сервера. Проект обязателен: без него соединение не принадлежит
 * ничему, и агент не сможет получить к нему доступ ни при каком решении человека.
 */
async function saveConnection(): Promise<void> {
  if (savingConnection.value || !draft.projectId) {
    return;
  }

  savingConnection.value = true;

  try {
    const saved = await saveSshConnection({
      ...draft,
      port: Number(draft.port) || 22,
    });

    expandedProjectId.value = saved?.projectId || draft.projectId;
    showCreate.value = false;
    showConnections.value = true;
    search.value = '';
    Object.assign(draft, {
      projectId: '',
      label: '',
      role: '',
      host: '',
      port: 22,
      user: '',
    });
  } catch (error) {
    await alertDialog(errorMessage(error, t('core.sshNeUdalosSohranitSoedinenie')), { title: 'SSH' });
  } finally {
    savingConnection.value = false;
  }
}

async function uploadFiles(files: File[]): Promise<void> {
  const file = files?.[0];

  if (file) {
    await uploadSshFile(file);
  }
}

function openRemotePath(): void {
  void listSshFiles(remotePath.value);
}

function toggleAgentAccess(sessionId: string, allowed: boolean): void {
  void setSshAgentAccess(sessionId, allowed);
}

function allow(approval: ChatApproval): void {
  chat.answerPerm(approval.pid, true, false, '', '');
}

function deny(approval: ChatApproval): void {
  const comment = String(comments[approval.pid] || '').trim();

  chat.answerPerm(approval.pid, false, false, comment, '');
}
/**
 * Перенос сохраняет серверную сессию, но не её пароль или вывод терминала.
 * Клиентский канал заново присоединяется после загрузки списка сессий.
 */
function exportState() {
  if (connectingId.value || closingSessionId.value || savingConnection.value) {
    throw new Error(toolWindowText('toolSshBusy'));
  }

  return { sessionId: selectedSessionId.value, remotePath: remotePath.value };
}

/**
 * Восстанавливает выбор без повторного подключения к удалённому серверу.
 * Существующая серверная сессия получает только новый клиентский терминал.
 */
async function importState(state: Record<string, unknown>) {
  await refresh();

  if (typeof state.sessionId === 'string'
    && store.sessions.some((session) => session.id === state.sessionId)) {
    await activateSession(state.sessionId);
  }

  if (typeof state.remotePath === 'string') {
    remotePath.value = state.remotePath;
  }
}

defineExpose({ exportState, importState });
</script>

<style scoped>
.ssh-panel {
  box-sizing: border-box;
  container-type: inline-size;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.ssh-panel__surface,
.ssh-panel__body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.ssh-panel__heading,
.ssh-panel__navigation {
  flex: none;
}

.ssh-panel.is-dock .ssh-panel__heading {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.ssh-panel__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ssh-panel__navigation {
  display: none;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}

.ssh-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.ssh-connections {
  display: flex;
  flex-direction: column;
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}

.ssh-connections__header {
  flex: none;
}

.ssh-connections__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 8px 10px 10px;
  overflow: auto;
  overscroll-behavior: contain;
}

.ssh-catalog-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding-inline: 6px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* Поиск не прокручивается вместе со списком: в длинном каталоге его находят
   там же, где он был, а не после прокрутки наверх. */
.ssh-catalog-search {
  display: grid;
  flex: none;
  gap: 6px;
  padding: 10px 10px 0;
}

.ssh-connection-list {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.ssh-connection-group {
  min-width: 0;
}

/* Заголовок проекта липнет к верхней кромке списка: в длинной группе видно,
   какому проекту принадлежат серверы под курсором. */
.ssh-connection-group__heading {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0 -10px;
  padding: 0 10px;
  background: var(--sidebar);
}

.ssh-project-toggle {
  width: 100%;
}

.ssh-project-heading {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.ssh-project-heading__name {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ssh-project-heading strong {
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Метка сессий стоит вплотную к имени проекта: auto-отступ нужен только строке
   сервера, где метка прижимается к правому краю. */
.ssh-project-heading .ssh-session-pill {
  margin-left: 0;
}

.ssh-server-total {
  flex: none;
  color: var(--ink-low);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}

/* Подгруппа получает вертикальную направляющую: строки серверов читаются как дети
   проекта и не превращаются во вторую карточку с собственной рамкой. */
.ssh-connection-group__body {
  display: grid;
  gap: 2px;
  min-width: 0;
  margin: 2px 0 0 9px;
  padding-left: 7px;
  border-left: 1px solid var(--line-2);
}

.ssh-connection-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.ssh-connection-row .ssh-connection {
  flex: 1;
}

.ssh-connection,
.ssh-connection :deep(.ui-button__content),
.ssh-connection :deep(.ui-button__label) {
  min-width: 0;
  width: 100%;
}

.ssh-connection :deep(.ui-button__label) {
  display: grid;
  gap: 1px;
  text-align: left;
}

.ssh-connection__top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ssh-connection__action {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  color: var(--accent);
  font-size: 11px;
}

.ssh-current-label {
  flex: none;
  color: var(--good);
  font-size: 10.5px;
  line-height: 15px;
}

.ssh-connection__label {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-connection__separator {
  flex: none;
  color: var(--ink-low);
  font-size: 11px;
  line-height: 15px;
}

.ssh-connection__role {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 11.5px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-session-pill {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 1px 6px 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--good) 14%, transparent);
  color: var(--good);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 15px;
}

.ssh-session-pill__dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.ssh-connection__address {
  overflow: hidden;
  color: var(--ink-low);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 15px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Пустой каталог объясняет следующий шаг: строка «серверов нет» без действия
   оставляла искать добавление в шапке панели. */
.ssh-catalog-empty {
  display: grid;
  justify-items: start;
  gap: 6px;
  padding: 14px 12px;
  border: 1px dashed var(--line-2);
  border-radius: var(--radius-sm);
}

.ssh-catalog-empty__icon {
  width: 22px;
  height: 22px;
  color: var(--ink-low);
}

.ssh-catalog-empty strong {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.ssh-catalog-empty span {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 17px;
  overflow-wrap: anywhere;
}

.ssh-catalog-empty :deep(.ui-button) {
  margin-top: 2px;
}

.ssh-chooser,
.ssh-login,
.ssh-login__target {
  display: grid;
  min-width: 0;
}

.ssh-login {
  gap: 16px;
}

.ssh-chooser {
  gap: 8px;
}

.ssh-chooser__current {
  margin-left: 8px;
  color: var(--accent);
  font-size: 11px;
}

.ssh-login__target {
  gap: 4px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}

.ssh-login__target strong {
  color: var(--ink);
}

.ssh-login__target code {
  color: var(--ink-mid);
  font: 12px / 18px var(--mono);
}

.ssh-active-session {
  display: flex;
  flex: none;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  min-width: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  box-shadow: inset 3px 0 var(--accent);
}

.ssh-active-session__identity {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.ssh-active-session__status,
.ssh-files-context {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.ssh-files-context {
  margin: 0;
  color: var(--ink-mid);
  overflow-wrap: anywhere;
}

.ssh-approval__server code {
  overflow-wrap: anywhere;
}

.ssh-catalog-target {
  display: none;
}

.ssh-active-session__name {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 6px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 15px;
  overflow-wrap: anywhere;
}

.ssh-active-session__name strong {
  min-width: 0;
  color: var(--ink);
  font-weight: 650;
}

.ssh-active-session code {
  min-width: 0;
  color: var(--ink-mid);
  font: 12px / 18px var(--mono);
  overflow-wrap: anywhere;
}

.ssh-workspace {
  display: flex;
  flex-direction: column;
  grid-column: 2;
  grid-row: 1;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}

.ssh-create {
  flex: none;
  width: 100%;
  max-width: 760px;
}

.ssh-profile-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  min-width: 0;
  padding: 16px;
}

.ssh-profile-form__actions,
.ssh-project-message {
  grid-column: 1 / -1;
}

.ssh-console {
  display: flex;
  flex: 1 0 300px;
  flex-direction: column;
  min-width: 0;
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--ground);
}

.ssh-console__header {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 36px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.ssh-session-switcher {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ssh-tabs {
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

.ssh-session-tab {
  flex: none;
}

.ssh-tab__content,
.ssh-tab__project-line,
.ssh-live-label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ssh-tab__copy {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  text-align: left;
}

.ssh-tab__content {
  padding-inline: 6px;
}

.ssh-tab__project-line > small {
  display: none;
}

.ssh-tab__project-line strong,
.ssh-tab__copy > small {
  max-width: 22ch;
  overflow: hidden;
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-tab__copy > small {
  color: var(--ink-mid);
}

.ssh-live-label {
  flex: none;
  color: var(--good);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.ssh-live-label[data-state='connecting'],
.ssh-live-label[data-state='idle'] {
  color: var(--ink-mid);
}

.ssh-live-label[data-state='detached'],
.ssh-live-label[data-state='lost'] {
  color: var(--warn);
}

.ssh-live-label i,
.ssh-tab__dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.ssh-tab__dot {
  color: var(--ink-low);
}

.ssh-session-tab[aria-selected='true'] .ssh-tab__dot {
  color: var(--accent);
}

.ssh-console__title {
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-terminal-stage {
  display: grid;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.ssh-terminal,
.ssh-console__empty {
  grid-area: 1 / 1;
  min-width: 0;
  min-height: 0;
}

.ssh-terminal {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.ssh-terminal[data-connecting='true'] {
  visibility: hidden;
}

.ssh-terminal :deep(.xterm) {
  box-sizing: border-box;
  height: 100%;
  padding: 9px 10px;
}

.ssh-terminal :deep(.xterm-viewport) {
  background: transparent !important;
}

.ssh-console__empty {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--ink-mid);
  text-align: center;
}

.ssh-console__empty-icon {
  margin-bottom: 4px;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 24px;
}

.ssh-console__empty strong {
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
}

.ssh-console__empty > :last-child {
  max-width: 40ch;
  font-size: 12px;
  line-height: 20px;
}

.ssh-session-tools,
.ssh-agent-access {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.ssh-session-tools {
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-session-tools p {
  margin: 0;
}

.ssh-files-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ssh-files-bar > :first-child {
  flex: 1 1 180px;
  min-width: 0;
}

.ssh-files,
.ssh-audit__list {
  display: grid;
  gap: 8px;
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}

.ssh-files li,
.ssh-audit article header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  overflow-wrap: anywhere;
}

.ssh-files a {
  color: var(--accent);
}

.ssh-sftp__body,
.ssh-audit article {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding-block: 12px;
}

.ssh-sftp > summary svg,
.ssh-audit > summary svg {
  width: 14px;
  height: 14px;
  margin-right: 6px;
  vertical-align: -2px;
  color: var(--ink-mid);
}

.ssh-audit > summary .ssh-count {
  margin-left: 8px;
}

.ssh-files__empty,
.ssh-audit__empty,
.ssh-audit article time,
.ssh-audit__output {
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-approvals {
  display: grid;
  flex: none;
  gap: 12px;
}

.ssh-approvals__heading,
.ssh-approval__server,
.ssh-approval__identity,
.ssh-approval__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.ssh-approvals__heading h3 {
  margin: 0;
  font-size: 13px;
}

.ssh-approvals__heading small {
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-approvals__icon,
.ssh-waiting,
.ssh-count.is-waiting {
  color: var(--warn);
}

.ssh-approval-list {
  display: grid;
  gap: 12px;
  max-height: 360px;
  overflow: auto;
}

.ssh-approval {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
  border-radius: var(--radius-sm);
}

.ssh-approval__identity,
.ssh-count,
.ssh-audit__decision {
  color: var(--ink-mid);
  font-size: 12px;
}

.ssh-badge,
.ssh-audit__decision.deny {
  color: var(--bad);
}

.ssh-audit__decision.allow {
  color: var(--good);
}

.ssh-approval pre,
.ssh-audit pre {
  min-width: 0;
  max-height: 180px;
  margin: 0;
  overflow: auto;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ssh-approval__actions {
  justify-content: flex-end;
}

@container (max-width: 880px) {
  .ssh-panel__navigation {
    display: flex;
  }

  .ssh-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .ssh-connections,
  .ssh-workspace {
    grid-column: 1;
  }

  .ssh-connections {
    border-right: 0;
  }

  .ssh-catalog-target {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin: 0;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    color: var(--ink-mid);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .ssh-catalog-target strong {
    color: var(--ink);
  }

  /* В узкой панели «Серверы» уже названы переключателем с числом: отдельная
     шапка каталога повторяла подпись и отнимала строку у поиска. */
  .ssh-connections__header {
    display: none;
  }

  .ssh-panel:not(.show-connections) .ssh-connections,
  .ssh-panel.show-connections .ssh-workspace {
    display: none;
  }
}

@container (max-width: 560px) {
  .ssh-profile-form {
    grid-template-columns: minmax(0, 1fr);
  }

  /* В узкой панели сводка шапки ломается на две строки и выдавливает действия.
     Числа серверов и сессий остаются в каталоге и на вкладках. */
  .ssh-panel__summary {
    display: none;
  }
}
</style>
