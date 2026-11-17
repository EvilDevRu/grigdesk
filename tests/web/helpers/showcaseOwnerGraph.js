// View, actions и runtime собраны одним графом: эпоха навигации действительно общая.
export { default as View } from '../../../web/src/views/ShowcaseView.vue';
export { useShowcaseStore } from '../../../web/src/stores/showcase.ts';
export * from '../../../web/src/actions/showcase/prepareShowcaseData.ts';
export { assembleShowcase } from '../../../web/src/actions/showcase/buildShowcase.ts';
