<template>
  <section class="stand" aria-labelledby="showcase-stand-title">
    <UiDisclosureButton v-model:open="open" controls="showcase-stand-body" density="compact">
      <span id="showcase-stand-title">{{ open ? t('core.showcaseSkrytStendIDannye') : t('core.showcaseStendIDannye') }}</span>
    </UiDisclosureButton>

    <div v-show="open" id="showcase-stand-body" class="stand__body">
      <dl class="stand__facts">
        <div>
          <dt>{{ t('core.showcaseTsel') }}</dt>
          <dd>{{ scope?.targetLabel ?? t('settings.unavailable3') }}</dd>
        </div>
        <div>
          <dt>{{ t('core.showcaseProfil') }}</dt>
          <dd>{{ scope?.profile ?? '—' }}</dd>
        </div>
        <div>
          <dt>{{ t('core.showcaseSreda') }}</dt>
          <dd>{{ environmentText }}</dd>
        </div>
        <div>
          <dt>{{ t('core.showcaseEkranyVKarte') }}</dt>
          <dd>{{ scope ? scope.screens.length : '—' }}</dd>
        </div>
        <div>
          <dt>{{ t('core.showcaseVersiyaDannyh') }}</dt>
          <dd>{{ scope?.dataRevision ?? '—' }}</dd>
        </div>
      </dl>

      <!-- Данные стенда нужны, только если профиль объявил рецепт подготовки. Без
           него остаётся одна отметка «данные обновлены» — она старит записи всех
           сцен, и прятать её нельзя, но и выпячивать незачем. -->
      <div v-if="seed?.available" class="stand__seed">
        <p class="stand__note"> {{ t('core.showcaseProfilObyavilRetseptPodgotovki') }} </p>
        <UiButton variant="outline" :loading="busy" @click="emit('seed', seed.recipeFingerprint)"> {{ t('core.showcasePodgotovitDannye') }} </UiButton>
      </div>
      <p v-else class="stand__note">
        {{ seed?.reason || t('core.showcasePodgotovkaDannyhDlyaEtoy') }}
      </p>

      <div class="stand__updated">
        <span class="stand__note"> {{ t('core.showcaseIzmeniliDannyeStendaSami') }} </span>
        <UiButton variant="ghost" :loading="busy" @click="emit('data-updated')"> {{ t('core.showcaseDannyeObnovleny') }} </UiButton>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { UiButton, UiDisclosureButton, t } from '../../ui';
import type { ShowcaseProject } from '../../../../shared/plugins/showcase/showcaseContracts';
import type { SeedStatus } from '../../actions/showcase';

const props = defineProps<{
  project: ShowcaseProject;
  seed: SeedStatus | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  seed: [recipeFingerprint: string];
  'data-updated': [];
}>();

const open = ref(false);

const scope = computed(() => (
  props.project.target.status === 'ready' ? props.project.target.scope : null
));

const environmentText = computed(() => {
  if (!scope.value) {
    return '—';
  }

  return scope.value.environment === 'isolated-demo'
    ? t('core.showcaseDemoKopiya')
    : t('core.showcaseTolkoChtenie');
});
</script>

<style scoped>
.stand {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.stand__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ground) 52%, transparent);
}

.stand__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px 14px;
  margin: 0;
}

.stand__facts > div {
  min-width: 0;
}

.stand__facts dt {
  color: var(--ink-mid);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.stand__facts dd {
  margin: 2px 0 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.stand__seed {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.stand__note {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12.5px;
  line-height: 1.5;
}

.stand__updated {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
</style>
