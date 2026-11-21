# Installing the application

A v3 package downloads `control.tar.gz` alongside the selected components.
It contains the `grigdesk-ctl` command. Close the registered installation’s
window and server before its first switch to Go. Use `--migrate-to-go` for
separate terminal confirmation. For automation, use
`--yes --migrate-to-go --expected-current-sha <sha256>` for the existing `current.json`.

Download a small terminal script from the website. It obtains its helper and only the selected
components of a ready-made release. Internet access is required; system Node/npm and source code are not.
This installation method applies to the Linux releases on the website.

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

## Apple Silicon candidate

In GitHub Actions, **Run workflow** selects Linux x64 and macOS Apple Silicon by default.
Clear Linux to get only the Mac bundle. Mac candidates use the `dev` channel and are
delivered as Actions artifacts.

Use macOS 15 or later for a downloaded development candidate. Open Terminal in the
extracted candidate directory and run:

```sh
sh ./grigdesk-install --source-dir "$PWD"
```

You can select the same three modes. Installation uses the downloaded files and macOS
system tools. Use a separate data folder with an absolute path that contains no spaces.
If installation is interrupted, repeat the command with the same candidate, mode and paths.
For server modes, run `grigdesk-ctl server start --wait` to start the service,
`grigdesk-ctl server stop` to stop it, or `grigdesk-ctl server logs` to view its log.
For window modes, run `grigdesk-ctl open` to open the application.
Native acceptance for the macOS candidate runs separately.

## Alternative: deb package

Install `grigdesk_<version>_amd64.deb` with `sudo apt install ./grigdesk_<version>_amd64.deb`.
It contains only the script and launcher, requires internet and opens a terminal on first launch
from the application menu. Later launches use the user installation; updates need neither apt nor sudo.
Removing the deb keeps the application and user data.

## Result

The application has private registration and verified component generations with a shared current pointer.
Remote mode does not download a server or create a local server descriptor.
The program, data and window profile remain separate.

## Command menu

Run `grigdesk-ctl` without arguments in a terminal. The header shows the version, server
and window status. Use the arrow keys to highlight an item, Enter to select it, and Esc
to go back. Builds started from the menu display progress and their results on the same screen.
Press Ctrl+C to cancel the build, then Enter or Esc at the result to return to the selected target.
Confirmation screens start on Cancel. Set `NO_COLOR=1` for text without color.
With `TERM=dumb`, progress stages appear on separate lines.

## Checking a candidate from source

Open “Distribution” in the `grigdesk-ctl` menu. Choose an Actions artifact directory for official files,
or the UUID printed by a successful `dist build` for your own local build:

```sh
grigdesk-ctl dist check --from /artifact/directory
grigdesk-ctl dist check --local-run <UUID>
```

Checks install all three modes into temporary profiles. “Install for testing” asks for the mode,
separate paths and confirmation. A local candidate trusts only its own private run record and cannot
be published; `--from` uses the official product key.
`dist build` runs the full release recipe in a source snapshot. The terminal command and the
“Build distribution” menu item show the share of completed stages, the current stage and its
latest output line. The log directory appears after the snapshot is prepared, and the bar
reaches 100% once the verified candidate is recorded. On Linux the native server tests
use a dedicated scope in the user systemd manager. Building the AppImage requires curl, unzip, and 7z.

On Apple Silicon, **Build → All** and `grigdesk-ctl build all` run
`dist build --channel dev`. This requires macOS 15 or later, the Xcode tools,
native Node, and the Homebrew formulas in `tools/ci/Brewfile.macos`.
The build checks its environment. On a new machine or after a setup error, you can run
`bin/utilities/ctl dist doctor` from the repository root and review `ok` and `checks`
in the JSON report. After verification, use the run UUID
with `dist install --local-run <UUID>` and specify the installation mode and paths.
Official candidates have their own signing key.

Verification uses isolated working folders. On macOS, Ctrl+C waits for the server started by that check.
This includes a service that is still starting.
If ownership or shutdown cannot be confirmed, the command prints the retained installation and log path.
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
