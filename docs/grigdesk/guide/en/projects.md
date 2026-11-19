# Projects and repositories

A project groups a name, working copies and factory connections.
Registration neither moves nor creates your source files.
To test another branch on a single environment, open its primary copy in Code:
the branch button offers selection, stop/build/start commands and return to `dev`.
Configure commands explicitly per repository. See [Code and Git](code.md).

## Before you begin

Prepare existing directories on the server. Human-supplied paths determine which code project operations can access.

## What to do

1. Open Projects, select New, and enter a name. GrigDesk generates the ID from
   the name. If the ID is taken, enter another one or open the existing project.
   The ID is visible in the project details after creation.
2. In Repositories, select Add and enter the absolute path. The label on the right is filled
   from the folder name. You can edit it or clear it to return to the generated label. Choose the primary
   folder and check that the paths are available. Select Folder access to see which
   folders are available in project chats.
3. Save the project details.
4. Chat with project creates a draft with its working folder selected. Configure the profile and routes separately
   for tasks and pipelines.
5. Archive the project to prevent new work. Inspect blocking references and disable them in their owning sections.
6. Restore it from the archive when needed. Delete registration is available in the archive after checks and confirmation.

The project pickers in Chats, Code, and Routes show only active projects.
Archived projects are available on the Archive tab. Restoring a project makes it
available in the pickers again.

Rows from a factory profile are read-only. Use the same Add button to include your own working
folders. After saving, they appear in Code and can be used in project chats. The factory profile
sets the repositories for triage and pipelines.

The compact catalog search matches names, IDs, labels and paths; the adjacent button changes sorting.
The factory configuration heading wraps on narrow screens, keeping its disclosure accessible
with larger text.
The connection skill ships with the application. After updating and starting the new server, type `$` in Codex
and select `$grigdesk-connect-project`; in GLM or DeepSeek type `/` and choose `/grigdesk-connect-project`.
Reload the page if the old menu remains. The agent reads code, proposes interview answers and previews future files;
one package confirmation applies them. Existing profiles show a diff first.
You do not need to send tokens; registering a project alone does not install the skill.

## Project icon

In the project's basic details, choose "Upload icon" next to the preview. Choose
"Replace icon" if an image is already set. Select a PNG, JPEG, WebP, or SVG up to 5 MiB
and 4096×4096 pixels. GrigDesk preserves proportions, centers transparent artwork with padding,
and converts the file to PNG. The colored tile is used for letter avatars. Choose Save to
display the icon in the project catalog and the chat rail.

To use the letter avatar again, choose "Remove icon" and save the project.
Cancel restores the saved image along with the other fields. An unreadable file
leaves the previous icon in place.

In Chats, select a project in the left rail or the "Chat project" selector above search.
You can also start a conversation in the active project's working folder.
[Choose a project and combine filters](chat-list-filters.md).

## Factory configuration

For an existing project with a factory profile, expand Factory configuration. Open the group
for the variables, runners, or models you want to edit. Expand Read-only to see the remaining values and the
reasons they cannot be edited. Edit a field, choose Apply changes, review the complete
summary and confirm Write to profile. Failover and unchanged model fields appear when their group
is sent. Edited fields show the last server value next to the input. Profile metadata are
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
