# Route editor

The editor prepares routes for future launches. A draft and published version are different states.

## Before you begin

Choose a project and route. Editing needs profile-settings access and an understanding of stage inputs and outputs.
Published routes and drafts normally live with the factory in the shared data folder.
Route scripts remain in the selected profile; explicitly configured external paths are preserved.

## What to do

1. Open Routes, choose a project and create or open a draft.
2. Inspect stages: executor/command, inputs, checks, transitions and returns. Specify human decisions.
3. Save. On version conflict, reload, compare your changes and save a reconciled version.
4. Validate and resolve connectivity, input and executor-availability errors.
5. Publish the verified revision and check the new-run form proposes it.

Narrow panels switch between Catalog / Route / Properties using compact tabs, preserving selection and input.
The catalog's round plus creates a draft; the plus beside project selection creates a project.
Tooltips distinguish them.
Model and effort belong to launch policy outside the route catalog; the inspector displays effective policy read-only.
The add-stage wizard asks for role, environment/permission needs and position, previewing transitions before application.
Ctrl+S saves applied changes. Apply a field's local input with its own button first.

## Result

New attempts use the published catalog. Saving a draft alone does not change a run.

## Limits and recovery

Publishing does not overwrite a running attempt's pinned route.
A deleted project leaves an unsaved draft readable but impossible to save through the server.
Do not bypass version conflicts with blind repeated writes.
For old factory migration, follow [maintenance guidance](data-and-backups.md).
Republishing or editing an old routesDir does not replace migration; pinned versions and attempt history remain.

## Related articles

[Projects](projects.md) · [Pipelines](pipelines.md) · [Gates](gates.md) · [Backups](data-and-backups.md)
