// Private home хранит только данные; bare plugins preset принадлежат generation.
// Исходный roster и его validation сохраняются через наследование upstream service.

import AgentPresets from '@deepseek-ai/dsh-agent-presets';

export default class GrigDeskAgentPresets extends AgentPresets {
  /**
   * Roster захватывает harnessBase из своего контекста один раз при создании.
   * Уточняем только этот контекст, сохраняя исходные shipped/user roots и lifecycle.
   */
  constructor(ctx, config) {
    ctx.baseUrl = new URL('./', import.meta.url).href;
    super(ctx, config);
  }
}
