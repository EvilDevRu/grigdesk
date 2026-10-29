// Единственная публичная граница UI-kit. Production-consumers импортируют только отсюда.
export { default as UiActionLink } from './components/primitives/UiActionLink.vue';
export { default as UiAudio } from './components/primitives/UiAudio.vue';
export { default as UiButton } from './components/primitives/UiButton.vue';
export { default as UiCheckbox } from './components/primitives/UiCheckbox.vue';
export { default as UiIconButton } from './components/primitives/UiIconButton.vue';
export { default as UiInput } from './components/primitives/UiInput.vue';
export { default as UiNumberInput } from './components/primitives/UiNumberInput.vue';
export { default as UiPressable } from './components/primitives/UiPressable.vue';
export { default as UiRadio } from './components/primitives/UiRadio.vue';
export { default as UiRange } from './components/primitives/UiRange.vue';
export { default as UiSelect } from './components/primitives/UiSelect.vue';
export { default as UiSpinner } from './components/primitives/UiSpinner.vue';
export { default as UiSvgPressable } from './components/primitives/UiSvgPressable.vue';
export { default as UiSwitch } from './components/primitives/UiSwitch.vue';
export { default as UiTextarea } from './components/primitives/UiTextarea.vue';
export { default as UiVideo } from './components/primitives/UiVideo.vue';

export { default as UiChoiceList } from './components/composites/UiChoiceList.vue';
export { default as UiCommandButton } from './components/composites/UiCommandButton.vue';
export { default as UiControlGroup } from './components/composites/UiControlGroup.vue';
export { default as UiDisclosureButton } from './components/composites/UiDisclosureButton.vue';
export { default as UiDiscreteSlider } from './components/composites/UiDiscreteSlider.vue';
export { default as UiField } from './components/composites/UiField.vue';
export { default as UiFilePicker } from './components/composites/UiFilePicker.vue';
export { default as UiFormActions } from './components/composites/UiFormActions.vue';
export { default as UiInlineConfirm } from './components/composites/UiInlineConfirm.vue';
export { default as UiNumberField } from './components/composites/UiNumberField.vue';
export { default as UiPasswordInput } from './components/composites/UiPasswordInput.vue';
export { default as UiPaneHeader } from './components/composites/UiPaneHeader.vue';
export { default as UiRadioGroup } from './components/composites/UiRadioGroup.vue';
export { default as UiSearchInput } from './components/composites/UiSearchInput.vue';
export { default as UiSegmentedControl } from './components/composites/UiSegmentedControl.vue';
export { default as UiSelectableRow } from './components/composites/UiSelectableRow.vue';
export { default as UiSettingControl } from './components/composites/UiSettingControl.vue';
export { default as UiTab } from './components/composites/UiTab.vue';
export { default as UiTabs } from './components/composites/UiTabs.vue';
export { default as UiToggleButton } from './components/composites/UiToggleButton.vue';

export { default as UiInlineMessage } from './components/feedback/UiInlineMessage.vue';
export { default as UiLoadingState } from './components/feedback/UiLoadingState.vue';
export { default as UiProgress } from './components/feedback/UiProgress.vue';

export { default as UiDialog } from './components/overlays/UiDialog.vue';
export { default as UiDialogHost } from './components/overlays/UiDialogHost.vue';
export { default as UiFloatingDialog } from './components/overlays/UiFloatingDialog.vue';
export { default as UiPopover } from './components/overlays/UiPopover.vue';
export { default as UiTopbarPanel } from './components/overlays/UiTopbarPanel.vue';
export { default as UiTooltip } from './components/overlays/UiTooltip.vue';
export { default as UiTooltipHost } from './components/overlays/UiTooltipHost.vue';
export { vTooltip } from './services/tooltipDirective.ts';

export { useUiLayer } from './composables/useUiLayer';
export {
  closeTopLayer, getUiLayerDiagnostics, subscribeUiLayerDiagnostics,
} from './services/layers/stack';
export { setUiDownloadAdapter } from './services/downloads.ts';
export { alertDialog, confirmDialog, promptDialog } from './services/dialogs';
export { hasOpenModal } from './services/layers/modalQueries';
export type * from './types/uiActions';
export type * from './types/uiFields';
export type * from './types/uiLayers';
export type * from './types/uiOverlays';
export type * from './types/uiSelection';

export { default as UiToastHost } from './components/feedback/UiToastHost.vue';
export {
  dismissAllToasts,
  dismissToast,
  dismissToastScope,
  listToasts,
  showToast,
  subscribeToastDismissals,
  subscribeToasts,
} from './services/toasts';
export type * from './types/uiToasts';

export {
  uiLocale, setUiLocale, snapshotText, t, resolveUiText, messageRef, locales,
} from './services/locale.ts';
export type { UiText, MessageRef } from './services/locale.ts';

export { default as UiSkeleton } from './components/feedback/UiSkeleton.vue';
export { default as UiSkeletonLayout } from './components/feedback/UiSkeletonLayout.vue';
