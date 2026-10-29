<template>
  <section data-provider-cli-inventory>
    <h4>{{ t('settings.cliCopies') }}</h4>
    <p v-if="inventory.environment?.state === 'unavailable'">
      {{ t('settings.cliShellUnknown') }}
    </p>
    <p v-else-if="inventory.conflict" role="status">{{ t('settings.cliCopiesConflict') }}</p>
    <p v-if="!inventory.installations.length">{{ t('settings.cliCopiesMissing') }}</p>
    <dl v-for="copy in inventory.installations" :key="copy.installationId" data-cli-copy>
      <dt>
        <span v-if="copy.installationId === inventory.selectedId">
          {{ t(copy.state === 'missing' || copy.state === 'broken'
            ? 'settings.cliSelectedMissing' : 'settings.cliSelected') }} ·
        </span>
        <span v-if="copy.installationId === inventory.terminalId">{{ t('settings.cliTerminal') }} · </span>
        {{ t(sourceLabels[copy.source]) }}
      </dt>
      <dd><code>{{ copy.path }}</code></dd>
      <dd>{{ copy.version || t('settings.cliVersionUnknown') }} · {{ t(stateLabels[copy.state]) }}</dd>
    </dl>
  </section>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';
import type { ExternalCliInventory } from '../../../../shared/chat/providerInstallationInventory.ts';

defineProps<{ inventory: ExternalCliInventory }>();

const sourceLabels = {
  npm: 'settings.cliSourceNpm',
  native: 'settings.cliSourceNative',
  unknown: 'settings.cliSourceUnknown',
} as const;
const stateLabels = {
  ready: 'settings.cliStateReady',
  broken: 'settings.cliStateBroken',
  missing: 'settings.cliStateMissing',
  unverified: 'settings.cliStateUnverified',
} as const;
</script>
