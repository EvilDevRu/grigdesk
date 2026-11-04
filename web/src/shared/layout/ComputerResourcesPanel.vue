<template>
  <div class="computer-resources" tabindex="-1">
    <div v-if="stale" class="stale-note" role="status">
      {{ t('core.noFreshDataTheServerDidNot') }} {{ snapshotTime }}.
    </div>
    <div class="resource-dashboard">
      <section class="resource-section">
        <h3>{{ t('core.resourceComputing') }}</h3>
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
            <span class="resource-device">{{ gpu.name }}</span>
            <span class="pu-bar" aria-hidden="true">
              <span class="pu-fill" :class="loadClass(gpu.percent)"
                    :style="{ width: barWidth(gpu.percent) }"></span>
            </span>
            <span v-if="gpu.memoryUsedGb !== undefined || gpu.memoryTotalGb !== undefined" class="pu-reset">
              {{ t('core.videoMemoryUsage', { used: number(gpu.memoryUsedGb), total: number(gpu.memoryTotalGb) }) }}
            </span>
          </div>
        </div>
      </section>
      <section v-if="mem" class="resource-section">
        <h3>{{ t('core.resourceMemory') }}</h3>
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
        <h3>{{ t('core.resourceDisks') }}</h3>
        <div class="resource-cards resource-disk-grid">
          <div v-for="disk in metrics.disks" :key="disk.id" class="pu-row resource-card">
            <div class="pu-head">
              <span class="pu-name resource-mount">
                {{ disk.mountpoint }}
                <span v-if="disk.dataHome" class="pu-data">{{ t('core.grigDeskDataDisk') }}</span>
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
  padding: 20px;
  overflow: auto;
  overscroll-behavior: contain;
  text-align: left;
}

.resource-dashboard {
  display: grid;
  gap: 24px;
}

.resource-section {
  min-width: 0;
}

.resource-section h3 {
  margin: 0 0 10px;
  color: var(--ink-mid);
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}

.resource-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.resource-cards--single,
.resource-disk-grid {
  grid-template-columns: minmax(0, 1fr);
}

.resource-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-2) 35%, var(--surface));
}

.pu-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  min-height: 40px;
}

.pu-name {
  min-width: 0;
  color: var(--ink);
  font-size: 13px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.pu-values {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.pu-head b {
  color: var(--ink);
  font-size: 24px;
  font-weight: 600;
  line-height: 28px;
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
}

.pu-bar {
  flex: none;
  height: 3px;
  margin-top: auto;
  overflow: hidden;
  border-radius: 2px;
  background: var(--line);
}

.pu-fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.pu-reset > span,
.pu-data {
  display: block;
}

.resource-memory-hint {
  margin: 10px 0 0;
  color: var(--ink-low);
}

.resource-swap-disabled {
  justify-content: center;
}

.resource-disks .pu-head b {
  font-size: 18px;
  line-height: 24px;
  white-space: normal;
  text-align: right;
}

.resource-mount {
  font-family: var(--mono);
}

.pu-data {
  margin-top: 4px;
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
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 8%, var(--surface));
  color: var(--warn);
  font-size: 13px;
  line-height: 20px;
}

@media (max-width: 600px) {
  .computer-resources { padding: 14px 12px; }
  .resource-dashboard { gap: 20px; }
  .resource-card { padding: 12px; }
}

@media (min-width: 900px) {
  .resource-dashboard { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .resource-disks { grid-column: 1 / -1; }
  .resource-disk-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
