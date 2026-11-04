<template>
  <HelpWorkspace :article-id="articleId" :fragment="route.hash.slice(1)" @navigate="navigate" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import HelpWorkspace from '../features/help/HelpWorkspace.vue';

const route = useRoute();
const router = useRouter();
const articleId = computed(() =>
  typeof route.params.id === 'string' && route.params.id ? route.params.id : 'overview');

function navigate(id: string, fragment: string): void {
  void router.push({
    name: 'help',
    params: {
      id
    }, hash: fragment ? `#${fragment}` : ''
  });
}
</script>
