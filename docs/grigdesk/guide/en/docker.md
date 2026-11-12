# Docker

The Docker plugin shows the local daemon through its Unix socket. It does not switch remote Docker hosts. Open the panel from the right rail or Ctrl+Shift+6.

## Before you start

Enable the plugin and configure the server's Docker access. Check the selected environment first: actions affect the real daemon.

## What to do

1. Open Docker and reload local daemon state.
2. Find a container and open its details, logs and related resources.
3. To start, stop or restart, select a specific container and read the proposed action.
4. Before deleting containers, images or volumes, carefully check the list and warnings. Confirm only the required scope.
5. Reload state after the operation; on refusal, use the daemon's stated cause.

Compose-group actions affect the entire project even if filters hide some rows. Search covers name, image, project and ports; the non-running checkbox includes stopped containers. Container terminals depend on exec permission settings. Volume deletion and pruning all unused images may be disabled separately.

## Result

Actual Docker state is displayed. Disk-usage figures come from the daemon and may differ by resource type. While the catalog loads, row skeletons retain normal spacing, including on narrow screens.

## Limitations and recovery

Deleting a volume can delete data. A running shared container may belong to another task. An unavailable daemon does not mean an empty list. Docker controls do not replace profile-specific environment setup and teardown.

## Related articles

[Sandboxes](sandboxes.md) · [Plugins](plugins.md) · [Diagnostics](troubleshooting.md)
