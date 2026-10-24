<template>
  <div class="computer-resources">
    <section class="resource-section">
      <h3>{{ t('core.resourceComputing') }}</h3>
      <div class="pu-row">
        <span class="pu-head">
          <span class="pu-name">{{ t('core.cpu') }}</span>
          <span class="pu-values">
            <b :class="loadClass(metrics.cpu.percent)">{{ formatNumber(metrics.cpu.percent, uiLocale) }}%</b>
            <span v-if="metrics.cpu.temperature" class="temperature"
                  :class="temperatureClass(metrics.cpu.temperature, 'cpu')">
              {{ t('core.resourceTemperature', { value: number(metrics.cpu.temperature.celsius) }) }}
            </span>
          </span>
        </span>
        <span class="pu-bar">
          <span class="pu-fill" :class="loadClass(metrics.cpu.percent)"
                :style="{ width: barWidth(metrics.cpu.percent) }"></span>
        </span>
        <span class="pu-reset">
          {{ t('core.averageLoadOverOneMinute') }} {{ formatNumber(metrics.cpu.load1!, uiLocale) }}
        </span>
      </div>
      <div v-for="gpu in metrics.gpus ?? []" :key="gpu.id" class="pu-row">
        <div class="pu-head">
          <span class="pu-name">
            {{ t('core.gpu') }}
            <span class="resource-device">{{ gpu.name }}</span>
          </span>
          <span class="pu-values">
            <b :class="loadClass(gpu.percent)">
              {{ gpu.percent === undefined ? '—' : formatNumber(gpu.percent, uiLocale) + '%' }}
            </b>
            <span v-if="gpu.temperature" class="temperature" :class="temperatureClass(gpu.temperature, 'gpu')">
              {{ t('core.resourceTemperature', { value: number(gpu.temperature.celsius) }) }}
            </span>
          </span>
        </div>
        <span class="pu-bar">
          <span class="pu-fill" :class="loadClass(gpu.percent)"
                :style="{ width: barWidth(gpu.percent) }"></span>
        </span>
        <span v-if="gpu.memoryUsedGb !== undefined || gpu.memoryTotalGb !== undefined" class="pu-reset">
          {{ t('core.videoMemoryUsage', {
            used: gpu.memoryUsedGb === undefined ? '—' : number(gpu.memoryUsedGb),
            total: gpu.memoryTotalGb === undefined ? '—' : number(gpu.memoryTotalGb),
          }) }}
        </span>
      </div>
    </section>
    <section v-if="mem" class="resource-section">
      <h3>{{ t('core.resourceMemory') }}</h3>
      <div class="resource-memory-grid">
        <div class="pu-row">
          <span class="pu-head">
            <span class="pu-name">{{ t('core.ram') }}</span>
            <span class="pu-values">
              <b :class="loadClass(mem.ramPercent)">{{ formatNumber(mem.ramPercent, uiLocale) }}%</b>
            </span>
          </span>
          <span class="pu-bar">
            <span class="pu-fill" :class="loadClass(mem.ramPercent)"
                  :style="{ width: barWidth(mem.ramPercent) }"></span>
          </span>
          <span class="pu-reset">
            <span>{{ t('core.memoryUsage', { used: number(mem.ramUsed), total: number(mem.ramTotal) }) }}</span>
            <span>{{ t('core.memoryFree', { free: number(mem.ramFree) }) }}</span>
          </span>
        </div>
        <div v-if="mem.swapTotal" class="pu-row">
          <span class="pu-head">
            <span class="pu-name">{{ t('core.swap') }}</span>
            <span class="pu-values">
              <b :class="loadClass(mem.swapPercent)">{{ formatNumber(mem.swapPercent, uiLocale) }}%</b>
            </span>
          </span>
          <span class="pu-bar">
            <span class="pu-fill" :class="loadClass(mem.swapPercent)"
                  :style="{ width: barWidth(mem.swapPercent) }"></span>
          </span>
          <span class="pu-reset">
            {{ t('core.memoryUsage', { used: number(mem.swapUsed), total: number(mem.swapTotal) }) }}
          </span>
        </div>
        <div v-else class="resource-swap-disabled">{{ t('core.swapDisabled') }}</div>
      </div>
      <div class="resource-memory-total">
        <span>{{ t('core.theHeaderCombinesRAMAndSwapUsed') }}</span>
        <span>
          {{ formatNumber(metrics.mem!.usedGb!, uiLocale) }} /
          {{ formatNumber(metrics.mem!.totalGb!, uiLocale) }} {{ t('core.gb') }}
        </span>
      </div>
    </section>
    <section v-if="metrics.disks?.length" class="resource-section resource-disks">
      <h3>{{ t('core.resourceDisks') }}</h3>
      <div v-for="disk in metrics.disks" :key="disk.id" class="pu-row">
        <span class="pu-head">
          <span class="pu-name resource-mount">
            {{ disk.mountpoint }}
            <span v-if="disk.dataHome" class="pu-data">{{ t('core.grigDeskDataDisk') }}</span>
          </span>
          <span class="pu-values">
            <b :class="diskClass(disk.freeGb)">{{ t('core.diskFreeSpace', { free: number(disk.freeGb) }) }}</b>
            <span v-if="disk.temperature" class="temperature" :class="temperatureClass(disk.temperature, 'nvme')">
              {{ t('core.resourceTemperature', { value: number(disk.temperature.celsius) }) }}
            </span>
          </span>
        </span>
        <span class="pu-bar">
          <span class="pu-fill" :class="diskClass(disk.freeGb)"
                :style="{ width: barWidth(disk.percent) }"></span>
        </span>
        <span class="pu-reset">
          {{ t('core.diskUsedSpace', { used: number(disk.usedGb), total: number(disk.totalGb) }) }}
        </span>
      </div>
    </section>
    <div v-if="stale" class="stale-note" role="status">
      {{ t('core.noFreshDataTheServerDidNot') }} {{ snapshotTime }}.
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
const number = (value: number) => formatNumber(value, uiLocale, { maximumFractionDigits: 1 });
const barWidth = (value: number | undefined) => `${Math.max(0, Math.min(100, value ?? 0))}%`;
</script>

<style scoped>
.computer-resources {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  text-align: left;
}

.resource-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.resource-section + .resource-section {
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.resource-section h3 {
  margin: 0;
  color: var(--ink-mid);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.pu-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.pu-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: start;
  gap: 12px;
  font-size: 12px;
  color: var(--ink);
}

.pu-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.resource-device {
  display: block;
  margin-top: 2px;
  color: var(--ink-mid);
  font-size: 11px;
}

.pu-values {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
  white-space: nowrap;
}

.pu-head b {
  color: var(--ink);
  font-size: 22px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.temperature {
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.pu-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--surface-2);
  overflow: hidden;
}

.pu-fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.pu-reset, .pu-data {
  font-size: 11px;
  color: var(--ink-mid);
  overflow-wrap: anywhere;
}

.pu-reset > span, .pu-data {
  display: block;
}

.resource-memory-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.resource-memory-grid > :last-child {
  padding-left: 16px;
  border-left: 1px solid var(--line);
}

.resource-memory-grid .pu-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.resource-memory-grid .pu-name {
  min-height: 18px;
}

.resource-memory-total {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 2px 12px;
  color: var(--ink-mid);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.resource-swap-disabled {
  color: var(--ink-mid);
  font-size: 11px;
}

.resource-disks .pu-head b {
  font-size: 14px;
  line-height: 1.3;
}

.resource-mount {
  font-family: var(--mono);
}

.pu-data {
  margin-top: 2px;
  font-family: var(--sans);
}

.pu-fill.lv-warn {
  background: var(--warn);
}

.pu-fill.lv-bad {
  background: var(--bad);
}

.pu-head b.lv-warn, .temperature.lv-warn {
  color: var(--warn);
}

.pu-head b.lv-bad, .temperature.lv-bad {
  color: var(--bad);
}

.stale-note {
  padding: 10px 12px;
  border-left: 2px solid var(--warn);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
  color: var(--warn);
  font-size: 11px;
}
</style>
