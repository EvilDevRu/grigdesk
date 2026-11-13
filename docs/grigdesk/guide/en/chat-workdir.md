# Conversation working folder

The folder button in the header shows where the agent starts.
Its tooltip and menu show the full path and additional repositories.

## Before you begin

The directory must exist on the selected server. Git is optional.
Projects and task working copies can supply their own roots.

## What to do

1. In a free conversation, open the folder menu and choose GrigDesk, a project, a recent directory or “Other folder…”.
2. Enter an absolute path for another folder. Filesystem root, the entire home directory,
   relative paths and `~/` notation are not accepted.
3. Check the primary repository and additional roots. Screen context alone does not change the folder.
4. If memory migration is required, choose compact and move, move without a summary, or cancel.
   You can draft text during migration; a new turn waits for completion.
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
An invalid explicit path does not silently switch the conversation.
Old chats for a deleted project registration keep their roots, but that registration cannot be selected again.

## Related articles

[Projects](projects.md) · [Memory](chat-context.md) · [Conversations](chats.md)
