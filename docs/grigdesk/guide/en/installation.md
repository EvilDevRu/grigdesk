# Installing the application

Download a small terminal script from the website. It obtains its helper and only the selected
components of a ready-made release. Internet access is required; system Node/npm and source code are not.
New complete offline packages are no longer produced.

## Before you begin

Linux x64 with glibc 2.28 or newer is supported. You need curl, gzip and coreutils.
GUI and FUSE 2 are needed to launch the window; server mode works without them.
The installer reports missing prerequisites and does not install system packages itself.
Close the old portable window and server before migrating, keeping their data.

## What to do

1. Download a verified release's `grigdesk-install` from the [GrigDesk website](https://grigdesk.com).
2. Open a terminal in the download folder and run `sh ./grigdesk-install`.
3. Select local for the window and local server, remote for the window alone, or server for a server alone.
4. Choose separate program and data folders. Review the version, paths and download size, then confirm.
   No network download happens before confirmation.
5. Wait for verification and completion. The service is registered without being enabled or started.
   External executor CLIs and authentication are configured separately.

For automation, specify the mode and confirmation explicitly:

```sh
sh ./grigdesk-install --yes --mode server --root /chosen/program --data-home /chosen/data
```

`install local|remote|server` remains supported, as do the absolute path flags `--root`, `--data-home`,
`--user-data`, `--bin-dir`, `--applications-dir` and `--unit-dir`. Spaces are supported.
`--launch` opens the window after local/remote installation and requires GUI/FUSE beforehand.
Without it, installation over SSH is allowed, with a warning about later window launch requirements.

The script pins exact hashes and sizes for the index and helper. The helper verifies the signed release
before installing components. Failed integrity checks prevent execution.
The old `--verify` command does not apply to the shell script: installation includes verification.

## Alternative: deb package

Install `grigdesk_<version>_amd64.deb` with `sudo apt install ./grigdesk_<version>_amd64.deb`.
It contains only the script and launcher, requires internet and opens a terminal on first launch
from the application menu. Later launches use the user installation; updates need neither apt nor sudo.
Removing the deb keeps the application and user data.

## Result

The application has private registration and verified component generations with a shared current pointer.
Remote mode does not download a server or create a local server descriptor.
The program, data and window profile remain separate.

## Checking a candidate from source

Open “Distribution” in the `grigdesk-ctl` menu. Choose an Actions artifact directory for official files,
or the UUID printed by a successful `dist build` for your own local build:

```sh
grigdesk-ctl dist check --from /artifact/directory
grigdesk-ctl dist check --local-run <UUID>
```

Checks install all three modes into temporary profiles. “Install for testing” asks for the mode,
separate paths and confirmation. A local candidate trusts only its own private run record and cannot
be published; `--from` uses the official product key. `dist doctor` reports host limitations.
`dist build` runs the full release recipe in a source snapshot. The terminal command and the
“Build distribution” menu item show the share of completed stages, the current stage and its
latest output line. The log directory appears after the snapshot is prepared, and the bar
reaches 100% once the verified candidate is recorded. The native server tests require a
running user systemd manager so the build can create a dedicated scope. Fast `build` commands remain available.
Building the AppImage requires curl, unzip and 7z on the host.
Verification uses isolated working folders and removes temporary files when it finishes.
Preparation caches are stored separately from verification results.

## Limits and recovery

Verified archives stay in a private cache. After an interrupted download, the incomplete file is downloaded
again in full. An unknown or incomplete installation folder is preserved: keep its files and failure reason.
Repeating a completed installation uses the regular updater and keeps the previous maintenance helper.
Do not remove data or registration to get around a collision.

The website keeps the two most recent lightweight releases per channel. If a long-saved script can no longer
find its pinned files, download a new script from the official website.
A clean VM, real window and official Actions candidate require separate owner acceptance.
Android installs and updates separately.

## Related articles

[Getting started](getting-started.md) · [Updates](updates.md) · [Data](data-and-backups.md)
