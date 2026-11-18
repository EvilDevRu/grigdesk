# Route editor

The editor prepares routes for future launches. A draft and published version are different states.

Rebasing changes and confirming publication open in a dialog over the editor. Its
actions are in the footer.

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
Wide panels keep the graph beside stage properties even when toolbar actions wrap;
the stage list remains accessible below the graph.
The catalog's round plus creates a draft; the plus beside project selection creates a project.
Tooltips distinguish them.
Model and effort belong to launch policy outside the route catalog; the inspector displays effective policy read-only.
The add-stage wizard asks for role, environment/permission needs and position, previewing transitions before application.
Ctrl+S saves applied changes. Apply a field's local input with its own button first.

## Visual editor

Click empty canvas space or Add stage, then choose a role. Custom asks for an instruction.
An empty route receives the complete role package. Otherwise it connects after the nearest
stage center strictly to the left. A missing predecessor or forbidden position keeps the dialog
and your text; choose another point or use the existing wizard.

Drag nodes to move them; Escape cancels. Moving changes layout only; use the stage list to
change execution order. Drag an outcome of the selected stage onto another node to connect it.
Dropping outside nodes or onto the source changes nothing. Connections remains available for
keyboard input. Auto-arrange restores the snake layout in one undoable action.

Coordinates remain in the original draft after publication. A new copy of a published catalog
starts with automatic layout. Saving and publishing keep their usual confirmations. Full manual
acceptance of gestures after updating the server is still required; component checks do not replace it.

## From the terminal

`routes` ships as a standalone SEA executable and needs no system Node.
In a source checkout, run `npm --prefix routes run build` to create
`bin/routes`, which is ignored by Git. Before building, use
`node routes/src/main.ts …`. Local information: `--help`, `--version`, `--license`.
The server package includes the CLI in its generation's bin directory. For a manual ELF
installation, place the new executable in the selected installation's bin directory.

`bin/routes` returns JSON through the same server. Start with `editor <profile>`.
If necessary, explicitly call `source <profile> --mode editor --yes` using the values read for
`--expected-source-revision` and `--expected-catalog-hash` (none means no catalog).
Use `new <profile> --from empty`, save `show <profile> --draft <id>` as JSON, edit all five
content fields, then run `apply <profile> --draft <id> --file document.json --expected-revision <N>`.
Apply replaces the full content and removes omitted routes. N belongs to the snapshot read
before editing and is never replaced by a newer GET revision.

Run `validate <profile> --draft <id> --expected-revision <new-revision>` and inspect issues/severity:
exit 0 only means a report was received. Read editor again, compare expectations and call publish
with --draft, --expected-revision, --expected-source-revision, --expected-catalog-hash and --yes.
Use `rollback <profile> --hash <hash>` with the source/current expectations and --yes to roll back.
Before publication stderr prints an operationId. After a lost response, read
`publications <profile> <operationId>` instead of blindly repeating the write. Compare versions on conflicts.

`profile-config get <profile>` reads metadata;
`profile-config set <profile> --file profile.sh --set PROFILE_LOOP_MAX_ROUNDS=40`
changes an allowed value using its read from value. It does not create profiles.
The full technical reference is `docs/grigdesk/pipeline/routes-cli.md` in the source repository.
The live CLI workflow after restarting the server still needs manual acceptance.

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
