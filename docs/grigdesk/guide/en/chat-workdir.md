# Conversation working folder

The folder button in the header shows where the agent starts.
Its tooltip and menu show the full path and additional repositories.

## Before you begin

The directory must exist on the selected server. Git is optional.
Projects and task working copies can supply their own roots.

## What to do

1. In a conversation without a task, choose a project in the header. Its main repository
   is selected by default. To choose another repository in that project, open the working folder menu.
2. For a standalone folder, choose “No project”. The working folder menu offers GrigDesk,
   recent folders, and “By path” for entering an absolute path.
   Filesystem root, the entire home directory, relative paths and `~/` notation are not accepted.
3. Check the current folder below the list. Additional repositories are marked in the project list.
   Additional paths outside the list appear below the current folder. Screen context alone does not change the folder.
4. If memory migration is required, choose “Compress the conversation and switch”, switch without a summary, or cancel.
   The dialog shows “Compressing context…” while it prepares the summary. You can draft in another window
   during the move. A new turn waits for completion.
5. Check the header and migration notice afterwards. If the response was lost, use the offered retry of that operation.

## Result

The next ordinary turn starts in the confirmed folder. Selected task working copies take priority;
clearing the task restores the saved selection.
Explicit project selection also determines supervised database access. An ordinary path, even one matching
a repository directory, does not grant it. SSH is independent of the folder and project:
the agent sees all open sessions with Agent commands enabled. Every command needs separate confirmation.

## Limits and recovery

Claude and Codex can continue after a folder change; DeepSeek/GLM, Kimi and Qwen may need new memory.
Qwen supports writable additional project repositories and task working copies;
changing that set requires memory migration. Additional roots and write access depend on isolation and executor.
If the original session no longer matches the executor settings, the dialog explains the refusal.
The current folder and memory are preserved. You can cancel or explicitly choose “Switch without a summary”.
An invalid explicit path does not silently switch the conversation.
Old chats for a deleted project registration keep their roots, but that registration cannot be selected again.

## Related articles

[Projects](projects.md) · [Memory](chat-context.md) · [Conversations](chats.md)
