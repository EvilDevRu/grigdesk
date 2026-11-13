# Conversations with agents

A conversation stores messages and a draft. Its executor runs on the selected server in the specified working folder.

## Before you begin

Configure an executor in settings. Models and effort levels come from the installed CLI or live catalog
and depend on your account and version. If an executor is missing from the model list, use the action
with its name at the bottom, when offered, or open Settings → AI executors.
Its card explains “Not installed”, “Setup required” or “No models” and the next step.
It appears automatically after successful setup and model loading.

Effort depends on the model. Qwen reads each model's levels from its CLI; `none` disables reasoning
and `default` uses the model's default. Context size appears separately from the name;
an unknown size does not mean access was denied.

## What to do

1. Open Chats, select or create a conversation and choose an executor, model and available effort level.
2. Check the working folder and permission mode. Modes differ by executor;
   read-only restricts actions, while automatic mode can allow changes without individual questions.
3. Write a request, attach materials if needed and send. Watch tools and confirmation requests.
4. A message sent during work either steers the current turn or queues for another, depending on the executor.
   The interface shows its status.
5. Stop interrupts work and shows “⏹ Turn stopped.” alongside completed actions.
   After a network interruption, inspect what already happened and the reason before resuming.

For GrigDesk work, agents are instructed to read help and use available built-in tools and commands.
External tasks use `tracker`. Viewing pipelines and changing settings do not require Vite or an application build.
A dev environment is for testing interface changes or your explicit request. If a command is unavailable,
the agent uses the built-in browser within its granted access; missing access remains a separate limitation.

Touch controls retain their full hit areas for model, mode and task selection, including compact landscape headers.
Click an image to view it fullscreen. Pinch to zoom and drag with one finger. Double-tap zooms into a point;
repeat to fit the image. “1:1” shows original size or returns a zoomed image to fit.
The header, arrows and counter stay in place. Arrows select the next image; desktop supports dragging and wheel zoom.
Android gestures require an updated APK.

Claude and Codex can offer a speed for the next turn. Fast and Ultrafast require confirmation from the installed
executor for that model and consume more quota or credits. Codex Fast availability does not imply Ultrafast.
Normal disables acceleration and is first in the list. Older chats without an explicit choice may display
“Use executor settings” while closed, inheriting settings; that item is absent from the open list.
Use Recheck in executor settings if capability data is stale.

Chat cards load in batches of 40 while scrolling. Show more fetches the next batch even when the list fits.
Archive and search load separately; counts cover all server conversations.
New conversations from other windows or devices appear after a server notification without reloading or losing
open messages or list position. Restored archived chats stay active after reload even without new messages.
A new answer can move a card up: a list at the top stays there; lower down, the visible card keeps its position.

Several applications can share a server, each keeping its selected conversation and reading position.
Chat changes arrive in order; slow connections retain the latest update, and deletion cancels pending card updates.
A new answer appears in an open transcript when you are reading its end and have no unsaved changes.
Deleted conversations do not return: the server remembers deletion, so sleeping devices and local recovery
copies silently discard them at the next synchronization.

Concurrent saves reconcile automatically. If messages are saved while settings catch up with another device,
synchronization continues in the background. Sending checks the selected agent parameters;
ordinary renaming or another window's answer does not require closing windows.
Actual write failures show a reason and preserve a local copy.

History initially loads the last 40 messages. Scroll up for older ones while keeping the current line in place.
If new messages arrive, use “Jump to new messages”; you can keep loading older history before jumping.
If refreshing history before sending fails, the reason appears beside the composer and text and attachments stay drafted.

## Result

Answers and actions remain in the transcript. Unsent text is saved as a draft.
Questions prepared from help open a separate conversation and wait for you to send them.

## Limits and recovery

Chats use the executor's active [access profile](access-profiles.md). Switching keeps messages;
a note explains when a new native session is needed. If sign-in is required, restore that profile.
Another account is not selected automatically, and a turn with an unknown outcome is not replayed.
“New session…” notes stay in history before the agent's work, rather than pinned by the composer.
New reasoning, tools and answers appear after them.

GigaCode is temporarily unavailable in chats and pipelines until its integration is checked separately.
In long conversations, the original question may be in unloaded history; receiving the answer does not duplicate it.
Changing executor resets agent memory while preserving the visible transcript.
Account quota, model context and current-turn output are separate measurements.
An agent stops when its session ends; a promise to report later does not create a background job.

A failed history or card batch keeps already displayed content; use Retry.
An expired list cursor automatically reloads the previous depth; Refresh list remains available if the network fails again.
Unread status is shared across devices. Android needs an updated application for these behaviours;
the server cannot replace its embedded interface.

After restart, local recovery messages stay visible during reconciliation and when switching chats.
Large history still loads in batches. If repeated concurrent changes prevent a fresh history load,
loading eventually shows an error and Retry rather than waiting forever. Local edits remain saved.
Reading an older reply never hides a newer reply, even if acknowledgement is delayed.

## Related articles

[Memory](chat-context.md) · [Working folder](chat-workdir.md) · [Settings](settings.md) · [DeepSeek](deepseek.md)
