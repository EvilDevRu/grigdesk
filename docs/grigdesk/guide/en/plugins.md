# Plugins

Plugins add tools and panels. System features and external installable packages are managed separately.

## Before you begin

External packages need a trusted source and compatible version.
Official and Community describe origin, rather than a security assessment.

## What to do

1. Open Plugins. Catalog helps choose packages; Installed lists user packages.
   System plugin settings are on their relevant settings pages.
2. Choose a package/version or Install from Git with a repository and exact tag.
3. Read the prepared source, version, changes and warnings. Application needs separate confirmation.
4. A new package without saved enabled status starts disabled. Enable it and open its declared panel.
   Incompatibilities appear in its card. Saved status for the same ID applies after confirmed installation.
5. Configure parameters and placements, then apply. Disabling a placement hides that block without disabling the plugin.
6. Review updates or rollback packages. Resolve an unknown current operation before starting another.
7. Delete a user package from Installed using the bin and confirmation, including old incompatible packages
   with installed dependencies. Separate plugin data and settings remain.

## Other working tools

- Terminal opens a shell on the selected machine. Check folder and target: commands run as the server user.
- SSH needs a configured connection and open live session. Enable Agent commands to expose it to every conversation,
  independently of project or working folder. Agents choose by project, label, role and session ID;
  IDs distinguish identical names. Each command needs human confirmation even in automatic chat mode.
- Databases need an appropriate installed driver and connection. For agent access, explicitly choose a project
  through the conversation folder button; task chats use their trusted project. Sessions need separate admission.
  Inspect the schema and verify queries/results. Supervised agent requests have their own confirmation;
  missing access does not mean an empty database.
- Documents open from supported conversation/file links within the source's permitted area.
  Check machine, file and working folder if unavailable; a link does not grant access to unrelated files.

Narrow SSH panels switch Servers / Terminal; database panels switch profiles, console and queries.
Catalog searches resemble chat search. Before confirming SSH, check server address and connection tab:
the card shows the project and same tab name as SSH. Repeated connections are numbered.
Compound-command parts are separated visually; Allow approves the entire command.
Refresh precedes other actions. A round plus adds a server/profile; pressing its minus hides the form but keeps drafts.
Driver in Databases opens Git installation. Updates distinguish changes in manifest and old/new entry files;
review them before applying.

## Result

An enabled compatible package connects its capabilities. Closing installation does not cancel its active job.
Panels can open common executor settings. Downloads and binary responses share the application's authenticated session.
Notifications can link to a result; system-link parameters remain until its panel is available.
Enabled packages can notify with their panel closed. Reconnection rereads missed outcomes and offers Retry on failure;
already viewed outcomes do not distract again.
Packages with background entries can resume after sign-in without opening a panel.
Startup failures offer Retry. Disabling stops window background activity; closing the panel does not.
Old notification actions stop working after disabling the package.
Missing, disabled or incompatible panel URLs explain why and link to the package card, with retry for catalog errors.
The application does not install or enable packages automatically. Panels support narrow screens.
Set panel shortcuts in Interface → Keyboard shortcuts; overrides and disabled assignments survive off/on and reinstall.
Sidebar plugin icons match built-in section sizes; menus and tool tiles use their list's size.

## Limits and recovery

External packages may be absent from the base release. Their documentation stays inside each package;
agents receive the contents path for enabled plugins. Core help does not copy it.
Packages without panels receive no separate navigation item. Broken components show a reason rather than pretending readiness.

## Moving 3D to a separate package

The updated core opens 3D through `studio3d` at `/ext/studio3d`.
Old `/3d` URLs redirect with parameters preserved. Until installed, the panel links to its package card without installing it.
Settings, separate library, UUID and history keep their previous ID.
Saved enabled status applies only after confirmed installation; disabled status or an absent key leaves it disabled.

Before applying, close all old windows and tabs, including remote clients, preserving profile and IndexedDB.
Closing the panel alone is insufficient: old JavaScript could modify saved intentions after API removal.
Update core and window, manually restart the server from an external terminal and install the approved clean Git release.
A development directory is not an installable release. Open only updated clients.
3D is unavailable until installation; unknown paid requests are never repeated automatically.

Before rolling back core, remove the external package using the new core's normal installer:

1. Close clients, preserve the existence/value of `plugins.studio3d`, disable the package and manually stop the server.
2. Start the new server with the package disabled and uninstall the unloaded package normally.
   Verify successful removal/recovery and no unfinished installation, update or removal before starting old core.
3. Stop the server, restore the old release and check one built-in 3D card.
   Restore enabled status with its normal switch. An originally absent key requires a targeted prefs edit with the server stopped.

Keep the separate library, UUID, journal and unknown payments.
Never rename managed trees manually, erase installer journals or repeat submitted POSTs.
The 3D product's own documentation is inside its package.

## Related articles

[Settings](settings.md) · [Code](code.md) · [Sandboxes](sandboxes.md) · [Presentations](showcase.md)
