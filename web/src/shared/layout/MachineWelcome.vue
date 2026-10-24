<template>
  <section class="machine-welcome" aria-labelledby="machine-welcome-title">
    <div class="machine-welcome-layout">
      <div class="machine-welcome-main">
        <div class="machine-welcome-art" aria-hidden="true">
          <svg viewBox="0 0 200 124" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <rect class="welcome-monitor" x="22" y="16" width="128" height="80" rx="9" />
            <path d="M23 79h126M73 96v13m26-13v13m-37 0h48" />
            <path class="welcome-link" d="M73 49h20m-6-6 6 6-6 6" />
            <rect class="welcome-device" x="134" y="48" width="42" height="68" rx="8" />
            <path d="M149 55h12m-9 54h6" />
            <path class="welcome-link" d="m145 82 7 7 13-15" />
          </svg>
        </div>
        <p class="machine-welcome-eyebrow">{{ t('core.machineWelcomeEyebrow') }}</p>
        <h1 id="machine-welcome-title">{{ t('core.machineWelcomeTitle') }}</h1>
        <p class="machine-welcome-intro">{{ t('core.machineWelcomeIntro') }}</p>
        <div class="machine-welcome-actions">
          <UiButton v-if="hasMachines" block wrap variant="solid" tone="accent"
                    @click="shell.showConnections = true">
            <template #leading><MachineGlyph name="machine" /></template>
            {{ t('core.machineWelcomeChoose') }}
            <template #trailing><MachineGlyph name="arrow" /></template>
          </UiButton>
          <UiButton block wrap :variant="hasMachines ? 'outline' : 'solid'"
                    :tone="hasMachines ? 'neutral' : 'accent'" @click="adding = true">
            <template #leading><MachineGlyph name="plus" /></template>
            {{ t('core.addMachine') }}
          </UiButton>
        </div>
        <p class="machine-welcome-note"><MachineGlyph name="lock" />{{ t('core.machinePairOnce') }}</p>
      </div>
      <aside class="machine-welcome-guide" :aria-label="t('core.machineWelcomeGuide')">
        <div class="machine-welcome-guide-heading">
          <MachineGlyph name="qr" />
          <h2>{{ t('core.machineWelcomeGuide') }}</h2>
        </div>
        <ol class="machine-welcome-steps">
          <li>
            <span class="machine-welcome-step" aria-hidden="true">1</span>
            <div>
              <h3>{{ t('core.machineWelcomeComputer') }}</h3>
              <p>{{ t('core.machineCodeLocation') }}</p>
            </div>
          </li>
          <li>
            <span class="machine-welcome-step" aria-hidden="true">2</span>
            <div>
              <h3>{{ t('core.machineWelcomeHere') }}</h3>
              <p>{{ t(canScan ? 'core.machineWelcomeScan' : 'core.machineWelcomePaste') }}</p>
            </div>
          </li>
        </ol>
        <p class="machine-welcome-guide-note">{{ t('core.machineWelcomeReady') }}</p>
      </aside>
    </div>
    <AddMachineDialog v-model:open="adding" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { UiButton, t } from '../../ui.ts';
import { useShellStore } from '../../stores/shell.ts';
import AddMachineDialog from './AddMachineDialog.vue';
import MachineGlyph from './MachineGlyph.vue';

const shell = useShellStore();
const adding = ref(false);
const hasMachines = computed(() => shell.profiles.length > 0 || shell.localAvailable);
const canScan = computed(() => shell.capabilities.includes('scan'));
</script>

<style scoped>
.machine-welcome {
  height: 100%;
  min-height: 0;
  overflow: auto;
  container-type: inline-size;
}

.machine-welcome-layout {
  box-sizing: border-box;
  width: min(100%, 960px);
  min-height: 100%;
  margin: 0 auto;
  padding: 32px 24px;
  display: grid;
  align-content: center;
  gap: 32px;
}

.machine-welcome-main {
  min-width: 0;
}

.machine-welcome-art {
  width: 176px;
  margin-bottom: 24px;
  color: var(--line-2);
}

.machine-welcome-art svg {
  display: block;
  width: 100%;
}

.welcome-monitor {
  fill: var(--sidebar);
}

.welcome-device {
  fill: var(--surface);
  stroke: var(--ink-mid);
}

.welcome-link {
  stroke: var(--accent);
}

.machine-welcome-eyebrow {
  margin: 0 0 10px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.machine-welcome h1 {
  margin: 0;
  font-size: 30px;
  line-height: 1.2;
  font-weight: 650;
  letter-spacing: -0.025em;
  overflow-wrap: anywhere;
}

.machine-welcome-intro {
  margin: 16px 0 24px;
  color: var(--ink-mid);
  font-size: 14px;
  line-height: 1.7;
}

.machine-welcome-actions {
  display: grid;
  gap: 10px;
  max-width: 340px;
}

.machine-welcome-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 0;
  color: var(--ink-low);
  font-size: 12px;
  line-height: 1.6;
}

.machine-welcome-note .machine-glyph {
  width: 16px;
  height: 16px;
}

.machine-welcome-guide {
  min-width: 0;
  padding: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--sidebar);
}

.machine-welcome-guide-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
  color: var(--ink-mid);
}

.machine-welcome h2 {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.machine-welcome-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 24px;
}

.machine-welcome-steps li {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 12px;
}

.machine-welcome-step {
  display: grid;
  place-items: center;
  align-self: start;
  min-height: 24px;
  border-radius: var(--radius-round);
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.machine-welcome h3 {
  margin: 2px 0 6px;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.machine-welcome-steps p,
.machine-welcome-guide-note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 13px;
  line-height: 1.7;
}

.machine-welcome-guide-note {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
  font-size: 12px;
}

/* На телефоне экран сам задаёт внешние отступы, а инструкция получает всю ширину.
   Компактные интервалы сохраняют текст и действия в пределах обычного высокого окна. */
@container (max-width: 699px) {
  .machine-welcome-layout {
    padding: 20px 16px;
    gap: 20px;
  }

  .machine-welcome-art {
    width: 96px;
    margin-bottom: 12px;
  }

  .machine-welcome h1 {
    font-size: 28px;
  }

  .machine-welcome-intro {
    margin: 12px 0 20px;
    line-height: 1.55;
  }

  .machine-welcome-actions {
    max-width: none;
  }

  .machine-welcome-note {
    margin-top: 12px;
  }

  .machine-welcome-guide {
    padding: 16px;
  }

  .machine-welcome-guide-heading {
    margin-bottom: 16px;
  }

  .machine-welcome-steps {
    gap: 16px;
  }

  .machine-welcome-steps li {
    gap: 10px;
  }

  .machine-welcome-steps p,
  .machine-welcome-guide-note {
    line-height: 1.55;
  }

  .machine-welcome-guide-note {
    margin-top: 16px;
    padding-top: 12px;
  }
}

@media (max-height: 740px) {
  .machine-welcome-art {
    display: none;
  }
}

@container (min-width: 700px) {
  .machine-welcome-layout {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: center;
    gap: 48px;
    padding: 48px 32px;
  }

  .machine-welcome-art {
    width: 200px;
    margin-bottom: 32px;
  }

  .machine-welcome h1 {
    font-size: 36px;
  }
}
</style>
