import { defineComponent, h } from 'vue';
import type { Component } from 'vue';

import CodePanelLoading from '../../views/code/codePanelLoading.ts';
import TaskShelfLoading from '../../views/shelf/TaskShelfLoading.vue';
import TerminalLoading from '../../views/terminal/TerminalLoading.vue';
import SshPanelLoading from '../../views/ssh/SshPanelLoading.vue';
import DbPanelLoading from '../../views/db/DbPanelLoading.vue';
import DockerLoading from '../../views/docker/DockerLoading.vue';
import PluginPanelLoading from '../../views/ext/PluginPanelLoading.vue';

const DockerPanelLoading = defineComponent({
  inheritAttrs: false,
  setup: () => () => h(DockerLoading, { area: 'panel' }),
});

const PANELS: Record<string, Component> = {
  code: CodePanelLoading,
  shelf: TaskShelfLoading,
  terminal: TerminalLoading,
  ssh: SshPanelLoading,
  db: DbPanelLoading,
  docker: DockerPanelLoading,
};

/**
 * Выбирает синхронный каркас без загрузки кода готовой панели.
 * Неизвестный внешний инструмент получает только силуэт непрозрачной поверхности.
 */
export function panelLoading(id: string): Component {
  return PANELS[id] ?? PluginPanelLoading;
}
