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

Once a message sent into the current turn is confirmed, the feed shows your clarification
among the agent’s actions. While the turn is running, use “Go to clarification” by the
message field to find your latest clarification if it scrolls out of view. “Go to the end”
returns to the current activity.

Each conversation card shows a circular project avatar on the left and a model badge in the agent provider’s
color on the right. A chat without a project shows a folder icon. In a conversation without a task,
you can use the Project picker in the header.
Pickers and search fields have the same height, including search inside the open project menu.
A ring in the agent provider’s color spins around the icon during a turn or context compaction.
The working folder menu beside it lists the selected project’s repositories. When a project
filter is active on the left, a new chat starts with that project selected.
On phones, both fields are in the Workspace section of the conversation options.

The Task picker in the header shows each task’s number, title, and board logo. When multiple
boards are enabled, the All and board buttons appear below the search field, just like in the
model picker. Search covers all boards. A single board uses a flat list. Choosing a task changes
the conversation’s working folder after confirmation. Choose “no task” to unlink it.

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

If a model temporarily disappears from the Codex catalog, GrigDesk keeps it for the
current profile for five minutes. If it is still missing at the next successful check
after that period, select an available model in the conversation header.

Chat cards load in batches of 40 while scrolling. Show more fetches the next batch even when the list fits.
Archive and search load separately; counts cover all server conversations.
New conversations from other windows or devices appear after a server notification without reloading or losing
open messages or list position. Restored archived chats stay active after reload even without new messages.
Closing a chat moves it to the archive. Its agent process can stay alive between messages to continue
background tasks. The regular pool may release idle processes; running turns and agents
with background tasks stay protected. Qwen Host has no session-slot limit and is not
evicted when the pool fills, including archived chats. All live processes appear in
Settings → Runs → Live agent processes; the running-turn list shows only current work.
An idle Qwen process closes after 30 minutes of confirmed inactivity; background
tasks and future schedules stay protected. History and saved conversation memory
remain available after closing a process.
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

Opening a card loads the last 40 messages. The list highlights the open conversation.
After launching the app or going back to the list on a phone, open a card to see its transcript.
Scroll up or click “Earlier messages” between
the divider lines at the top of the transcript; the current line stays in place.
The button shows a spinner while loading.
If new messages arrive, use “Jump to new messages”; you can keep loading older history before jumping.
If refreshing history before sending fails, the reason appears beside the composer and text and attachments stay drafted.

## Result

Answers and actions remain in the transcript. Unsent text is saved as a draft.
Questions prepared from help open a separate conversation and wait for you to send them.

New answer blocks preserve earlier replies and steering messages in their order.
In a long turn, the hidden-step count stays at the start of the feed. Steering
messages keep their place among visible actions. While the turn history syncs,
messages already shown stay visible even if a later page fails to load.
Receiving the same block again does not add a copy. You do not need to clear
a long conversation's history to process new replies.

A Bash row with the edit icon and the title "→ 2 files: a.ts, journal.md" is a
command that wrote files (`cat > … <<EOF`, `tee`, `sed -i`). Codex on Ultrafast often
writes code this way instead of a separate edit: expand the row to see the full paths
and the command. The code itself is not duplicated in the feed — it is on disk.
A plain command without a write keeps the terminal icon.

## Limits and recovery

If an executor disconnects during a work tool call, the server keeps serving other
conversations. An action already in progress may complete even if its response is
lost: check the result before repeating it.

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
