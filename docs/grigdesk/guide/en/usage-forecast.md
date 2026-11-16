# Usage forecasts

The executor popover estimates whether the current quota window will last until reset at the observed rate.

## Before you begin

Enable the Usage forecast system plugin and collect numeric account measurements.
Automatic quota refresh is off by default in executor settings: new samples then come only from manually
pressing ↻ for an executor. Existing snapshots keep their original timestamps.
Enable the switch and Apply for background collection.

## What to do

1. Open an executor's popover in the top bar.
2. Compare reset time, current rate and projected usage. Long windows use the average rate;
   short windows use the current rate.
3. If no forecast is available, gather measurements with ↻ or enable automatic refresh.
   Flat usage means no substantial observed change over the interval.
4. In plugin settings, select executors and background sampling without open windows.
   An empty selection means all; the global automatic-refresh prohibition takes priority.
5. Disable placement to hide the block alone; disable the plugin to stop collection.

## Result

The forecast helps plan work while keeping measured quota separate from predicted future consumption.

## Limits and recovery

Network failures preserve the last successful data and mark it stale.
GLM, DeepSeek and Tripo checks run separately from the main server and time out if stuck.
The next check requires enabled automatic refresh or a manual request.
Codex Reset uses similar protection when supported by its installed core and plugin;
its external statistics are controlled separately. Chat and statistics requests are independent.
Insufficient samples or an unknown reset time cannot guarantee enough quota.
DeepSeek shows a separate prepaid-balance forecast. Account use on other machines also affects remaining quota.

## Related articles

[Context](chat-context.md) · [DeepSeek](deepseek.md) · [Plugins](plugins.md)
