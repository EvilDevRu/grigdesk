<template>
  <div class="computer-resources" tabindex="-1">
    <div v-if="stale" class="stale-note" role="status">
      {{ t('core.noFreshDataTheServerDidNot') }} {{ snapshotTime }}.
    </div>
    <div class="resource-dashboard">
      <section class="resource-section">
        <h3>
          <span class="resource-section-icon"><ComputerResourceIcon name="cpu" /></span>
          {{ t('core.resourceComputing') }}
        </h3>
        <div class="resource-cards" :class="{ 'resource-cards--single': !metrics.gpus?.length }">
          <div class="pu-row resource-card">
            <div class="pu-head">
              <span class="pu-name">{{ t('core.cpu') }}</span>
              <span class="pu-values">
                <b :class="loadClass(metrics.cpu.percent)">{{ percent(metrics.cpu.percent) }}</b>
                <span v-if="metrics.cpu.temperature" class="temperature"
                      :class="temperatureClass(metrics.cpu.temperature, 'cpu')">
                  {{ t('core.resourceTemperature', { value: number(metrics.cpu.temperature.celsius) }) }}
                </span>
              </span>
            </div>
            <span class="pu-bar" aria-hidden="true">
              <span class="pu-fill" :class="loadClass(metrics.cpu.percent)"
                    :style="{ width: barWidth(metrics.cpu.percent) }"></span>
            </span>
            <span class="pu-reset">
              {{ t('core.resourceLoadAverage', { value: metrics.cpu.load1 === undefined
                ? '—' : formatNumber(metrics.cpu.load1, uiLocale) }) }}
            </span>
          </div>
          <div v-for="gpu in metrics.gpus ?? []" :key="gpu.id" class="pu-row resource-card">
            <div class="pu-head">
              <span class="pu-name">{{ t('core.gpu') }}</span>
              <span class="pu-values">
                <b :class="loadClass(gpu.percent)">{{ percent(gpu.percent) }}</b>
                <span v-if="gpu.temperature" class="temperature"
                      :class="temperatureClass(gpu.temperature, 'gpu')">
                  {{ t('core.resourceTemperature', { value: number(gpu.temperature.celsius) }) }}
                </span>
              </span>
            </div>
            <span class="pu-bar" aria-hidden="true">
              <span class="pu-fill" :class="loadClass(gpu.percent)"
                    :style="{ width: barWidth(gpu.percent) }"></span>
            </span>
            <span class="pu-reset">
              <span class="resource-device">{{ gpu.name }}</span>
              <span v-if="gpu.memoryUsedGb !== undefined || gpu.memoryTotalGb !== undefined">
                {{ t('core.videoMemoryUsage', { used: number(gpu.memoryUsedGb), total: number(gpu.memoryTotalGb) }) }}
              </span>
            </span>
          </div>
        </div>
      </section>
      <section v-if="mem" class="resource-section">
        <h3>
          <span class="resource-section-icon"><ComputerResourceIcon name="memory" /></span>
          {{ t('core.resourceMemory') }}
        </h3>
        <div class="resource-cards resource-memory-grid">
          <div class="pu-row resource-card">
            <div class="pu-head">
              <span class="pu-name">{{ t('core.ram') }}</span>
              <b :class="loadClass(mem.ramPercent)">{{ percent(mem.ramPercent) }}</b>
            </div>
            <span class="pu-bar" aria-hidden="true">
              <span class="pu-fill" :class="loadClass(mem.ramPercent)"
                    :style="{ width: barWidth(mem.ramPercent) }"></span>
            </span>
            <span class="pu-reset">
              <span>{{ t('core.memoryUsage', { used: number(mem.ramUsed), total: number(mem.ramTotal) }) }}</span>
              <span>{{ t('core.memoryFree', { free: number(mem.ramFree) }) }}</span>
            </span>
          </div>
          <div v-if="mem.swapTotal" class="pu-row resource-card">
            <div class="pu-head">
              <span class="pu-name">{{ t('core.swap') }}</span>
              <b :class="loadClass(mem.swapPercent)">{{ percent(mem.swapPercent) }}</b>
            </div>
            <span class="pu-bar" aria-hidden="true">
              <span class="pu-fill" :class="loadClass(mem.swapPercent)"
                    :style="{ width: barWidth(mem.swapPercent) }"></span>
            </span>
            <span class="pu-reset">
              {{ t('core.memoryUsage', { used: number(mem.swapUsed), total: number(mem.swapTotal) }) }}
            </span>
          </div>
          <div v-else class="resource-card resource-swap-disabled">{{ t('core.swapDisabled') }}</div>
        </div>
        <p class="resource-memory-hint">{{ t('core.theHeaderCombinesRAMAndSwapUsed') }}</p>
      </section>
      <section v-if="metrics.disks?.length" class="resource-section resource-disks">
        <h3>
          <span class="resource-section-icon"><ComputerResourceIcon name="disk" /></span>
          {{ t('core.resourceDisks') }}
        </h3>
        <div class="resource-cards resource-disk-grid">
          <div v-for="disk in metrics.disks" :key="disk.id" class="pu-row resource-card"
               :data-tone="diskClass(disk.freeGb)">
            <div class="pu-head">
              <span class="pu-name resource-disk-name">
                <ComputerResourceIcon class="resource-disk-icon" :class="diskClass(disk.freeGb)"
                                      :name="diskClass(disk.freeGb) === 'lv-ok' ? 'disk' : 'warning'" />
                <span class="resource-mount">
                  {{ disk.mountpoint }}
                  <span v-if="disk.dataHome" class="pu-data">{{ t('core.grigDeskDataDisk') }}</span>
                </span>
              </span>
              <span class="pu-values">
                <b :class="diskClass(disk.freeGb)">{{ t('core.diskFreeSpace', { free: number(disk.freeGb) }) }}</b>
                <span v-if="disk.temperature" class="temperature"
                      :class="temperatureClass(disk.temperature, 'nvme')">
                  {{ t('core.resourceTemperature', { value: number(disk.temperature.celsius) }) }}
                </span>
              </span>
            </div>
            <span class="pu-bar" aria-hidden="true">
              <span class="pu-fill" :class="diskClass(disk.freeGb)"
                    :style="{ width: barWidth(disk.percent) }"></span>
            </span>
            <span class="pu-reset">
              {{ t('core.diskUsedSpace', { used: number(disk.usedGb), total: number(disk.totalGb) }) }}
            </span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { SystemMetrics } from '../../../../shared/runtime/systemMetrics.ts';
import { formatNumber } from '../../../../shared/i18n/formats.ts';
import { t, uiLocale } from '../../ui.ts';
import { diskClass, loadClass, memoryView, temperatureClass } from './resourceMetrics.ts';
import ComputerResourceIcon from './ComputerResourceIcon.vue';

const props = defineProps<{
  metrics: SystemMetrics;
  stale: boolean;
  snapshotTime: string;
}>();

const mem = computed(() => memoryView(props.metrics.mem));
const number = (value: number | undefined) => Number.isFinite(value)
  ? formatNumber(value!, uiLocale, { maximumFractionDigits: 1 })
  : '—';
const percent = (value: number | undefined) => Number.isFinite(value) ? `${number(value)}%` : '—';
const barWidth = (value: number | undefined) => `${Math.max(0, Math.min(100, value ?? 0))}%`;
</script>

<style scoped>
.computer-resources {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 24px;
  overflow: auto;
  overscroll-behavior: contain;
  text-align: left;
  container: computer-resources / inline-size;
}

.resource-dashboard {
  display: grid;
  gap: 24px;
}

.resource-section {
  min-width: 0;
}

.resource-section h3 {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 12px;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}

.resource-section-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  color: var(--ink-mid);
}

.resource-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--sidebar);
}

.resource-cards--single {
  grid-template-columns: minmax(0, 1fr);
}

.resource-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 16px;
}

.resource-card:nth-child(even) {
  border-left: 1px solid var(--line);
}

.resource-card:nth-child(n + 3) {
  border-top: 1px solid var(--line);
}

.pu-head {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  min-height: 64px;
}

.pu-name {
  min-width: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.pu-values {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
}

.pu-head b {
  color: var(--ink);
  font-size: 28px;
  font-weight: 650;
  line-height: 34px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.temperature,
.resource-device,
.pu-reset,
.pu-data,
.resource-memory-hint,
.resource-swap-disabled {
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.temperature {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.pu-bar {
  flex: none;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--line);
}

.pu-fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.pu-reset {
  min-height: 36px;
}

.pu-reset > span,
.pu-data {
  display: block;
}

.resource-memory-hint {
  margin: 8px 0 0;
  color: var(--ink-low);
}

.resource-swap-disabled {
  justify-content: center;
}

.resource-disk-grid {
  display: block;
}

.resource-disks .resource-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(140px, 1fr) minmax(150px, auto);
  gap: 5px 24px;
  padding: 12px 16px;
  border: 0;
  border-bottom: 1px solid var(--line);
}

.resource-disks .resource-card:last-child {
  border-bottom: 0;
}

.resource-disks .resource-card[data-tone='lv-warn'] {
  background: color-mix(in srgb, var(--warn) 5%, transparent);
  box-shadow: inset 3px 0 var(--warn);
}

.resource-disks .resource-card[data-tone='lv-bad'] {
  background: color-mix(in srgb, var(--bad) 8%, transparent);
  box-shadow: inset 3px 0 var(--bad);
}

.resource-disks .pu-head {
  display: contents;
}

.resource-disks .pu-name {
  grid-column: 1;
  grid-row: 1 / 3;
  align-self: center;
  color: var(--ink);
  font-size: 13px;
}

.resource-disk-name {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

.resource-disk-icon {
  color: var(--ink-mid);
}

.resource-disk-icon.lv-warn {
  color: var(--warn);
}

.resource-disk-icon.lv-bad {
  color: var(--bad);
}

.resource-disks .pu-values {
  grid-column: 3;
  grid-row: 1 / 3;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
}

.resource-disks .pu-head b {
  font-size: 16px;
  font-weight: 600;
  line-height: 22px;
  white-space: normal;
  text-align: right;
}

.resource-disks .pu-bar {
  grid-column: 2;
  grid-row: 1;
  align-self: end;
}

.resource-disks .pu-reset {
  grid-column: 2;
  grid-row: 2;
  min-height: 0;
}

.resource-disks .pu-fill.lv-ok {
  background: var(--ink-mid);
}

.resource-mount {
  font-family: var(--mono);
}

.pu-data {
  margin-top: 3px;
  font-family: var(--sans);
}

.pu-fill.lv-warn { background: var(--warn); }
.pu-fill.lv-bad { background: var(--bad); }
.pu-head b.lv-warn, .temperature.lv-warn { color: var(--warn); }
.pu-head b.lv-bad, .temperature.lv-bad { color: var(--bad); }

.stale-note {
  margin-bottom: 18px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warn) 8%, var(--surface));
  color: var(--warn);
  font-size: 13px;
  line-height: 20px;
}

@container computer-resources (min-width: 720px) {
  .resource-dashboard { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .resource-disks { grid-column: 1 / -1; }
}

@container computer-resources (max-width: 639px) {
  .resource-disks .resource-card {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 16px;
  }

  .resource-disks .pu-name,
  .resource-disks .pu-values {
    grid-row: 1;
  }

  .resource-disks .pu-values {
    grid-column: 2;
    max-width: 150px;
  }

  .resource-disks .pu-bar,
  .resource-disks .pu-reset {
    grid-column: 1 / -1;
    grid-row: auto;
  }
}

@container computer-resources (max-width: 389px) {
  .resource-section:not(.resource-disks) .pu-name {
    min-height: 36px;
  }

  .resource-card {
    padding: 12px;
  }
}

@container computer-resources (max-width: 329px) {
  .resource-disks .resource-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .resource-disks .pu-values {
    grid-column: 1;
    grid-row: 2;
    align-items: flex-start;
    max-width: none;
  }

  .resource-disks .pu-head b {
    text-align: left;
  }
}

@media (max-width: 600px) {
  .computer-resources {
    padding: 18px max(12px, env(safe-area-inset-right))
      max(18px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
  }
}
</style>
