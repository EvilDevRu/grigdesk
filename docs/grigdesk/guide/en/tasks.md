# Tasks and triage

A task describes the result and acceptance criteria. Triage checks the request against code and project rules before choosing a route.

## Before you start

Enable the external drivers you need in board settings. A pipeline requires an active project and its profile.

In Tracker drivers, switch between installed drivers on the left. The dialog keeps its height; long forms scroll inside while buttons stay at the bottom. Initial loading mirrors the catalog and settings layout; on narrow screens the driver selector is above the form. Saving becomes available after loading. Apply at the bottom saves settings and keeps the dialog open. It is a neutral outlined button before the blue Save button. Save writes settings and closes after success. On failure, both buttons keep entered data for correction and retry.

Driver actions use the same layout as Executors: ordinary outlined buttons, with a red Delete button at the end. Select a driver on the left, press Delete, check the name in confirmation and confirm. Connection credentials, portal data and tasks remain. If the main board is deleted, the server selects the first remaining enabled board; if none remain, a tracker setup banner appears. Cancel preserves entered parameters. On error, fix the cause and retry. If the outcome is unknown, press Recheck directly in settings; saving is disabled until the outcome is known.

Add tracker immediately opens driver selection: choose a source and version, then confirm installation. To update, select an installed driver and press Update. Version selection, available rollback and restoration of manual changes also live in its settings. There is no separate Other actions screen. Done and Go to settings return from an operation to driver settings. While adding a tracker, loading shows source-card placeholders; while selecting a version, it shows one field placeholder. Expanded manual version input remains visible while waiting.

The Enable checkbox after Default includes the driver in the combined task list. Default makes the open driver the main board and enables it if necessary. Press Apply or Save to store the choice. The button is disabled for the current main board. Enabled marks each connected driver; Default marks the main board, which has both chips. These reflect saved settings and update after applying or saving; selecting a row only opens its parameters.

Paste the entire API token: `=` within the value is valid. Remove spaces, line breaks, surrounding quotes and the `Bearer ` prefix, then press Test connection. The tracker verifies token authenticity; success does not save credentials yet. The secret-field hint says an empty input retains the previous secret. The explanation by Test connection refers to checking the current input.

On a computer, a card can open in a separate window. While connecting, it may display “Connecting to GrigDesk…” before loading the task. This applies to external tracker tasks. Close it with its close button; on reconnection, the entered draft stays in the open card.

## What to do

1. Create or open a task on the board. Describe current behavior, the expected result, a reproducible example and constraints.
2. Specify the project and attach required materials. Describe independent outcomes as separate items.
3. Start evaluation. Triage reads the request, available materials, code and rules in the declared scope; it does not perform the whole task.
4. Open the evaluation tab in the card. Read scope, conclusions and questions. Answer each question separately and clarify criteria.
5. Check the proposed route. Manual route selection belongs to a person; then confirm starting.
6. Star tasks and enable Favorites for quick selection. The shelf holds a separate working set. Check tracker status separately from pipeline attempt state.

In New task, choose an enabled external board that supports creation. The available default board is selected initially; otherwise choose one explicitly. Choose GrigTasks manually without changing the machine's main board. There is no built-in GrigDesk board. Without connections, use the tracker setup banner.

Project shows projects of the selected board if it supports them. GrigTasks requires a project; B24 allows creation without a group. Changing boards keeps title and description, but requires selecting the project again.

All enabled sources share one feed. A row chip names its driver; filters select sources. On connection failure, previously read rows remain marked unavailable, while other drivers continue. In CLI, `tracker boards` lists available enabled boards; `--board <id>` selects a command's target.

Search, Favorites and New are directly above the list. Filters expands sorting, sources, project, evaluation mode and reset. Evaluate all there queues unevaluated default-board tasks independently of search. In the right column, switch between control and assignments; its search is separate. On a phone, open these lists with tabs or a horizontal swipe.

On wide screens the upper skeleton represents the pending tracker summary; there is one My tasks list, with search and filters available.

Old `grigdesk:<id>` links show “Task not found”. They do not open an external task with the same number. Close the card and select a current external task.

For triage, descriptions are limited to their first 8000 characters, comments to the last 15 of 1500 characters each. Unopened links lower confidence. The chosen cloud model receives task materials; consider this before starting. Triage reads code without starting environments, running tests or editing source.

## Result

The request has been evaluated item by item, material questions resolved, and a route explicitly selected.

## Limitations and recovery

Operations without a board use the default external board. If its driver is disabled or removed, the server chooses the first remaining enabled one. Older applications and commands without a target continue using this default. External-task evaluation is tied to the default board; the server rejects another source before evaluation starts.

A link or existing implementation alone does not prove acceptance. Tracker access errors require restoring the connection. After an unknown response, check whether the task exists before creating it again.

Clarifications have a total limit:

| Material | Limit |
| --- | --- |
| Human clarifications | 30,000 characters |

## Related articles

[Incoming](incoming.md) · [Pipelines](pipelines.md) · [Gates](gates.md)
