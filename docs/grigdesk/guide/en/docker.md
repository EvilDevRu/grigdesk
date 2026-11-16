# Docker

Docker shows the local daemon through its Unix socket; it does not switch remote Docker hosts.
Open it from the right rail or Ctrl+Shift+6.

## Before you begin

Enable the plugin and configure server access to Docker.
Check the selected environment: actions affect a real daemon.

## What to do

1. Open Docker and refresh the local daemon's state.
2. Find a container and open details, logs and related resources.
3. Select a specific container for start, stop or restart and read the proposed action.
4. Before removing containers, images or volumes, check the list and warnings and confirm only the intended scope.
5. Refresh after the operation and use the daemon's stated reason if it fails.

Compose-group actions affect the entire project even if filters hide some rows.
Search matches name, image, project and ports; include stopped containers using its checkbox.
Container terminals depend on exec permission settings.
Volume removal and clearing all unused images may be separately prohibited.

## Result

The panel shows actual Docker state. Space measurements come from the daemon and differ by resource type.
Loading placeholders preserve row spacing, including narrow layouts.

## Limits and recovery

Removing volumes can delete data. Shared containers may belong to another task.
An unavailable daemon does not mean an empty list.
Docker controls do not replace profile-specific environment creation/removal.

## Related articles

[Sandboxes](sandboxes.md) · [Plugins](plugins.md) · [Diagnostics](troubleshooting.md)
