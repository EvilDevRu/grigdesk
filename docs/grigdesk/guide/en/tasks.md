# Tasks and triage

A task describes an outcome and acceptance criteria.
Triage checks it against code and project rules before choosing a route.

## Before you begin

Enable the required external drivers in board settings. Pipelines need an active project and profile.
The tracker-driver dialog has a catalog on the left, a fixed height, a scrolling form and bottom actions.
On narrow screens, driver selection moves above the form. Initial loading keeps their layout;
saving becomes available after loading.
Apply saves and keeps the dialog open; Save saves and closes after success.
Both preserve input on failure. Driver actions use ordinary outlined buttons, with a red Delete last.
Choose a driver and confirm its name before deletion. Portal credentials, data and tasks remain intact.
Deleting the default board selects the first remaining enabled one; without one, a connection banner appears.
Cancel preserves input. If the outcome is unknown, use Recheck in settings; saving stays unavailable until resolved.

Add tracker opens driver selection directly: choose source, version and confirm installation.
Update, another version, available rollback and recovery of manual changes are in the installed driver's settings.
Done and Back to settings return from the operation. Loading reserves source-card or version-field space;
expanded manual version input stays visible.
Enable adds a driver to the shared task list. Set as default also enables it.
Apply or Save persists the choice; the current default's button is disabled.
Enabled and Default chips show saved settings, not merely the selected catalog row.

Paste the whole API token, including any `=` characters. Remove surrounding whitespace, line breaks,
quotes and the `Bearer ` prefix before Test connection. The tracker verifies the token;
successful testing does not save credentials. Empty secret input keeps the previous secret.
The test explanation refers to current form input.

On desktop, external tasks may open in their own windows. They show a connecting message before loading.
Use the window's close button; reconnecting keeps the open card's draft.

## What to do

1. Create or open a task. Describe current behaviour, expected outcome, a reproducible example and constraints.
2. Set the project and attach materials. Separate independent outcomes into clear points.
3. Start evaluation. Triage reads the task, materials, code and rules within its declared scope;
   it does not execute the whole task.
4. Open evaluation in the card and review scope, conclusions and questions. Answer each question separately.
5. Check the proposed route. A human makes the manual route selection and confirms launch.
6. Star tasks and enable Favourites for quick filtering. The Shelf keeps a separate working set.
   Tracker status and pipeline attempt status are different.

In New task, choose an enabled external board supporting creation. An available default is preselected;
otherwise choose explicitly. GrigTasks is selected manually without changing the machine's default board.
GrigDesk has no built-in board. Without connections, use the tracker setup banner.
Project lists come from the selected board when supported. GrigTasks requires a project;
B24 can create without a group. Changing boards keeps title and description but clears the project selection.

All enabled sources share one feed. A row's chip identifies its driver; filters select sources.
A failed source keeps previously loaded rows marked unavailable while other drivers keep working.
`tracker boards` lists enabled boards and `--board <id>` targets a command.
Search, Favourites and New sit above the list. Filters contains sorting, sources, project, evaluation mode,
reset and Evaluate all. The latter queues unevaluated tasks on the default board regardless of search.
The right column switches between monitoring and assignments with independent search.
Phones use tabs or horizontal swipes. The wide-screen loading summary does not duplicate My tasks.

Old `grigdesk:<id>` links show Task not found and never open an external task with the same number.
Close that card and choose the current external task.
Triage takes the first 8,000 description characters and last 15 comments of up to 1,500 characters each.
Unopened links reduce confidence. The selected cloud model receives task materials.
Triage reads code without starting an environment, running tests or changing source files.

## Create through an agent or tracker

Ask an agent to create a task in the named tracker with a title, description, project and materials.
It uses terminal command `tracker`, not a separate MCP tool or a web environment.
The command contacts the GrigDesk server holding the connection.

1. Use `tracker boards` to identify the intended board by name, state and default marker.
2. Pass its ID with `--board`; changing the default is unnecessary for one task.
   Without the flag, commands use the current default.
3. Send task JSON on stdin to `create`. Add the chosen project's `groupId` when required.
   Do not invent a project or assignee.

For example, if Discript CRM is listed as `grigdesk-b24-discript`:

```bash
tracker --board grigdesk-b24-discript create <<'JSON'
{"title":"Short title","description":"Problem, example and expected outcome","priority":1}
JSON
```

After success, the agent reports the task number or link. Read it from the same board:
`tracker --board grigdesk-b24-discript task <number>`.
If creation's outcome is unknown, check whether the task exists before retrying to avoid duplicates.
No separate login or preventive session check is required; the command reports refusal.
Asking whether creation is possible does not authorize a test record.
Board status and read access do not prove write access; only creation's response confirms it.
Attachments require driver support; the agent reports screenshots it could not attach.

Installed agents receive the CLI through their installation's PATH. Restore a missing distribution rather than
substituting another tracker. From source, `bin/grigdesk-ctl tracker` accepts the same arguments,
using the binary or falling back to source when absent.

## Result

The task is evaluated point by point, substantial questions are resolved and the route is chosen explicitly.

## Limits and recovery

Commands without a target use the default external board. Removing or disabling it selects the first remaining
enabled board. Older clients without a target continue to use that default.
External-task evaluation is bound to the default board; other sources are rejected before evaluation starts.
A link or implementation alone does not establish acceptance. Restore failed tracker access.
Never repeat creation after an unknown response before checking for the task.
Human clarifications have a total limit of 30,000 characters.

## Related articles

[Inbox](incoming.md) · [Pipelines](pipelines.md) · [Gates](gates.md)
