# GrigDesk settings

The shared settings dialog opens over the current screen and keeps drafts until application.

## Before you start

Check the selected machine: server settings and device preferences have different scopes.

## What to do

1. Open Settings with the button beside Help or through the application menu.
2. Find a page using search or the section tree. For an executor, choose its own card.
3. Change parameters and check warnings. Switching pages preserves drafts.
4. Press Apply and wait for the response. On refusal, fix the stated cause and retry.
5. F1 opens help for the selected page over the unfinished form. Close help to return to it.

Dismiss a toast with its cross or a left/right swipe on its title, text or free card space. A short gesture returns it to place. Buttons and details keep their normal behavior; swiping neither approves a request nor opens its target. The notification remains viewed in bell history. Touch and focus pause its timer.

In searchable selection menus on phones, the field keeps normal input text size. Type part of a name to narrow the list, then select an option.

Interface language belongs to the device: System default uses Russian on a Russian system and English otherwise. Choosing Russian/English applies immediately, including open help; Cancel does not undo it. If saving fails, the device restores the previous language. Article ID and drafts in other fields remain.

## Result

Confirmed parameters are saved. Closing with unapplied changes offers an explicit choice.

An older saved 3D settings address opens the `studio3d` package card in Plugins → Installed. Provider settings and its key remain on the executor page. External-panel shortcuts are changed in Interface → Hotkeys; enabling a package or choosing a library does not change user key assignments.

A successful notification with a title or close cross has a green check without a circle. Adjacent text explains the outcome and next steps.

Confirmation and installation dialogs show the title icon without a colored background. A red sign marks a dangerous action; read the text and button label before confirming.

## Configure quota refresh

Open Executors: a shared automatic quota refresh switch is above card selection. It is off by default, including after upgrading an older installation without a saved choice. It applies to all devices using the selected server. Change it and press Apply. Until then, the previous choice remains active; Cancel restores the original state. Other open windows receive the choice while keeping unapplied input with a conflict warning.

When off, last values and their old check times remain visible. Opening a popover, refreshing a page or running an agent does not measure quotas. Press ↻ for the required executor: only its data refreshes. Before the first measurement, it says “Quota has not been checked yet. Press ↻”. Retry after errors; provider cooldown after overly frequent requests remains. The button works with automatic refresh enabled too.

After enabling and applying, stale quotas are checked immediately and background collection runs. Forecasts receive points only from new measurements. After a server restart in manual mode, the snapshot is empty until the first check. This setting changes neither actual limits nor chat operation.

If ↻ stops refreshing quotas after a server update and the error asks you to choose an executor and update the application window, install the current application build on this device. An older interface sends the request without the selected executor. Restarting only the server does not update the application's interface. Then check the selected machine, enable automatic refresh if needed and press Apply.

## Configure the VPN gate

On System → Startup, enable the VPN gate to check the tunnel before server startup, optionally specifying an interface and probe address. The gate is off by default, so startup performs no check. When enabled, it blocks startup until the route to the probe address uses the tunnel.

Press Apply to save the parameters, or OK to save and close Settings. Cancel discards unapplied changes.

Changes apply after restarting the server: the section shows current running values and warns when saved configuration differs. Restart is above in the same section.

## View computer resources

Press CPU/RAM in the header; on phones it is in the second bar. A dialog shows compute, memory and disks. Each row has readings, temperature where a sensor exists, and a load or used-space bar. Large load and memory indicators are at the top, followed by disk rows; yellow/red row edges and free space help identify a filling partition. The list scrolls under a fixed header; closing returns to the previous screen. On disconnection, the dialog retains its last snapshot and shows its age.

## Limitations and recovery

The Access tab of a supporting executor shows [saved profiles](access-profiles.md). Saving and activating connections are separate actions without the shared Apply button. After migration to profiles, forecasts start a separate profile journal; the old `balance-log.json` stays on disk, but its samples are not mixed into the new forecast. This is an explicit clean statistics start, rather than deletion of the old journal.

The server saves access keys; manual environment changes may require a restart. Model availability and a key probe do not prove a successful paid request. A settings load error requires restoring the connection or reloading.

## Related articles

[Executors](chats.md) · [Connections](connections.md) · [Speech](speech.md) · [Plugins](plugins.md)

Connecting Qwen Code and configuring its model catalog are covered in a [separate article](qwen.md).
