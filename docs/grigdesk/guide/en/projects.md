# Projects and repositories

A project groups a name, working copies and factory connections.
Registration neither moves nor creates your source files.
To test another branch on a single environment, open its primary copy in Code:
the branch button offers selection, stop/build/start commands and return to `dev`.
Configure commands explicitly per repository. See [Code and Git](code.md).

## Before you begin

Prepare existing directories on the server. Human-supplied paths determine which code project operations can access.

## What to do

1. Open Projects and create a registration with a permanent ID and name.
2. Add repositories with short labels and absolute paths. Choose the default and check path availability.
3. Save the project details. If paths differ from the factory profile, compare both and choose explicitly.
4. Chat with project creates a draft with its working folder selected. Configure the profile and routes separately
   for tasks and pipelines.
5. Archive the project to prevent new work. Inspect blocking references and disable them in their owning sections.
6. Restore it from the archive when needed. Delete registration is available in the archive after checks and confirmation.

The compact catalog search matches names, IDs, labels and paths; the adjacent button changes sorting.
The connection skill ships with the application. After updating and starting the new server, type `$` in Codex
and select `$grigdesk-connect-project`; in GLM or DeepSeek type `/` and choose `/grigdesk-connect-project`.
Reload the page if the old menu remains. The agent reads code, proposes interview answers and previews future files;
one package confirmation applies them. Existing profiles show a diff first.
You do not need to send tokens; registering a project alone does not install the skill.

## Result

The saved project's repositories appear in Code and new selectors.
Deleting registration leaves working files, history, routes and infrastructure intact.

## Limits and recovery

Concurrent edits cause a conflict: reload and compare changes. Unchecked references block archive/deletion.
Archiving does not tear down running environments. Old chats keep their working roots;
new links to deleted projects are forbidden.

## Related articles

[Working folder](chat-workdir.md) · [Code](code.md) · [Tasks](tasks.md)
