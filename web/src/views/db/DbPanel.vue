<template>
  <section
    class="db-panel"
    :class="{
      'is-active': props.active,
      'is-compact': props.compact,
      'is-dock': props.presentation === 'dock',
    }"
    :data-pane="activeSession ? mobilePane : 'profiles'"
    aria-labelledby="db-panel-title"
    :aria-busy="refreshLoading || undefined"
  >
    <div class="db-panel__surface">
      <header class="db-panel__header">
        <div class="db-panel__brand">
          <span class="db-panel__mark" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <ellipse cx="12" cy="5" rx="8" ry="3" />
              <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
              <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
            </svg>
          </span>
          <div>
            <div class="db-panel__title">
              <h2 id="db-panel-title">Базы</h2>
              <span
                class="ui-maturity-chip"
                data-product-maturity="beta"
                aria-label="Бета-версия"
              >
                бета
              </span>
            </div>
            <small>Сессии и запросы под контролем человека</small>
          </div>
        </div>

        <div class="db-panel__summary" aria-label="Сводка по базам">
          <span class="db-summary-item" :class="{ active: store.sessions?.length }">
            <i aria-hidden="true"></i>
            {{ store.sessions?.length || 0 }} сесс.
          </span>
          <span class="db-summary-item">
            {{ store.profiles?.length || 0 }} проф.
          </span>
          <span v-if="activeQueryCount" class="db-summary-item is-running">
            {{ activeQueryCount }} выполняется
          </span>
        </div>

        <UiIconButton
          class="db-refresh"
          role="embedded"
          label="Обновить базы"
          v-tooltip="'Обновить'"
          :loading="refreshLoading"
          loading-label="Обновляю"
          @click="refresh"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5 M4 17v-5h5" />
            <path d="M6.1 9a7 7 0 0 1 11.6-2.3L20 9 M4 15l2.3 2.3A7 7 0 0 0 17.9 15" />
          </svg>
        </UiIconButton>
      </header>

      <div class="db-panel__body">
        <UiTabs v-if="activeSession" v-model="mobilePane" class="db-pane-nav" data-ui-workspace-tabs label="Рабочая область базы">
          <UiTab value="query" controls="db-workbench">Запрос</UiTab>
          <UiTab value="result" controls="db-workbench">Результат</UiTab>
          <UiTab value="schema" controls="db-workbench">Схема</UiTab>
          <UiTab value="profiles" controls="db-profiles-pane">Профили</UiTab>
          <UiTab value="activity" controls="db-queries-pane">Запросы · {{ store.queries?.length || 0 }}</UiTab>
        </UiTabs>
        <UiInlineMessage v-if="visibleError" tone="danger">
          {{ visibleError }}
        </UiInlineMessage>

        <div class="db-layout">
          <div class="db-workspace">
            <section
              class="db-live-queries"
              :class="{ 'has-active': activeQueryCount }"
              id="db-queries-pane"
              data-db-queries
              aria-label="Живая лента запросов"
            >
              <header class="db-live-queries__heading">
                <span class="db-live-queries__icon" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M4 18V9 M10 18V5 M16 18v-7 M22 18V3" />
                  </svg>
                </span>
                <div>
                  <h3>Живая лента запросов</h3>
                  <small v-if="store.queries?.length">
                    Человек и агенты в открытых сессиях
                  </small>
                  <small v-else>Активных запросов нет</small>
                </div>
                <span class="db-count" :class="{ 'is-running': activeQueryCount }">
                  {{ store.queries?.length || 0 }}
                </span>
              </header>

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
                        ? 'Показать результат в его сессии'
                        : 'Сессия этого запроса уже закрыта'"
                      @click="inspectQuery(item)"
                    >
                      {{ querySessionOpen(item) ? 'Результат' : 'Сессия закрыта' }}
                    </UiButton>
                    <UiButton
                      v-show="item.state === 'running'"
                      data-db-cancel
                      tone="danger"
                      :disabled="!item.id || item.state !== 'running'"
                      @click="cancelQuery(item.id)"
                    >
                      Прервать
                    </UiButton>
                  </div>
                </article>
              </div>

              <div v-else class="db-query-list__empty" data-db-cancel>
                Новые запросы появятся здесь во время выполнения.
              </div>

              <UiInlineMessage
                v-if="store.cancelNotice"
                class="db-cancel-notice"
                tone="warning"
                data-db-cancel-notice
              >
                {{ store.cancelNotice }}
              </UiInlineMessage>
            </section>

            <section
              id="db-session-panel"
              class="db-console"
              :class="{ 'has-session': activeSession }"
              data-db-sessions
              aria-label="Рабочая сессия базы данных"
            >
              <header class="db-console__header">
                <div v-if="store.sessions?.length" class="db-session-switcher">
                  <span class="db-session-switcher__label">Сессии</span>
                  <UiTabs v-model="selectedSessionId" class="db-tabs" label="Сессии баз данных">
                    <UiTab
                      v-for="session in store.sessions"
                      :id="sessionTabId(session.id)"
                      :key="session.id"
                      class="db-tab"
                      :value="session.id"
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
                  :label="`Закрыть активную сессию ${activeSession.label}`"
                  v-tooltip="`Закрыть ${activeSession.label}`"
                  :loading="closingSessionId === activeSession.id"
                  loading-label="Закрываю сессию"
                  @click="closeActiveSession"
                >
                  ×
                </UiIconButton>

                <div v-else class="db-console__title">
                  <span aria-hidden="true">SQL</span>
                  Консоль
                </div>

                <div v-if="activeSession" class="db-console__context">
                  <span class="db-role-badge">{{ roleLabel(activeSession.role) }}</span>
                  <span v-if="activeSession.prod" class="db-prod-badge">прод</span>
                  <span class="db-live-label">
                    <i aria-hidden="true"></i>
                    Подключено
                  </span>
                </div>
              </header>

              <div
                id="db-workbench"
                class="db-workbench"
                :class="{ 'is-empty': !activeSession }"
                role="tabpanel"
                :aria-labelledby="activeSession ? sessionTabId(activeSession.id) : undefined"
              >
                <aside class="db-schema" data-db-schema aria-label="Схема базы данных">
                  <header class="db-subsection-heading">
                    <div>
                      <h3>Схема</h3>
                      <small v-if="activeSession">{{ activeSession.label }}</small>
                    </div>
                    <UiIconButton
                      role="embedded"
                      label="Обновить схему"
                      v-tooltip="'Обновить схему'"
                      :loading="schemaLoadingIds.has(selectedSessionId)"
                      :disabled="!selectedSessionId"
                      @click="loadSchema"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 7v5h-5 M4 17v-5h5" />
                        <path d="M6.1 9a7 7 0 0 1 11.6-2.3L20 9 M4 15l2.3 2.3A7 7 0 0 0 17.9 15" />
                      </svg>
                    </UiIconButton>
                  </header>

                  <ul v-if="schemaItems.length" class="db-schema__list">
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
                    <strong>{{ activeSession ? 'Схема ещё не загружена' : 'Нет сессии' }}</strong>
                    <small v-if="activeSession">Нажмите кнопку обновления.</small>
                    <small v-else>Откройте профиль базы.</small>
                  </div>
                </aside>

                <section class="db-query-console" data-db-console>
                  <div class="db-query-editor">
                    <header>
                      <div>
                        <h3>Консоль человека</h3>
                        <small>
                          {{ activeSession
                            ? `${engineLabel(activeSession.engine)} · ${roleLabel(activeSession.role)}`
                            : 'Сначала откройте сессию' }}
                        </small>
                      </div>
                      <span class="db-query-shortcut">Ctrl ↵</span>
                    </header>

                    <UiField label="Запрос">
                      <UiTextarea
                        v-model="query"
                        data-role="db-query"
                        rows="7"
                        spellcheck="false"
                        placeholder="SELECT …"
                        :disabled="!activeSession"
                        @keydown.ctrl.enter.prevent="runQuery"
                        @keydown.meta.enter.prevent="runQuery"
                      />
                    </UiField>

                    <div class="db-query-editor__actions">
                      <small>Результат считается недоверенными данными.</small>
                      <UiButton
                        class="db-run-button"
                        variant="solid"
                        tone="accent"
                        :loading="submittingQuery"
                        loading-label="Запускаю запрос"
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
                        </template>
                        Выполнить
                      </UiButton>
                    </div>
                  </div>

                  <div class="db-result-stage" aria-live="polite">
                    <header class="db-result-stage__header">
                      <div>
                        <h3>Результат</h3>
                        <span v-if="limitedResult" class="db-untrusted-badge">
                          Недоверенные данные
                        </span>
                      </div>
                      <span v-if="limitedResult" class="db-result-count">
                        Показано {{ limitedResult.shownRows }}
                        из {{ limitedResult.totalRows ?? '?' }}
                      </span>
                    </header>

                    <div v-if="queryInFlight" class="db-result-state is-running">
                      <span class="db-result-state__pulse" aria-hidden="true"></span>
                      <strong>{{ queryStateLabel(activeResultQuery?.state || '') }}</strong>
                      <small>Лента обновится после ответа базы.</small>
                    </div>

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
                      <strong>Результатов пока нет</strong>
                      <small v-if="activeSession">Введите запрос и запустите его.</small>
                      <small v-else>Откройте сессию из профиля слева.</small>
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
                    <small>{{ activeSession.projectId }} · сессия хранится в GrigDesk</small>
                  </span>
                </div>

                <div class="db-agent-access">
                  <span>
                    <strong>Запросы агента</strong>
                    <small>Изменения всегда требуют подтверждения</small>
                  </span>
                  <UiSwitch
                    :model-value="activeSession.agentAllowed === true"
                    :aria-label="`Доступ агента к ${activeSession.label}`"
                    @update:model-value="setAgentAccess(activeSession.id, $event)"
                  />
                </div>
              </footer>
            </section>

            <details class="db-audit" data-db-audit>
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
                  </svg>
                  Журнал запросов
                </span>
                <span class="db-count">{{ store.audit?.length || 0 }}</span>
              </summary>

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
                    {{ item.rows }} строк · {{ formatBytes(item.bytes) }}
                  </small>
                </article>
              </div>
              <p v-else class="db-audit__empty">Запросов в журнале ещё не было.</p>
            </details>
          </div>

          <aside id="db-profiles-pane" class="db-profiles" data-db-profiles aria-label="Профили баз данных">
            <header class="db-section-heading">
              <div>
                <h3>Профили</h3>
                <small>Пароль только для одного входа</small>
              </div>
              <span class="db-count">{{ store.profiles?.length || 0 }}</span>
            </header>

            <div v-if="store.profiles?.length" class="db-profile-list">
              <article
                v-for="profile in store.profiles"
                :key="profile.id"
                class="db-profile"
                :class="{
                  'is-connected': profileSessionCount(profile.id),
                  'is-current': profileIsCurrent(profile.id),
                  'is-selected': profile.id === selectedProfileId,
                  'is-prod': profile.prod,
                }"
                data-db-profile-card
              >
                <div class="db-profile-choice-wrap">
                  <UiRadio
                    v-model="selectedProfileId"
                    class="db-profile-choice"
                    name="db-profile"
                    :value="profile.id"
                  >
                    <span class="db-profile-choice__content">
                      <span class="db-profile-choice__title">
                        <strong>{{ profile.label }}</strong>
                        <span
                          v-if="profileSessionCount(profile.id)"
                          class="db-live-badge"
                        >
                          <i aria-hidden="true"></i>
                          {{ profileSessionCount(profile.id) }} сесс.
                        </span>
                      </span>
                      <code>{{ profile.host }}:{{ profile.port }}</code>
                      <span class="db-profile-choice__meta">
                        <span>{{ engineLabel(profile.engine) }} · {{ roleLabel(profile.role) }}</span>
                        <span class="db-profile-choice__badges">
                          <span v-if="profile.via === 'ssh'" class="db-via-badge">SSH</span>
                          <span v-if="profile.prod" class="db-prod-badge">прод</span>
                          <span class="db-project-badge">{{ profile.projectId }}</span>
                        </span>
                      </span>
                    </span>
                  </UiRadio>
                </div>

                <form
                  v-if="profile.id === selectedProfileId"
                  class="db-connect-form"
                  @submit.prevent="openSession"
                >
                  <UiField label="Пароль на один вход">
                    <UiPasswordInput
                      v-model="password"
                      autocomplete="current-password"
                      :aria-label="`Пароль для ${profile.label}`"
                      placeholder="Пароль"
                      :disabled="Boolean(openingProfileId && openingProfileId !== profile.id)"
                    />
                  </UiField>

                  <UiField
                    v-if="selectedProfile?.via === 'ssh'"
                    label="SSH-сессия"
                    :hint="sshSessionHint"
                  >
                    <UiSelect v-model="sshSessionId" data-db-ssh-session>
                      <option value="">Выберите SSH-сессию</option>
                      <option
                        v-for="session in availableSshSessions"
                        :key="session.id"
                        :value="session.id"
                      >
                        {{ session.label || session.id }}
                      </option>
                    </UiSelect>
                  </UiField>

                  <UiButton
                    type="submit"
                    block
                    variant="solid"
                    tone="accent"
                    :loading="openingProfileId === profile.id"
                    loading-label="Открываю сессию"
                    :disabled="!password
                      || (selectedProfile?.via === 'ssh' && !sshSessionId)"
                  >
                    Открыть сессию
                  </UiButton>
                </form>
              </article>
            </div>

            <div v-else class="db-profiles__empty" role="status">
              <span aria-hidden="true">＋</span>
              <strong>Профилей пока нет</strong>
              <small>Добавьте подключение к базе ниже.</small>
            </div>

            <details class="db-add-profile" :open="!store.profiles?.length">
              <summary>
                <span class="db-disclosure-icon" aria-hidden="true">＋</span>
                <span>Добавить профиль</span>
              </summary>

              <form class="db-profile-form" @submit.prevent="saveProfile">
                <UiField label="Проект" required>
                  <UiSelect
                    v-model="draft.projectId"
                    required
                    :disabled="!projectOptions.length"
                    aria-label="Проект"
                    data-db-project-select
                  >
                    <option value="" disabled>{{ projectPlaceholder }}</option>
                    <option v-for="project in projectOptions" :key="project.id" :value="project.id">
                      {{ project.id }}
                    </option>
                  </UiSelect>
                </UiField>

                <UiField label="Метка" required>
                  <UiInput
                    v-model.trim="draft.label"
                    required
                    placeholder="Например, аналитика"
                    aria-label="Метка профиля"
                  />
                </UiField>

                <UiField label="Движок" required>
                  <UiSelect v-model="draft.engine" required aria-label="Движок базы">
                    <option value="" disabled>Выберите движок</option>
                    <option v-for="engine in store.engines" :key="engine.id" :value="engine.id">
                      {{ engine.label }}
                    </option>
                  </UiSelect>
                </UiField>

                <UiField label="Роль">
                  <UiSelect v-model="draft.role" aria-label="Роль профиля">
                    <option value="read">Только чтение</option>
                    <option value="write">Чтение и запись</option>
                  </UiSelect>
                </UiField>

                <UiField label="Адрес" required>
                  <UiInput
                    v-model.trim="draft.host"
                    required
                    placeholder="db.internal"
                    aria-label="Адрес базы"
                  />
                </UiField>

                <UiField label="Порт" required>
                  <UiNumberInput
                    v-model="draft.port"
                    :min="1"
                    :max="65535"
                    required
                    placeholder="3306"
                    aria-label="Порт базы"
                  />
                </UiField>

                <UiField label="Пользователь" required>
                  <UiInput
                    v-model.trim="draft.user"
                    required
                    autocomplete="username"
                    placeholder="reader"
                    aria-label="Пользователь базы"
                  />
                </UiField>

                <UiField label="База / номер">
                  <UiInput
                    v-model.trim="draft.database"
                    placeholder="Необязательно"
                    aria-label="Имя или номер базы"
                  />
                </UiField>

                <UiField label="Маршрут">
                  <UiSelect v-model="draft.via" aria-label="Маршрут подключения">
                    <option value="direct">Напрямую</option>
                    <option value="ssh">Через открытую SSH-сессию</option>
                  </UiSelect>
                </UiField>

                <div class="db-profile-form__environment">
                  <UiSwitch v-model="draft.prod">Прод-среда</UiSwitch>
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
                    loading-label="Сохраняю профиль"
                    :disabled="!profileDraftValid"
                  >
                    Сохранить профиль
                  </UiButton>
                </UiFormActions>
              </form>
            </details>

            <p class="db-secret-note">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m5 12 4 4L19 6" />
              </svg>
              Пароль не сохраняется и передаётся только при ручном входе.
            </p>
          </aside>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { errorMessage } from '../../../../shared/lib/errors.ts';

import {
  UiButton,
  UiField,
  UiFormActions,
  UiIconButton,
  UiInlineMessage,
  UiInput,
  UiNumberInput,
  UiPasswordInput,
  UiRadio,
  UiSelect,
  UiSwitch,
  UiTab,
  UiTabs,
  UiTextarea,
  alertDialog,
  vTooltip,
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

const selectedProfileId = ref('');
const selectedSessionId = ref('');
const sshSessionId = ref('');
const password = ref('');
const query = ref('');
const mobilePane = ref('query');
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

const visibleError = computed(() => localError.value || store.error || '');

const refreshLoading = computed(() => store.loading || store.projectsLoading);
const selectedProfile = computed(() => (
  (store.profiles || []).find((profile) => profile.id === selectedProfileId.value) || null
));
const activeSession = computed(() => (
  (store.sessions || []).find((session) => session.id === selectedSessionId.value) || null
));
// Новый профиль базы заводят только на активный проект: архивным уже не работают,
// а профили, заведённые до архива, остаются на месте вместе со своим проектом.
const projectOptions = computed(() => (store.projects || []).filter((project) => !project.archivedAt));
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
    ? 'Туннель пойдёт через уже открытую SSH-сессию.'
    : 'Для этого проекта нет открытых SSH-сессий.'
));
const projectPlaceholder = computed(() => {
  if (store.projectsLoading && !projectOptions.value.length) {
    return 'Загрузка проектов…';
  }

  return projectOptions.value.length ? 'Выберите проект' : 'Проектов пока нет';
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
  currentSchema.value ? JSON.stringify(currentSchema.value, null, 2) : 'Схема ещё не загружена'
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
      : ['значение'];

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
    || 'движок';
}

function roleLabel(role: string): string {
  return role === 'write' ? 'запись' : 'чтение';
}

function queryActorLabel(actor: string | null | undefined): string {
  return actor === 'agent' ? 'агент' : 'человек';
}

function queryStateLabel(state: string): string {
  return ({
    checking: 'проверяется',
    waiting: 'ждёт подтверждения',
    running: 'выполняется',
    done: 'завершён',
    denied: 'отклонён',
    error: 'ошибка',
    cancelled: 'прерван',
  } as Record<string, string>)[state] || 'ожидание';
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
    success: 'успешно',
    query_failed: 'ошибка запроса',
    cancelled: 'прерван',
    session_lost: 'сессия потеряна',
  } as Record<string, string>)[String(outcome)] || 'отклонён';
}

function outcomeTone(outcome: string | null | undefined): string {
  return outcome === 'success' ? 'is-good' : 'is-bad';
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return value || '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
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
    return 'объём неизвестен';
  }
  if (bytes < 1_024) {
    return `${bytes} Б`;
  }

  return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} КиБ`;
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

function profileIsCurrent(profileId: string): boolean {
  return activeSession.value?.profileId === profileId;
}

function querySessionOpen(item: DbQuery | null | undefined): boolean {
  return (store.sessions || []).some((session) => session.id === item?.sessionId);
}

// Строка схемы приходит из чужой базы и формы не обещает: у одного движка это
// объект с именем таблицы, у другого — просто строка.
function schemaItemLabel(row: unknown, index: number): string {
  if (row === null || row === undefined) {
    return `Элемент ${index + 1}`;
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

  return value === undefined ? `Элемент ${index + 1}` : String(value);
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

/** Обновляются обе независимые части панели, а текущий выбор сверяется после ответов. */
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
    }
  } catch (error) {
    localError.value = errorMessage(error, 'Не удалось открыть сессию базы');
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
    localError.value = errorMessage(error, 'Не удалось загрузить схему');
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
    localError.value = errorMessage(error, 'Не удалось запустить запрос');
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
    localError.value = errorMessage(error, 'Не удалось прервать запрос');
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
    await alertDialog(errorMessage(error, 'Не удалось закрыть сессию базы'), { title: 'Базы' });
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
      errorMessage(error, 'Не удалось изменить доступ агента'),
      { title: 'Базы' },
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
  } catch (error) {
    await alertDialog(errorMessage(error, 'Не удалось сохранить профиль'), { title: 'Базы' });
  } finally {
    savingProfile.value = false;
  }
}

watch(selectedProfileId, async () => {
  password.value = '';
  sshSessionId.value = '';

  if (selectedProfile.value?.via === 'ssh') {
    try {
      await loadDbSshSessions();
    } catch (error) {
      localError.value = errorMessage(error, 'Не удалось загрузить SSH-сессии');
    }
  }
});

watch(selectedSessionId, (sessionId, previousId) => {
  if (sessionId && sessionId !== previousId) {
    void loadSchema();
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

onMounted(refresh);
</script>

<style scoped>
.db-panel {
  box-sizing: border-box;
  container-type: inline-size;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--ink);
}

.db-panel__surface {
  box-sizing: border-box;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 9px 12px 12px;
  overflow: hidden;
}

.db-panel__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

.db-panel__header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  min-width: 0;
  min-height: 38px;
}

.db-panel.is-compact.is-dock .db-panel__header {
  padding-right: var(--tool-dock-actions-space, 82px);
}

.db-panel__brand,
.db-panel__title,
.db-panel__summary,
.db-summary-item,
.db-live-queries__heading,
.db-query-row,
.db-query-row__meta,
.db-query-row__actions,
.db-console__header,
.db-console__context,
.db-live-label,
.db-subsection-heading,
.db-query-editor > header,
.db-query-editor__actions,
.db-result-stage__header,
.db-result-stage__header > div,
.db-result-state,
.db-session-endpoint,
.db-agent-access,
.db-section-heading,
.db-profile-choice__title,
.db-profile-choice__meta,
.db-profile-choice__badges,
.db-live-badge,
.db-audit > summary,
.db-audit > summary > span,
.db-audit article header {
  display: flex;
  align-items: center;
}

.db-panel__brand {
  gap: 10px;
  min-width: 0;
}

.db-panel__title {
  gap: 6px;
  min-width: 0;
}

.db-panel__brand h2,
.db-panel h3 {
  margin: 0;
}

.db-panel__brand h2 {
  font-size: 15px;
  line-height: 1.15;
  letter-spacing: 0.015em;
}

.db-panel__brand small,
.db-section-heading small,
.db-subsection-heading small,
.db-query-editor header small,
.db-session-endpoint small,
.db-agent-access small {
  display: block;
  margin-top: 2px;
  color: var(--ink-mid);
  font-size: 11px;
}

.db-panel__mark,
.db-database-icon {
  display: grid;
  flex: none;
  place-items: center;
  color: var(--accent);
}

.db-panel__mark {
  width: 32px;
  height: 32px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
  border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 9%, var(--ground));
}

.db-panel__mark svg {
  width: 17px;
  height: 17px;
}

.db-panel__summary {
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.db-summary-item {
  flex: none;
  gap: 6px;
  min-height: 25px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 62%, transparent);
  color: var(--ink-mid);
  font-size: 11px;
  white-space: nowrap;
}

.db-summary-item i,
.db-live-badge i,
.db-live-label i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--idle);
}

.db-summary-item.active i,
.db-live-badge i,
.db-live-label i {
  background: var(--good);
  box-shadow: 0 0 7px color-mix(in srgb, var(--good) 62%, transparent);
}

.db-summary-item.is-running {
  border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
  background: color-mix(in srgb, var(--warn) 8%, var(--surface));
  color: var(--warn);
}

.db-layout {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(280px, 326px) minmax(0, 1fr);
  gap: 10px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.db-workspace {
  display: flex;
  flex-direction: column;
  grid-column: 2;
  grid-row: 1;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  scrollbar-color: var(--line-2) transparent;
  scrollbar-width: thin;
}

.db-profiles {
  display: flex;
  flex-direction: column;
  grid-column: 1;
  grid-row: 1;
  gap: 9px;
  min-width: 0;
  min-height: 0;
  padding: 0 9px 10px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--sidebar) 88%, var(--ground));
  scrollbar-color: var(--line-2) transparent;
  scrollbar-width: thin;
}

.db-section-heading {
  position: sticky;
  z-index: 2;
  top: 0;
  justify-content: space-between;
  gap: 10px;
  min-height: 48px;
  margin: 0 -1px;
  padding: 8px 1px 7px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--sidebar) 96%, var(--ground));
}

.db-section-heading h3,
.db-live-queries h3,
.db-subsection-heading h3,
.db-query-editor h3,
.db-result-stage h3 {
  font-size: 13px;
}

.db-count {
  display: grid;
  flex: none;
  place-items: center;
  min-width: 23px;
  height: 23px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 10.5px;
}

.db-count.is-running {
  background: color-mix(in srgb, var(--warn) 16%, var(--surface));
  color: var(--warn);
}

.db-live-queries {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 46%, transparent);
}

.db-live-queries.has-active {
  border-color: color-mix(in srgb, var(--warn) 36%, var(--line));
  background: color-mix(in srgb, var(--warn) 5%, var(--surface));
}

.db-live-queries__heading {
  gap: 9px;
  min-width: 0;
}

.db-live-queries__heading > div {
  flex: 1;
  min-width: 0;
}

.db-live-queries__heading small {
  display: block;
  margin-top: 2px;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.db-live-queries__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--ink-mid);
}

.db-live-queries.has-active .db-live-queries__icon {
  background: color-mix(in srgb, var(--warn) 15%, var(--surface));
  color: var(--warn);
}

.db-live-queries__icon svg {
  width: 14px;
  height: 14px;
}

.db-query-list {
  display: grid;
  gap: 6px;
  max-height: 220px;
  min-width: 0;
  overflow: auto;
}

.db-query-row {
  gap: 9px;
  min-width: 0;
  padding: 8px 9px;
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: 8px;
  background: var(--ground);
}

.db-query-row.is-running,
.db-query-row.is-waiting {
  border-left-color: var(--warn);
}

.db-query-row.is-done {
  border-left-color: var(--good);
}

.db-query-row.is-danger {
  border-left-color: var(--bad);
}

.db-query-row.is-muted {
  border-left-color: var(--ink-mid);
}

.db-query-row__main {
  flex: 1;
  min-width: 0;
}

.db-query-row__meta {
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  color: var(--ink-mid);
  font-size: 10px;
}

.db-query-row__meta time {
  flex: none;
}

.db-query-row code,
.db-audit code {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  color: var(--ink);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-query-row__actions {
  flex: none;
  gap: 5px;
}

.db-query-list__empty {
  padding: 0 0 1px 37px;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.db-cancel-notice {
  margin-top: 1px;
}

.db-console {
  display: flex;
  flex: 1 0 470px;
  flex-direction: column;
  min-width: 0;
  min-height: 470px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--ground);
  box-shadow: var(--shadow);
}

.db-console__header {
  flex: none;
  gap: 9px;
  min-width: 0;
  min-height: 44px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.db-session-switcher {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
  width: max-content;
  max-width: min(68%, 760px);
  min-width: 0;
}

.db-session-switcher__label {
  flex: none;
  color: var(--ink-mid);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.db-tabs {
  flex: 0 1 auto;
  gap: 5px;
  width: max-content;
  max-width: 100%;
  min-width: 0;
}

.db-session-close {
  flex: none;
}

.db-tab__content {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 1px 7px;
}

.db-tab__dot {
  display: block;
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--good);
  box-shadow: 0 0 6px color-mix(in srgb, var(--good) 55%, transparent);
}

.db-tab__copy {
  display: grid;
  gap: 1px;
  min-width: 0;
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
  line-height: 1.1;
}

.db-tab__copy small {
  color: var(--ink-mid);
  font-size: 9px;
  line-height: 1.05;
}

.db-console__title {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-mid);
  font-size: 11.5px;
  font-weight: 600;
}

.db-console__title > span {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 11px;
}

.db-console__context {
  flex: none;
  justify-content: flex-end;
  gap: 7px;
  min-width: 0;
  margin-left: auto;
}

.db-live-label {
  gap: 5px;
  color: var(--good);
  font-size: 10.5px;
  white-space: nowrap;
}

.db-role-badge,
.db-prod-badge,
.db-project-badge,
.db-via-badge,
.db-untrusted-badge {
  flex: none;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1;
}

.db-role-badge,
.db-project-badge {
  padding: 4px 7px;
  background: color-mix(in srgb, var(--accent) 11%, var(--surface));
  color: var(--accent);
}

.db-prod-badge {
  padding: 4px 7px;
  background: color-mix(in srgb, var(--bad) 13%, transparent);
  color: var(--bad);
}

.db-via-badge {
  padding: 4px 7px;
  background: color-mix(in srgb, var(--warn) 13%, transparent);
  color: var(--warn);
}

.db-workbench {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(190px, 250px) minmax(0, 1fr);
  min-width: 0;
  min-height: 360px;
  overflow: hidden;
}

.db-schema {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--sidebar) 86%, var(--ground));
}

.db-subsection-heading {
  justify-content: space-between;
  gap: 8px;
  min-height: 43px;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--topbar) 86%, var(--ground));
}

.db-schema__list {
  display: grid;
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
  padding: 6px 7px;
  border-radius: 6px;
  color: var(--ink-mid);
  font-size: 11px;
}

.db-schema__list li:hover {
  background: var(--surface-2);
  color: var(--ink);
}

.db-schema__list svg {
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--accent);
}

.db-schema__list span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-schema__raw,
.db-result__raw {
  min-width: 0;
  margin: 0;
  overflow: auto;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.db-schema__raw {
  flex: 1;
  padding: 9px;
}

.db-schema__empty,
.db-result-state {
  display: grid;
  flex: 1;
  place-content: center;
  justify-items: center;
  gap: 5px;
  min-height: 0;
  padding: 20px;
  color: var(--ink-mid);
  text-align: center;
}

.db-schema__empty > span,
.db-result-state__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-bottom: 2px;
  border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  color: var(--accent);
  font-family: var(--mono);
  font-size: 13px;
}

.db-schema__empty strong,
.db-result-state strong {
  color: var(--ink);
  font-size: 11.5px;
}

.db-schema__empty small,
.db-result-state small {
  font-size: 10.5px;
  line-height: 1.45;
}

.db-query-console {
  display: grid;
  grid-template-rows: auto minmax(180px, 1fr);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.db-query-editor {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface) 35%, transparent);
}

.db-query-editor > header,
.db-result-stage__header {
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.db-query-shortcut {
  flex: none;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 5px;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 9.5px;
}

.db-query-editor__actions {
  justify-content: space-between;
  gap: 10px;
}

.db-query-editor__actions > small {
  color: var(--ink-mid);
  font-size: 10px;
  line-height: 1.4;
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
  background:
    linear-gradient(color-mix(in srgb, var(--line) 18%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--line) 16%, transparent) 1px, transparent 1px),
    var(--ground);
  background-size: 28px 28px, 28px 28px, auto;
}

.db-result-stage__header {
  flex: none;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 38px;
  padding: 6px 9px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--topbar) 90%, transparent);
}

.db-result-stage__header > div {
  flex-wrap: wrap;
  gap: 7px;
  min-width: 0;
}

.db-untrusted-badge {
  padding: 4px 7px;
  background: color-mix(in srgb, var(--warn) 13%, transparent);
  color: var(--warn);
}

.db-result-count {
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}

.db-result-state.is-running {
  display: flex;
  flex-direction: column;
}

.db-result-state__pulse {
  width: 12px;
  height: 12px;
  margin-bottom: 5px;
  border: 2px solid color-mix(in srgb, var(--warn) 28%, transparent);
  border-top-color: var(--warn);
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
  background: color-mix(in srgb, var(--ground) 94%, transparent);
  font-family: var(--mono);
  font-size: 10.5px;
}

.db-result-table th,
.db-result-table td {
  max-width: 420px;
  padding: 7px 9px;
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
  font-weight: 650;
}

.db-result-table tbody tr:hover {
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}

.db-result__raw {
  flex: 1;
  padding: 10px;
}

.db-session-tools {
  display: grid;
  flex: none;
  grid-template-columns: minmax(170px, 1fr) minmax(235px, auto);
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border-top: 1px solid var(--line);
  background: var(--topbar);
}

.db-session-endpoint {
  gap: 8px;
  min-width: 0;
}

.db-database-icon {
  width: 34px;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
}

.db-database-icon.is-small {
  width: 27px;
  height: 27px;
  border-radius: 7px;
}

.db-database-icon svg {
  width: 15px;
  height: 15px;
}

.db-session-endpoint > span:last-child,
.db-agent-access > span {
  min-width: 0;
}

.db-session-endpoint strong,
.db-agent-access strong {
  display: block;
  overflow: hidden;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-agent-access {
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 5px 8px;
  border-right: 1px solid var(--line);
  border-left: 1px solid var(--line);
}

.db-audit,
.db-add-profile {
  flex: none;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 42%, transparent);
}

.db-audit > summary,
.db-add-profile > summary {
  cursor: pointer;
  list-style: none;
}

.db-audit > summary::-webkit-details-marker,
.db-add-profile > summary::-webkit-details-marker {
  display: none;
}

.db-audit > summary {
  justify-content: space-between;
  gap: 9px;
  min-height: 39px;
  padding: 7px 10px;
  font-size: 11.5px;
  font-weight: 600;
}

.db-audit > summary > span {
  gap: 7px;
}

.db-audit > summary svg {
  width: 14px;
  height: 14px;
  color: var(--ink-mid);
}

.db-audit > summary:hover,
.db-add-profile > summary:hover {
  background: color-mix(in srgb, var(--surface-2) 54%, transparent);
}

.db-audit[open] > summary,
.db-add-profile[open] > summary {
  border-bottom: 1px solid var(--line);
}

.db-audit__list {
  display: grid;
  max-height: 330px;
  overflow: auto;
}

.db-audit article {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 9px 10px;
  border-top: 1px solid var(--line);
}

.db-audit article:first-child {
  border-top: 0;
}

.db-audit article header {
  gap: 7px;
  color: var(--ink-mid);
  font-size: 10px;
}

.db-audit article header strong {
  padding: 3px 6px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 10px;
  font-weight: 600;
}

.db-audit article header strong.is-good {
  background: color-mix(in srgb, var(--good) 12%, transparent);
  color: var(--good);
}

.db-audit article header strong.is-bad {
  background: color-mix(in srgb, var(--bad) 12%, transparent);
  color: var(--bad);
}

.db-audit article time {
  margin-left: auto;
}

.db-audit article small {
  color: var(--ink-mid);
  font-size: 10px;
}

.db-audit__empty {
  margin: 0;
  padding: 14px 10px;
  color: var(--ink-mid);
  font-size: 11px;
}

.db-profile-list {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.db-profile {
  display: grid;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--ground);
  transition:
    border-color var(--control-motion-duration) var(--control-motion-easing),
    background var(--control-motion-duration) var(--control-motion-easing);
}

.db-profile:hover {
  border-color: var(--line-2);
}

.db-profile.is-connected {
  border-color: color-mix(in srgb, var(--good) 35%, var(--line));
  background: color-mix(in srgb, var(--good) 3%, var(--ground));
}

.db-profile.is-current {
  border-color: color-mix(in srgb, var(--accent) 58%, var(--line));
  background: color-mix(in srgb, var(--accent) 5%, var(--ground));
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 76%, transparent);
}

.db-profile.is-prod:not(.is-current) {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--bad) 64%, transparent);
}

.db-profile-choice-wrap {
  padding: 10px;
}

.db-profile-choice {
  align-items: flex-start;
  width: 100%;
}

:deep(.db-profile-choice .ui-radio__mark) {
  margin-top: 2px;
}

:deep(.db-profile-choice .ui-radio__label) {
  flex: 1;
  min-width: 0;
}

.db-profile-choice__content {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.db-profile-choice__title {
  gap: 7px;
  min-width: 0;
}

.db-profile-choice__title > strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-live-badge {
  flex: none;
  gap: 5px;
  color: var(--good);
  font-size: 10px;
}

.db-profile-choice__content > code {
  overflow: hidden;
  color: var(--ink-mid);
  font-family: var(--mono);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-profile-choice__meta {
  justify-content: space-between;
  gap: 7px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 10.5px;
}

.db-profile-choice__meta > :first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-profile-choice__badges {
  flex: none;
  gap: 4px;
}

.db-connect-form {
  display: grid;
  gap: 8px;
  padding: 9px 10px 10px;
  border-top: 1px solid var(--line);
}

.db-profiles__empty {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 22px 14px;
  border: 1px dashed var(--line-2);
  border-radius: 10px;
  color: var(--ink-mid);
  text-align: center;
}

.db-profiles__empty > span {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-bottom: 3px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--accent);
  font-size: 18px;
}

.db-profiles__empty strong {
  color: var(--ink);
  font-size: 12.5px;
}

.db-profiles__empty small {
  font-size: 11px;
  line-height: 1.45;
}

.db-add-profile > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 7px 10px;
  color: var(--ink);
  font-size: 11.5px;
  font-weight: 600;
}

.db-disclosure-icon {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--accent);
  font-size: 14px;
  font-weight: 400;
  transition: transform var(--control-motion-duration) var(--control-motion-easing);
}

.db-add-profile[open] .db-disclosure-icon {
  transform: rotate(45deg);
}

.db-profile-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  padding: 11px 10px 10px;
}

.db-profile-form__environment {
  display: flex;
  align-items: center;
  min-height: var(--control-height);
}

.db-profile-form__actions {
  justify-content: stretch;
}

.db-profile-form__actions > :deep(.ui-button) {
  flex: 1;
}

.db-secret-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: auto 2px 0;
  padding-top: 2px;
  color: var(--ink-mid);
  font-size: 10.5px;
  line-height: 1.45;
}

.db-secret-note svg {
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 1px;
  color: var(--good);
}

@keyframes db-spin {
  to {
    transform: rotate(360deg);
  }
}

@container (max-width: 940px) {
  .db-panel__surface {
    grid-template-rows: auto auto;
    align-content: start;
    overflow: auto;
  }

  .db-panel__body {
    min-height: max-content;
  }

  .db-layout {
    display: flex;
    flex: none;
    flex-direction: column;
    min-height: max-content;
    overflow: visible;
  }

  .db-workspace,
  .db-profiles {
    flex: none;
    min-height: 0;
    overflow: visible;
  }

  .db-console {
    flex: none;
    min-height: 620px;
  }

  .db-console:not(.has-session) {
    min-height: 500px;
  }

  .db-profile-form {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .db-profile-form__environment,
  .db-profile-form__actions {
    grid-column: 1 / -1;
  }
}

@container (max-width: 660px) {
  .db-panel__surface {
    gap: 8px;
    padding: 7px 8px 10px;
  }

  .db-panel__header {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 7px;
  }

  .db-panel__brand {
    grid-column: 1;
  }

  .db-panel__summary {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-content: flex-start;
    overflow-x: auto;
  }

  .db-refresh {
    grid-column: 2;
    grid-row: 1;
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

  .db-console__header {
    flex-wrap: wrap;
  }

  .db-session-switcher {
    flex: 1 1 0;
    max-width: calc(100% - 40px);
  }

  .db-session-switcher__label {
    display: none;
  }

  .db-tabs {
    flex: 1 1 auto;
    width: auto;
  }

  .db-console__context {
    width: 100%;
    justify-content: flex-start;
    margin-left: 0;
  }

  .db-console {
    min-height: 760px;
  }

  .db-console:not(.has-session) {
    min-height: 670px;
  }

  .db-workbench {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(150px, 220px) minmax(460px, auto);
    overflow: visible;
  }

  .db-schema {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .db-query-console {
    min-height: 460px;
  }

  .db-session-tools {
    grid-template-columns: minmax(0, 1fr);
  }

  .db-profile-form {
    grid-template-columns: minmax(0, 1fr);
  }
}

@container (max-width: 390px) {
  .db-panel__brand small,
  .db-summary-item:nth-child(2),
  .db-session-endpoint small,
  .db-query-editor__actions > small {
    display: none;
  }

  .db-panel__mark {
    width: 29px;
    height: 29px;
  }

  .db-tab__copy strong,
  .db-tab__copy small {
    max-width: 14ch;
  }

  .db-profile-choice__meta {
    align-items: flex-start;
    flex-direction: column;
  }

  .db-query-editor__actions {
    justify-content: flex-end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .db-profile,
  .db-disclosure-icon {
    transition: none;
  }

  .db-result-state__pulse {
    animation: none;
  }
}
/* Области телефона переключаются без пересоздания сессии и текста запроса.
   На широком экране сохраняются одновременные схема, запрос и результат. */
.db-pane-nav { display: none; flex: none; }
@container (max-width: 940px) {
  .db-pane-nav { display: inline-flex; }
  .db-panel__brand small { display: none; }
  .db-panel[data-pane='profiles'] .db-workspace { display: none; }
  .db-panel:not([data-pane='profiles']) .db-profiles { display: none; }
  .db-panel:not([data-pane='activity']) .db-live-queries { display: none; }
  .db-panel[data-pane='activity'] .db-console { display: none; }
  .db-console, .db-console:not(.has-session) { min-height: 0; }
  .db-workbench { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; }
  .db-panel:not([data-pane='schema']) .db-schema { display: none; }
  .db-panel[data-pane='schema'] .db-query-console { display: none; }
  .db-query-console { min-height: 0; grid-template-rows: auto; }
  .db-panel[data-pane='result'] .db-query-editor { display: none; }
  .db-panel[data-pane='query'] .db-result-stage { display: none; }
  .db-result-stage { min-height: 220px; }
  .db-schema { min-height: 200px; }
}
@media (max-height: 500px) {
  .db-profiles__empty { padding: 8px 10px; }
  .db-profiles__empty svg { display: none; }
  .db-panel__heading p { display: none; }
}
</style>
