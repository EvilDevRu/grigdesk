# Agent conversations

A conversation stores messages and a draft; the executor works on the selected server in the specified working directory.

## Before you start

Configure an executor in Settings. Models and effort levels come from the installed CLI or live catalog; the list depends on the available account and version.

## What to do

1. Open Chats and choose a card or create a conversation. Select the executor, model and available effort level.
2. Check the working directory and permission mode. Modes differ between executors; Read only restricts actions, while automatic mode may allow changes without individual questions.
3. Write your request, attach material if needed, and send it. Watch tool activity and approval requests.
4. A message sent during work may steer the current turn or enter a queue, depending on the executor. Its status is visible in the interface.
5. Stop interrupts current work. After a network interruption, first check what was completed and why it stopped, then use the offered continuation.

On touch screens, model, mode and task selectors retain their full tap area, including the compact header in landscape orientation.

Tap an image in the conversation to open it full-screen. Spread two fingers to zoom, then move the image with one finger. Double-tap to enlarge the selected point; double-tap again to fit the whole image. “1:1” shows the original size; when enlarged, it returns to fit. The header, arrows and counter stay in place. Use arrows for the next image. On a computer, drag with the mouse and zoom with the wheel. Android requires an updated APK for these gestures.

Beside Claude and Codex models, you can choose the next turn's speed. Fast and Ultrafast are available only when the installed executor confirms them for the selected model; they increase limit or credit consumption. Codex Fast availability does not imply Ultrafast: if the catalog confirms only Fast, Ultrafast is disabled. The list starts with Normal, which turns acceleration off. In older chats without an explicit choice, the closed field may say “Executor default” and inherit its settings; that item is absent from the open list. If information is stale, press Recheck in executor settings.

Cards load in batches of 40 as you scroll. “Show more” loads the next batch even when the list fits the screen. Archives and search results load separately. Counters cover all conversations on the server. A conversation created in another window or device appears in the active list after a server notification, without search or a reload; open messages and list position remain. Restoring an archived conversation returns it to the active list and keeps it there after reload, even without new messages. A new reply may move a card upward. A list at the top stays there; when reading farther down, the visible card retains its position.

Several applications can use one server simultaneously. Each keeps its selected conversation and reading position. Changes to a chat arrive sequentially: a slow connection does not lose the latest update, and deletion cancels pending card updates. A new reply appears in the open conversation when you are reading its end and have no unsaved changes there.

Deleted conversations do not return by themselves. The server remembers deletion, so a device that was asleep or retained a local recovery copy cannot restore erased messages: its next synchronization silently forgets the conversation and its copy.

Concurrent saves reconcile automatically. If the server has accepted messages while settings are still catching up with other applications, synchronization continues in the background. You can keep phones, tablets and other applications open. Sending checks the selected agent parameters; ordinary renaming or another client's reply does not require closing windows. An actual write failure still shows its cause and keeps a local copy.

History loads after selecting a card, starting with the last 40 messages. Scroll upward for older messages; the line you are reading stays in place. If new messages arrive, press “Go to new messages” to jump to them. Until then, you can continue loading earlier messages without jumping to the new reply. If history cannot refresh before sending, the input shows the cause and preserves text and attachments in the draft for retry.

## Result

Replies and actions remain in the conversation. Unsent text is saved as a draft; a question prepared from help opens in a separate conversation and waits for you to send it.

## Limitations and recovery

A conversation uses the executor's active [access profile](access-profiles.md). Switching profiles preserves messages; a separate notice explains when a new native session is needed. If sign-in is required, restore that profile: another account is not chosen automatically and a turn with an unknown outcome is not replayed.

GigaCode is temporarily unavailable in executor selection and pipelines. Support will return after separate integration verification.

In a long conversation, the original question may be in history not loaded yet. Receiving the completed reply does not append a duplicate question after the reply.

Switching executors resets agent memory while preserving visible messages. Account quota, model context and current-turn usage are different measures. The agent stops when its session ends: “I will report later” does not itself create a background job.

A failure to load the next batch keeps cards or messages already shown; press Retry. A stale list, where the server has forgotten a long-open tab's cursor, automatically reloads to its previous depth; Refresh list remains a backup for repeated network failure. Unread status is shared across devices: reading a reply on one clears the dot on the others. Android needs an updated application for these changes; the server does not replace its embedded interface.

After restart, the application may restore a local recovery copy. Messages already shown remain visible during reconciliation and when switching away and back. Large histories still load in batches when scrolling upward.

If other applications continuously change the conversation and the network cannot retrieve current history, loading shows an error and retry after several attempts instead of waiting forever; local changes remain. Reading an old reply does not hide a new one, even if the save acknowledgement arrives late.

## Related articles

[Memory](chat-context.md) · [Working directory](chat-workdir.md) · [Settings](settings.md) · [DeepSeek](deepseek.md)
