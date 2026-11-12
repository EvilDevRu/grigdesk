# Conversation memory and context

The context bar shows the last reliable measurement of the model's working memory. Current-turn output and remaining account quota are separate indicators.

## Before you start

The executor reports usage and window size. A missing recent measurement does not mean zero usage.

## What to do

1. Open the Session context tooltip and check the source and freshness of its reading.
2. Near the working threshold, click the indicator and confirm compaction. Native compact preserves the session; for other executors, a summary starts new memory.
3. After compaction, wait for a new measurement. The old size is not the summary's size.
4. To reset memory completely, Alt-click and confirm. Visible messages remain.
5. When switching executors, remember that the new agent starts with clean memory. Before moving the working directory, choose whether you need a summary.

## Result

Context is freed through the confirmed method. The live turn line separately shows current activity, time and output usage when the executor publishes it.

## Limitations and recovery

The percentage refers to the working threshold, which may be below the advertised context window. Automatic compaction requires executor support. “—”, an unknown window and a previous-turn measurement cannot give an exact current-memory percentage. Summaries can lose details: preserve important decisions in working materials.

## Related articles

[Working directory](chat-workdir.md) · [Conversations](chats.md) · [Usage forecast](usage-forecast.md)
