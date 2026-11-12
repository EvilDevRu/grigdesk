# Installing the application

The standard distribution uses a ready-made Linux installer from the GrigDesk website. The target machine needs no source checkout, system Node or npm. New portable bundles are no longer built.

## Before you start

Linux x64 and glibc 2.28 or newer are required. The application needs FUSE 2; server mode needs no GUI. Configure external executors' CLIs and authorization separately. Close the window and server before moving from an older portable bundle. Actual release builds undergo separate acceptance before publication.

## What to do

1. When a verified release is published, download `grigdesk-install` from the [GrigDesk website](https://grigdesk.com). The release owner must configure a trusted key.
2. Allow execution: `chmod +x grigdesk-install`.
3. Choose a mode: `./grigdesk-install install local` installs the application and local server; `install remote` installs the application for remote machines; `install server` installs only the server.
4. The program is stored separately from data in your user directory; sudo is unnecessary. Repeating installation over your own registration uses its saved update job; a foreign shortcut or registration is rejected.
5. Keep your previous data and settings. The installer does not remove the old portable directory.

Before installation, run `./grigdesk-install --verify --json` to verify the signature and both embedded archives without changing the program or data. If verification fails, download the file again from a trusted source.

## Alternative: deb package

For convenient installation through apt, download `grigdesk_<version>_amd64.deb` from the website and run `sudo apt install ./grigdesk_<version>_amd64.deb`. The package installs only the `/usr/bin/grigdesk` loader and signed installer. On the first launch from the applications menu, it extracts the bundle to your user directory (`~/.local`), just like a manual local installation. The application then updates itself; apt is not involved and sudo is not needed again. Updating or removing the deb leaves your user installation and data intact. Use the ordinary installer for server mode.

## Result

The installation has its own registration, verified component generations and shared pointer. Remote mode does not create a local server descriptor.

## Limitations and recovery

The installer accepts absolute paths through --root, --data-home, --user-data, --bin-dir, --applications-dir and --unit-dir. It registers its server service without enabling or starting it. On a collision, do not delete data or registrations to retry. Android is installed separately; its updates are outside this mechanism.

## Related articles

[First launch](getting-started.md) · [Updates](updates.md) · [Data](data-and-backups.md)
