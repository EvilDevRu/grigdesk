# Data and backups

The program, server data and client window settings are stored separately.
A backup must cover every location you use.

## Before you begin

Identify the selected machine and its actual data folder. The default is `~/.grigdesk`;
explicit configuration may choose another path.

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
   New directory-lock operations wait while removal runs; another cleanup skips directories if its barrier is busy.
   You can rerun after completion. Reported bytes estimate removed files and may differ from free-space gains.
   On error, resolve the reason and retry; other directories may already have been removed.
   Ctrl+C exits with 130 and SIGTERM with 143. Removing the current directory may finish, but later ones are kept.
   The partial report remains; JSON records cancellation as `interrupted: true`.

The server does not automatically clean other topics. DeepSeek tests remove only their known old outputs.
Restore lost user files from backups; regenerate test builds through normal preparation.

## Limits and recovery

One folder cannot cover all backups: the factory and external executors have their own homes.
Server generation caches do not replace history. Do not remove live process locks.
Old absolute attachment links may require their original locations.

## Related articles

[Updates](updates.md) · [Working folder](chat-workdir.md) · [Connections](connections.md) · [Pipelines](pipelines.md) · [Routes](routes.md)
