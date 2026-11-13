# Installing the application

The normal distribution is a ready-made Linux installer from the GrigDesk website.
The target machine needs neither source code nor system Node or npm. New portable packages are no longer built.

## Before you begin

You need Linux x64 and glibc 2.28 or newer. The application requires FUSE 2; server mode needs no GUI.
External executor CLIs and authentication are configured separately.
Close the previous portable application's window and server before migrating.
Finished builds undergo separate acceptance testing before publication.

## What to do

1. Download a published, verified `grigdesk-install` from the [GrigDesk website](https://grigdesk.com).
   The release owner must configure a trusted signing key.
2. Allow execution: `chmod +x grigdesk-install`.
3. Choose one mode: `./grigdesk-install install local` for the application with a local server;
   `install remote` for an application connecting to remote machines; `install server` for a server alone.
4. The program is installed separately from data in your user directory, without sudo.
   Repeating your own installation resumes its saved update job; a conflicting shortcut or registration is rejected.
5. Keep the old data and settings. The installer does not delete the previous portable folder.

Before installing, run `./grigdesk-install --verify --json` to verify the signature and both embedded archives
without changing the program or data. If verification fails, download the file again from a trusted source.

## Alternative: deb package

Download `grigdesk_<version>_amd64.deb` and run `sudo apt install ./grigdesk_<version>_amd64.deb`.
It installs only the `/usr/bin/grigdesk` launcher and signed installer. The first launch from the application
menu installs the local-mode application under `~/.local`, just as manual installation does.
The application then updates itself, without apt or further sudo use.
Updating or removing the deb leaves the user installation and data intact.
Use the normal installer for server mode.

## Result

The installation has its own registration, verified component generations and a shared pointer.
Remote mode does not create a local server descriptor.

## Limits and recovery

Absolute paths can be set with `--root`, `--data-home`, `--user-data`, `--bin-dir`,
`--applications-dir` and `--unit-dir`. The server service is registered without enabling or starting it.
Do not remove data or registrations to get around a collision. Android installation and updates are separate.

## Related articles

[Getting started](getting-started.md) · [Updates](updates.md) · [Data](data-and-backups.md)
