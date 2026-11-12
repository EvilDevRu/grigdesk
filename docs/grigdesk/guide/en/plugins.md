# Plugins

Plugins add tools and panels. System features and externally installed packages are managed separately.

## Before you start

An external package needs a trusted source and compatible version. Official and Community labels describe origin, rather than the outcome of a security review.

## What to do

1. Open Plugins: Catalog helps choose a package; Installed shows user packages. System plugin settings are on the relevant settings pages.
2. Select a package and version or use Install from Git… with a repository and exact tag.
3. After preparation, read the source, version, changes and warnings. Application needs separate confirmation.
4. A new package without saved enablement appears disabled. Enable it and open its declared panel; read the card's cause if incompatible. Previously saved enablement for the same ID applies after confirmed installation.
5. Configure parameters and placements, then apply. A placement hides a particular block while keeping the plugin enabled.
6. For update or rollback, check the proposed package. If the outcome is unknown, finish recovering the current operation first.
7. To remove a user package, select it in Installed, press the trash icon and confirm. This also works for an older incompatible package with installed dependencies. Separate plugin data and settings remain.

## Other working tools

- **Terminal** opens a shell on the selected machine. Check the directory and target before typing: commands really execute as the server user.
- **SSH** needs a configured connection and an open live session. Enable Agent commands for the required session: agents in all conversations can then use it regardless of project or working directory. The agent sees project, label, role and session ID and chooses the session; identical names are distinguished by ID. Every command needs individual human approval regardless of automatic chat mode.
- **Databases** need an installed suitable driver and configured connection. For agent access, select a project with the folder button in the chat header; a task chat uses its trusted project. A session needs separate admission. Choose a connection and inspect the schema first, then check the query and result. Supervised agent queries have their own approval; unavailable access does not mean an empty database.
- **Documents** open through supported links in a conversation or file section. The viewer uses the allowed source scope. If a document is unavailable, check the machine, source file and working directory; a link alone grants no access to someone else's files.

In a narrow SSH panel, shared tabs switch Servers / Terminal; in Databases they switch profiles, console and queries. Catalog search looks like chat search.

Before approving an SSH command in chat, check the server address and connection tab: the card shows the project and the same tab name as the SSH panel. Repeated connections receive sequence numbers. Compound command parts are visually separated; Allow approves the entire command. Refresh precedes other actions. A round plus adds a server or profile; pressing minus again hides the form and retains the draft. In Databases, Driver opens driver installation from Git. An update separately highlights changes in the manifest and the old and new driver entry files. Check them before applying the prepared version.

## Result

An enabled compatible package connects its features. Closing the installation dialog does not cancel an active job. A package panel can open shared settings on the appropriate executor's page; downloads and binary responses use the same sign-in session as the application. A package notification button can open a particular result in its panel. System-link parameters remain until the panel becomes available. Enabled packages' server notifications work with the panel closed. After reconnection, the application reloads missed outcomes; failure shows a message and retry. Outcomes already viewed do not distract again.

A package with a separate background entry can resume after sign-in without opening its panel. Startup errors show a retry. Disabling a package stops its window background; closing the panel does not. A notification can offer a separate action such as rereading state. After disabling the package, an old button no longer starts work. External panels work on narrow screens too. An uninstalled, disabled or incompatible package's address explains why and links to its card. List errors offer retry. The application does not install or enable a package by itself. Panel shortcuts are configured in Interface → Hotkeys; user assignments or disabling survive off/on and reinstallation.

Plugin icons in side panels match main-section icon sizes. Menus and tool tiles use the size of their corresponding list.

## Limitations and recovery

External packages may be absent from the base release. Their documentation stays inside the package: the agent receives a hint to the contents of enabled plugins. The core guide does not copy it. A plugin without a panel gets no separate navigation item. A broken component explains the cause without claiming to work.

## Related articles

[Settings](settings.md) · [Code](code.md) · [Sandboxes](sandboxes.md) · [Presentations](showcase.md)

## Moving 3D to a separate package

In the updated core, 3D opens through the `studio3d` package at `/ext/studio3d`. The old `/3d` redirects there and preserves parameters. Until installed, the panel explains the missing package and links to its card; the application does not install it automatically. Settings, the separate library, UUID and history keep their previous ID. Saved enablement applies only after confirmed installation; disabled state or an absent key leave the package disabled.

Before applying the update, close **all** older windows and tabs, including remote clients, retaining their profile and IndexedDB. Closing only the panel is insufficient: old JavaScript may change saved intentions after the API is removed. Update the core and window, manually restart the server from an external terminal, and install the approved clean Git release of the package. A development working directory is not an installable release. Open only updated clients. 3D is unavailable until installation; payments with unknown outcomes are not repeated automatically.

Before rolling the core back, remove the external package using the **new** core's normal installer:

1. Close clients and record the presence and value of `plugins.studio3d`. Disable the package, then manually stop the server.
2. Start the new server with the package disabled and remove the unloaded package normally. Check successful removal or recovery and the absence of unfinished install, update or removal operations. Do not start the older core until they finish.
3. Stop the server, restore the previous release and check there is one built-in 3D card. Restore previous enablement with the normal switch; restoring an absent key requires a targeted prefs change while the server is off.

Keep the separate library, UUID, journal and payments with unknown outcomes. Do not manually rename the managed tree, erase the installer journal or repeat a submitted POST. Documentation for the 3D product itself belongs to the package.
