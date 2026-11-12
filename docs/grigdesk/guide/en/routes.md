# Route editor

The editor prepares routes for future runs. A draft and a published version are different states.

## Before you start

Choose a project and route. Editing needs permission to change profile settings and an understanding of stage inputs and outputs. Published routes and drafts live with the factory in the shared data directory by default. Route script sources stay in the selected profile; explicitly configured external paths are retained.

## What to do

1. Open Routes, select a project and create or open a draft.
2. Review the graph and stage properties: executor/command, inputs, checks, transitions and returns. Specify where a human decision is required.
3. Save the draft. On a revision conflict, reload the new version, compare your edits and save the reconciled version.
4. Run route validation and fix reported connectivity, input and executor-availability errors.
5. Publish the verified revision. In the new-run form, confirm the intended route is offered.

In a narrow panel, Catalog / Route / Properties switch with compact tabs like the board. Selection and unapplied fields survive switching. The round plus in the catalog header creates a separate draft. The same plus beside project selection opens project creation; its tooltip explains the purpose.

Model and effort come from launch policy outside the route catalog; the inspector displays effective policy read-only. When adding a stage, the wizard offers a role, environment/permission requirements and insertion point, showing the transition package before application. Ctrl+S saves applied edits; apply a field's local input with its own button first.

## Result

New attempts use the published catalog. Saving a draft alone does not change a run.

## Limitations and recovery

Publishing does not rewrite the current attempt's pinned route. A deleted project leaves an unsaved draft readable but prevents saving it through the server. Do not bypass version conflicts by blindly writing again.

When moving an older factory, follow the [maintenance procedure](data-and-backups.md). Republishing a route or manually editing the old routesDir does not replace migration; pinned versions and attempt history remain.

## Related articles

[Projects](projects.md) · [Pipelines](pipelines.md) · [Gates](gates.md) · [Data and backups](data-and-backups.md)
