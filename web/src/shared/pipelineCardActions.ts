import type { UiActionTone } from '../ui';

export type PipelineCardActionId = 'answer' | 'arbitrate' | 'retry' | 'resume' | 'stop' | 'down' | 'close';

export interface PipelineCardAction {
  id: PipelineCardActionId;
  label: string;
  hint: string;
  className: string;
  role?: string;
  tone: UiActionTone;
  primary: boolean;
  busy: boolean;
  loadingLabel: string;
}
