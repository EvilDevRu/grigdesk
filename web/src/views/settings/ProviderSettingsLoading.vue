<template>
  <UiLoadingState :label="t('settings.loadingProviders')">
    <div class="settings-provider">
      <SettingsSection v-if="showQuota" class="settings-provider-general"
        :heading="t('settings.providerUsageAutoRefresh')">
        <ProviderQuotaFieldLoading />
      </SettingsSection>
      <div class="settings-provider-sidebar" data-loading-region="provider-sidebar">
        <UiSkeleton class="settings-provider-picker" height="var(--control-height)" />
        <div class="settings-provider-list">
          <div class="provider-loading-options">
            <UiSkeleton width="88px" />
            <div class="settings-provider-options">
              <div v-for="index in 6" :key="index" class="provider-loading-option">
                <UiSkeleton shape="circle" width="20px" height="20px" />
                <div class="provider-loading-option-copy">
                  <UiSkeleton width="84px" height="10px" />
                  <UiSkeleton width="58px" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-provider-actions">
          <UiSkeleton v-for="width in ['108px', '148px']" :key="width" :width="width"
            height="var(--control-height)" />
        </div>
      </div>
      <div class="settings-provider-editor" data-loading-region="provider-editor">
        <div class="settings-provider-title">
          <UiSkeleton shape="circle" width="22px" height="22px" />
          <UiSkeleton width="110px" height="12px" />
          <UiSkeleton class="provider-loading-status" width="80px" />
        </div>
        <div class="provider-loading-tabs" data-ui-settings-tabs>
          <div v-for="width in ['38px', '42px', '64px', '44px', '28px']" :key="width">
            <UiSkeleton :width="width" />
          </div>
        </div>
        <div class="settings-provider-facts">
          <div v-for="index in 4" :key="index" class="provider-loading-fact">
            <UiSkeleton width="82px" />
            <UiSkeleton width="142px" />
          </div>
        </div>
      </div>
    </div>
  </UiLoadingState>
</template>

<script setup lang="ts">
import { t, UiLoadingState, UiSkeleton } from '../../ui';
import ProviderQuotaFieldLoading from './ProviderQuotaFieldLoading.vue';
import SettingsSection from './SettingsSection.vue';

withDefaults(defineProps<{ showQuota?: boolean }>(), { showQuota: true });
</script>

<style src="./providerLayout.css"></style>

<style scoped>
.settings-provider-picker { height: var(--control-height); }
.provider-loading-options {
  display: grid;
  gap: 13px;
  padding-top: 5px;
}
.provider-loading-option {
  display: flex;
  align-items: center;
  min-height: 61px;
  gap: 9px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.provider-loading-option-copy {
  display: grid;
  gap: 8px;
}
.provider-loading-status { margin-inline-start: auto; }
.provider-loading-tabs > div {
  display: flex;
  align-items: center;
  min-height: var(--control-height);
  padding-inline: 10px;
}
.provider-loading-fact {
  align-items: center;
  min-height: 43px;
}
.provider-loading-fact > * { max-width: 100%; }
</style>
