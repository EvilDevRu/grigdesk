# Conversation memory and context

The context bar shows the last reliable measurement of model working memory.
Current-turn output and account balance are separate indicators.

## Before you begin

The executor supplies usage and window size. A missing fresh measurement does not mean zero usage.

## What to do

1. Open the session-context tooltip and check the source and freshness.
2. Near the working threshold, click the indicator and confirm compaction.
   Native compact preserves the session; other executors start fresh memory with a summary.
3. Wait for a new measurement. The old size is not the summary's size.
4. To reset memory fully, Alt-click the control and confirm. Visible messages remain.
5. A different executor starts with clean memory. Before changing working folder, choose whether to carry a summary.

## Result

Memory is freed using the confirmed method. The live turn status separately shows activity,
elapsed time and output usage when supplied by the executor.

## Limits and recovery

The percentage uses a working threshold that can be smaller than the advertised context window.
Automatic compaction requires executor support. “—”, an unknown window or a previous turn's measurement
cannot give an exact current percentage. Summaries can lose details; record important decisions in project materials.

## Related articles

[Working folder](chat-workdir.md) · [Conversations](chats.md) · [Usage forecasts](usage-forecast.md)
