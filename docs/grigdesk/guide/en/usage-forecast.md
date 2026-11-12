# Usage forecast

The forecast in the executor popover estimates whether the current quota window will last until reset at the observed rate.

## Before you start

Enable the Usage forecast system plugin and collect numeric account-bar measurements. The shared automatic quota refresh switch in executor settings is off by default: new samples then come only from the selected executor's manual ↻. Last snapshots and their original timestamps remain visible. Enable the switch and press Apply for background collection.

## What to do

1. Open the executor popover in the top bar.
2. Compare reset time, current rate and expected usage. Long windows use the average rate; short windows use the current rate.
3. If there is no forecast, collect measurements with ↻ or enable automatic quota refresh. “Usage is flat” means no significant change in the observed interval.
4. In plugin settings, choose executors and background measurement without windows. An empty list means all; the shared automatic-refresh prohibition overrides this setting.
5. To hide only the block, disable its placement; to stop collection, disable the plugin.

## Result

The forecast helps plan work while keeping observed quota separate from estimated future usage.

## Limitations and recovery

On network failure, the last successful data remains with a stale marker. GLM, DeepSeek and Tripo checks run separately from the main server; a hung request ends on timeout. The next measurement starts through permitted automation or the manual button. Codex Reset uses the same protection when supported by its installed core and plugin. Its external statistics are controlled separately from shared quotas. A running chat and a statistics check contact the service independently.

Observations cover available account snapshots only. Insufficient data or an unknown reset time cannot promise enough quota. DeepSeek shows a separate prepaid-account forecast instead of windows. Account use outside this machine also affects the remainder.

## Related articles

[Context](chat-context.md) · [DeepSeek](deepseek.md) · [Plugins](plugins.md)
