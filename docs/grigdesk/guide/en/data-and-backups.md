# Data and backups

The program, server data and client window settings are stored separately.
A backup must cover every location you use.

## Before you begin

Identify the selected machine and its actual data folder. The default is `~/.grigdesk`;
explicit configuration may choose another path.

## Data folder layout

Paths are relative to the data folder; the `GRIGDESK_HOME` environment variable selects another folder.
Folders are created on demand: a missing folder means the feature has not been used yet.

| Folder | Contents |
| --- | --- |
| `.env` | Machine settings and executor keys |
| `chats/` | Conversation history and attachments (see below) |
| `state/` | Server state: settings, model registry, sessions and keys, SSH/DB profiles, logs, plugin data, speech and presentation resources |
| `artifacts/` | Agent working folder: snapshots, dumps, scripts and verification reports |
| `factory/` | Pipeline: engine state and executor homes, routes and drafts, task triage |
| `qwen-runtime/` | Qwen Code session homes: memory and executor session bindings |
| `runtimes/` | Standalone server and DeepSeek delivery caches |
| `profiles/` | Factory project profiles (binary delivery) |
| `plugins/` | Installed user plugins; working data lives in `state/plugins/` |
| `drivers/`, `db-engines/` | External tracker drivers and database engines |
| `telegram/`, `github/` | Inbox archives and account settings; tokens live in `state/` |
| `mobile/` | Phone access: TLS keys, devices, relays |
| `3d/` | Library of the 3D section |
| `browser/`, `provider-cli-leases/` | Browser relay socket and external CLI executor leases |

Each chat is a separate file `chats/YYYY-MM/<id>.json`, where `YYYY-MM` is the chat's creation month;
attachments live in `chats/attachments/`, defaults for new chats in `meta.json`, and deletion records
in `deleted.json`. To find a chat by ID, look for `<id>.json` inside the month folders; if the creation
month is unknown, check every `YYYY-MM/` folder. The chat ID is visible in the interface address.
Reading conversations is only allowed with explicit human permission.

## What to do

1. Finish agent turns, recordings, installations and jobs. Stop processes using the data through
   their owner's normal controls.
2. Copy the entire data folder with permissions: machine settings, history, attachments, device pairings,
   inbox archives, plugins and their state, models and artifacts.
3. Back up repositories, executor homes, factory state and route catalogs separately; these may live outside
   GrigDesk's folder. Include window settings and the selected server when migrating the client.
4. Verify the backup is readable and restrict access: it contains keys and conversations.
5. Restore with processes stopped. Restore consistent folders and permissions, start one server instance
   and verify the machine and history.

## Result

You have a consistent copy of working data, rather than program binaries alone.

## Artifacts from new turns

On Linux, GrigDesk creates `artifacts/chat-runs/projects/<project>/<run>/` in the shared
data folder outside Git. Runs without a project go directly into `artifacts/chat-runs/`.
Links in the conversation keep working after the temporary checkout is removed while the file still exists.

GrigDesk removes run directories in a daily pass once 14 days have elapsed since the turn ended.
To keep a run, create an empty `.keep` file in its directory or ask the agent to pin the run.
Placement follows the executor's write permissions. Turns that cannot use a run directory
continue to use the previous layout.

## Cleaning old artifacts

1. Back up artifacts you need. Cleanup is irreversible and does not check conversation links;
   images in old replies may disappear when their files are removed.
2. Run `grigdesk-ctl artifacts-cleanup --dry-run`. Check the root, each directory, sizes and total.
   `GRIGDESK_ARTIFACTS_DIR` selects another root. A large scan may take minutes; Ctrl+C safely stops dry-run
   and also cancels an ongoing preview in the terminal menu.
3. Run `grigdesk-ctl artifacts-cleanup` when the list is correct. Set age with `--older-than 12h`
   or `--older-than 14d`; whole minutes `m`, hours `h` and days `d` are supported, with a default of 7 days.
   `--keep-generations 3` sets how many recent test-cache generations to keep; `--json` outputs a script report.
4. Alternatively, choose Developer → Artifact cleanup in the terminal menu. It previews candidates and
   defaults to Cancel. Only an explicit Delete starts removal after rechecking.
5. Check the report. Young or busy directories and core Node cache content are preserved.
   Cleanup does not block executor startup when it finds only young data.
   New directory-lock operations wait while removal runs; another cleanup skips directories if its barrier is busy.
   You can rerun after completion. Reported bytes estimate removed files and may differ from free-space gains.
   On error, resolve the reason and retry; other directories may already have been removed.
   Ctrl+C exits with 130 and SIGTERM with 143. Removing the current directory may finish, but later ones are kept.
   The partial report remains; JSON records cancellation as `interrupted: true`.

Old topics are cleaned manually. DeepSeek tests remove only their known old outputs.
Restore lost user files from backups; regenerate test builds through normal preparation.

## Limits and recovery

One folder cannot cover all backups: the factory and external executors have their own homes.
Server generation caches do not replace history. Do not remove live process locks.
Old absolute attachment links may require their original locations.

## Related articles

[Updates](updates.md) · [Working folder](chat-workdir.md) · [Connections](connections.md) · [Pipelines](pipelines.md) · [Routes](routes.md)
