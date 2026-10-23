<template>
  <span class="ptip">
    <span class="pu">
      <span class="pu-row">
        <span class="pu-head">
          <span class="pu-name">{{ t('core.cpu') }}</span>
          <span class="pu-values">
            <span v-if="metrics.cpu.temperature" class="temperature"
                  :class="temperatureClass(metrics.cpu.temperature, 'cpu')">
              {{ t('core.resourceTemperature', { value: number(metrics.cpu.temperature.celsius) }) }}
            </span>
            <b :class="loadClass(metrics.cpu.percent)">{{ formatNumber(metrics.cpu.percent, uiLocale) }}%</b>
          </span>
        </span>
        <span class="pu-bar">
          <span class="pu-fill" :class="loadClass(metrics.cpu.percent)"
                :style="{ width: barWidth(metrics.cpu.percent) }"></span>
        </span>
        <span class="pu-reset">
          {{ t('core.averageLoadOverOneMinute') }} {{ formatNumber(metrics.cpu.load1!, uiLocale) }}
        </span>
      </span>
      <template v-if="mem">
        <span class="pu-row">
          <span class="pu-head">
            <span>{{ t('core.ram') }}</span>
            <b :class="loadClass(mem.ramPercent)">{{ formatNumber(mem.ramPercent, uiLocale) }}%</b>
          </span>
          <span class="pu-bar">
            <span class="pu-fill" :class="loadClass(mem.ramPercent)"
                  :style="{ width: barWidth(mem.ramPercent) }"></span>
          </span>
          <span class="pu-reset">
            {{ t('core.used') }} {{ formatNumber(mem.ramUsed, uiLocale) }}
            {{ t('settings.from') }} {{ formatNumber(mem.ramTotal, uiLocale) }}
            {{ t('core.gbFree') }} {{ formatNumber(mem.ramFree, uiLocale) }} {{ t('core.gb') }}
          </span>
        </span>
        <span v-if="mem.swapTotal" class="pu-row">
          <span class="pu-head">
            <span>{{ t('core.swap') }}</span>
            <b :class="loadClass(mem.swapPercent)">{{ formatNumber(mem.swapPercent, uiLocale) }}%</b>
          </span>
          <span class="pu-bar">
            <span class="pu-fill" :class="loadClass(mem.swapPercent)"
                  :style="{ width: barWidth(mem.swapPercent) }"></span>
          </span>
          <span class="pu-reset">
            {{ t('core.used') }} {{ formatNumber(mem.swapUsed, uiLocale) }}
            {{ t('settings.from') }} {{ formatNumber(mem.swapTotal, uiLocale) }} {{ t('core.gb') }}
          </span>
        </span>
        <span v-else class="pu-reset">{{ t('core.swapDisabled') }}</span>
      </template>
      <span v-for="gpu in metrics.gpus ?? []" :key="gpu.id" class="pu-row">
        <span class="pu-head">
          <span class="pu-name">{{ t('core.gpu') }} · {{ gpu.name }}</span>
          <span class="pu-values">
            <span v-if="gpu.temperature" class="temperature" :class="temperatureClass(gpu.temperature, 'gpu')">
              {{ t('core.resourceTemperature', { value: number(gpu.temperature.celsius) }) }}
            </span>
            <b :class="loadClass(gpu.percent)">
              {{ gpu.percent === undefined ? '—' : formatNumber(gpu.percent, uiLocale) + '%' }}
            </b>
          </span>
        </span>
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
      </span>
      <span v-for="disk in metrics.disks ?? []" :key="disk.id" class="pu-row">
        <span class="pu-head">
          <span class="pu-name">{{ disk.mountpoint }}</span>
          <span class="pu-values">
            <span v-if="disk.temperature" class="temperature" :class="temperatureClass(disk.temperature, 'nvme')">
              {{ t('core.resourceTemperature', { value: number(disk.temperature.celsius) }) }}
            </span>
            <b :class="diskClass(disk.freeGb)">{{ t('core.diskFreeSpace', { free: number(disk.freeGb) }) }}</b>
          </span>
        </span>
        <span class="pu-bar">
          <span class="pu-fill" :class="diskClass(disk.freeGb)"
                :style="{ width: barWidth(disk.percent) }"></span>
        </span>
        <span class="pu-reset">
          {{ t('core.diskUsedSpace', { used: number(disk.usedGb), total: number(disk.totalGb) }) }}
        </span>
        <span v-if="disk.dataHome" class="pu-data">{{ t('core.grigDeskDataDisk') }}</span>
      </span>
    </span>
    <span v-if="metrics.mem" class="sysnote">
      {{ t('core.theHeaderCombinesRAMAndSwapUsed') }} {{ formatNumber(metrics.mem.usedGb!, uiLocale) }}
      {{ t('settings.from') }} {{ formatNumber(metrics.mem.totalGb!, uiLocale) }} {{ t('core.gb') }}
    </span>
    <span v-if="stale" class="sysnote stale-note">
      {{ t('core.noFreshDataTheServerDidNot') }} {{ snapshotTime }}.
    </span>
  </span>
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
.ptip {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  text-align: left;
}

.pu {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.pu-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.pu-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  font-size: 11.5px;
  color: var(--ink-mid);
}

.pu-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.pu-values {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px 8px;
  max-width: 65%;
}

.pu-head b {
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.temperature {
  font-variant-numeric: tabular-nums;
}

.pu-bar {
  height: 3px;
  background: var(--surface-2);
  overflow: hidden;
}

.pu-fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.pu-reset, .pu-data {
  font-size: 10.5px;
  color: var(--ink-mid);
  overflow-wrap: anywhere;
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

.sysnote {
  font-size: 10.5px;
  color: var(--ink-mid);
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.stale-note {
  color: var(--warn);
}
</style>
