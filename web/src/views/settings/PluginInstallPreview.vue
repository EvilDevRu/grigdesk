<template>
  <section class="install-preview" data-role="install-preview">
    <div class="preview-package">
      <div class="preview-identity">
        <h3>{{ preview.name }}</h3>
        <span class="preview-version">v{{ preview.version }}</span>
      </div>
      <code class="preview-id">{{ preview.id }}</code>
      <p v-if="preview.description">{{ preview.description }}</p>
    </div>
    <p class="preview-replacement">{{ replacesText(preview.replaces, uiLocale) }}</p>
    <dl class="preview-source">
      <dt>{{ t('settings.source') }}</dt>
      <dd>{{ preview.source.kind }} · {{ preview.source.url }}</dd>
      <dt>{{ t('settings.tag') }}</dt>
      <dd>{{ preview.target.tag }}</dd>
      <dt>{{ t('settings.commit') }}</dt>
      <dd class="preview-sha">{{ preview.target.sha }}</dd>
    </dl>
    <UiInlineMessage
      v-for="warning in preview.warnings"
      :key="warning"
      tone="warning"
      data-role="install-warning"
    >
      {{ warning }}
    </UiInlineMessage>
    <div v-if="preview.changes" class="preview-changes">
      <UiDisclosureButton
        v-model:open="changesOpen"
        controls="plugin-install-changes"
        data-role="install-changes-toggle"
      >
        {{ t('settings.changesCommits') }} {{ preview.changes.commits.length }} {{ t('settings.files') }}
        {{ preview.changes.files.length }}
      </UiDisclosureButton>
      <p v-if="preview.changes.sensitive.length" class="preview-sensitive">
        {{ t('settings.serverCodeOrDependenciesAreAffected') }}
      </p>
      <div
        v-if="changesOpen"
        id="plugin-install-changes"
        class="preview-diff"
      >
        <h4>{{ t('settings.commits') }}</h4>
        <ul v-if="preview.changes.commits.length">
          <li
            v-for="commit in preview.changes.commits"
            :key="commit.sha"
            data-role="install-commit"
          >
            <code>{{ shortSha(commit.sha) }}</code>
            {{ commit.subject }}
          </li>
        </ul>
        <p v-else>{{ t('settings.noNewCommits') }}</p>
        <h4>{{ t('settings.files2') }}</h4>
        <ul v-if="preview.changes.files.length">
          <li
            v-for="file in preview.changes.files"
            :key="file.path"
            data-role="install-file"
            :data-sensitive="preview.changes.sensitive.includes(file.path) ? 'true' : 'false'"
          >
            <code>{{ file.status }} · {{ file.path }}</code>
            <small v-if="preview.changes.sensitive.includes(file.path)">
              {{ t('settings.serverCodeOrDependencies') }}
            </small>
          </li>
        </ul>
        <p v-else>{{ t('settings.noChangedFiles') }}</p>
      </div>
      <p v-if="preview.changes.truncated" class="preview-sensitive">{{ t('settings.theListIsTruncated') }}</p>
    </div>
    <UiInlineMessage tone="warning">
      {{ t('settings.pluginCodeRunsInsideGrigDeskWithIts') }}
    </UiInlineMessage>
  </section>
</template>

<script setup lang="ts">
import { t, uiLocale } from '../../ui.ts';

import { ref } from 'vue';

import { UiDisclosureButton, UiInlineMessage } from '../../ui';
import { replacesText, shortSha } from '../../shared/pluginInstall.ts';
import type { PluginInstallPreview } from '../../../../shared/plugins/pluginInstallContracts.ts';

defineProps<{ preview: PluginInstallPreview }>();

const changesOpen = ref(false);
</script>

<style scoped>
.install-preview {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  font-size: var(--workspace-text-size);
  line-height: 1.55;
}
.install-preview p,
.install-preview h3,
.install-preview h4 {
  margin: 0;
}
.preview-package {
  display: grid;
  gap: 0.35rem;
}
.preview-identity {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.preview-identity h3 {
  font-size: 0.9375rem;
}
.preview-version {
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: 0.8125rem;
  font-weight: 600;
}
.preview-id,
.preview-package p,
.preview-source dt,
.preview-sensitive {
  color: var(--ink-mid);
}
.preview-id,
.preview-sha,
.preview-diff code {
  font-family: var(--mono);
  font-size: 0.8125rem;
}
.preview-source {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.5rem 1rem;
  margin: 0;
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-2);
}
.preview-source dd {
  margin: 0;
}
.install-preview {
  overflow-wrap: anywhere;
}
.preview-changes,
.preview-diff {
  display: grid;
  gap: 0.5rem;
  min-width: 0;
}
.preview-sensitive,
.preview-diff small {
  font-size: 0.8125rem;
}
.preview-diff {
  padding: 0.75rem 0;
}
.preview-diff ul {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding-left: 1rem;
}
.preview-diff small {
  display: block;
  color: var(--warn);
}
@media (max-width: 420px) {
  .preview-source {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }
  .preview-source dt:not(:first-child) {
    margin-top: 0.5rem;
  }
}
</style>
