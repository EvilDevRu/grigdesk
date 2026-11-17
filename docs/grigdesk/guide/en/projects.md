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

## Project icon

In the project's basic details, choose "Upload icon" and select a PNG, JPEG, or WebP
up to 5 MiB and 4096×4096 pixels. The image is resized while keeping its proportions.
Once it is ready, choose Save. The icon appears in the project catalog and the chat rail.

To use the letter avatar again, choose "Remove icon" and save the project.
Cancel restores the saved image along with the other fields. An unreadable file
leaves the previous icon in place.

In Chats, select a project in the left rail or the "Chat project" selector above search.
You can also start a conversation in the active project's working folder.
[Choose a project and combine filters](chat-list-filters.md).

## Factory configuration

For an existing project with a factory profile, expand Factory configuration. It shows capabilities,
variables, runners and models. Edit an available field, choose Apply changes, review the complete
summary and confirm Write to profile. Failover and unchanged model fields appear when their group
is sent. Last value read shows the server fact separately from your input. Profile metadata are
read without executing Bash.

After a conflict or partial failure, wait for reload, compare actual values and confirm the remaining
changes again. An unknown write outcome is never retried automatically. Reload and keep input retains
unapplied intent. Discard unapplied input removes intent; completed writes remain applied.

Apply necessary changes before leaving: navigation to another project and page reload discard local
panel input. Read-only fields explain the restriction; edit complex assignments manually in the trusted
profile according to its contract. The form does not create a profile. Manual acceptance of writes
through the live engine after restarting the server is still required.

## Result

The saved project's repositories appear in Code and new selectors.
Deleting registration leaves working files, history, routes and infrastructure intact.

## Limits and recovery

Concurrent edits cause a conflict: reload and compare changes. Unchecked references block archive/deletion.
Archiving does not tear down running environments. Old chats keep their working roots;
new links to deleted projects are forbidden.

## Related articles

[Working folder](chat-workdir.md) · [Code](code.md) · [Tasks](tasks.md)
