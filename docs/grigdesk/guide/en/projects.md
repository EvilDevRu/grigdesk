# Projects and repositories

A project combines a name, working copies and factory connections. Registering a project neither moves nor creates your source files.

To test another branch on a single environment, open its main copy in Code. The branch button offers selection, stop/build/start commands and return to `dev`. Commands are explicitly configured for the selected repository. See [the workflow](code.md).

## Before you start

Prepare existing directories on the server machine. A person supplies the paths; they determine which code project operations can access.

## What to do

1. Open Projects, create a registration, and set a permanent identifier and name.
2. Add repositories with short labels and absolute paths. Choose the default repository and check path availability.
3. Save the project profile. If it differs from the factory profile, read both sides and explicitly choose the required paths.
4. “Chat with project” creates a draft with the selected working directory. Configure the profile and routes separately for tasks and pipelines.
5. To prevent new work, archive the project. Review blocking references and disable them in their owning sections.
6. To return, open the archive and restore the project. “Delete registration” is available from the archive after checking references and confirming.

Search above the catalog uses the same compact appearance as Chats. It searches names, identifiers, labels and paths; the adjacent button changes sorting.

The connection skill is bundled with the application. After updating and starting the new server, type `$` in Codex and choose `$grigdesk-connect-project`; in GLM or DeepSeek, type `/` and choose `/grigdesk-connect-project`. If the menu is still old, refresh the page to reload the executor catalog. The skill connects a project to the pipeline: the agent reads code, proposes interview answers and shows the future files; applying them needs one confirmation for the package. For an existing profile it first shows a diff. You do not need to send tokens; registering a project alone does not install the skill.

## Result

The project profile is saved, and available repositories appear in Code and new selections. Deleting a registration leaves working files, history, routes and infrastructure in place.

## Limitations and recovery

Concurrent edits from another window cause a conflict: reload the profile and compare changes. Unverified references block archive/deletion. Archiving does not dismantle running environments. Older conversations keep their previous working roots; new references to a deleted project are forbidden.

## Related articles

[Working directory](chat-workdir.md) · [Code](code.md) · [Tasks](tasks.md)
