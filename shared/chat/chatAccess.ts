export interface ExecutorChatAccess {
  imageInput: boolean;
  webSearch: boolean;
  goalRoundLimit: number;
  projectMcpNames: string[];
}

export interface ChatAccess extends ExecutorChatAccess {
  writablePath: string;
  readOnlyPaths: string[];
  browser: 'unavailable' | 'ready';
  browserTabs: number;
  browserTabTitles: string[];
}
