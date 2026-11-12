# Chat working directory

The folder button in the header shows the agent's launch directory. Its tooltip and menu provide the full path and additional repositories.

## Before you start

The directory must exist on the selected server. Git is optional. A project and a task's working copies may provide their own roots.

## What to do

1. In a free conversation, open the folder selector and choose GrigDesk, a project, a recent directory or “Other folder…”.
2. For another folder, enter an absolute path. The filesystem root, your entire home directory, relative paths and `~/` notation are not accepted.
3. Check the main repository and additional roots. Context from the open screen does not itself change the directory.
4. If the executor requires memory migration, choose compaction and move, move without a summary, or cancel. You can type a draft while migration runs; a new turn waits for completion.
5. After the response, check the header folder and transition notice. If the response was lost, use the offered retry of the same operation.

## Result

The next ordinary turn starts in the confirmed directory. The selected task's working copies take precedence; clearing the task restores your saved choice.

Explicitly choosing a project in a free chat also determines the project for supervised database access. An ordinary path, even matching a repository directory, does not grant this access. SSH is available independently of the folder and project: the agent sees all open sessions with Agent commands enabled. Each command needs separate confirmation.

## Limitations and recovery

Claude and Codex continue the conversation when the folder changes; DeepSeek/GLM and Kimi may require new memory. Additional roots and write access depend on the executor and sandbox mode. An invalid explicit path does not silently switch the conversation. An older chat for a deleted registration keeps its previous roots, but that registration cannot be selected again.

## Related articles

[Projects](projects.md) · [Memory](chat-context.md) · [Conversations](chats.md)
