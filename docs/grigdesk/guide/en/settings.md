# GrigDesk settings

Settings opens above the current screen and keeps drafts until application.

## Before you begin

Check the selected machine: server configuration and device preferences have different scopes.

## What to do

1. Open settings beside Help or through the application menu.
2. Find a page using search or the section tree. Choose an executor's own card for its settings.
3. Change values and read warnings. Drafts survive page navigation.
4. Apply and wait for the response. Resolve any stated failure and retry.
5. F1 opens help for the selected page above the unfinished form. Close help to return.

Interface language is a device preference and changes immediately. English and Russian apply to help contents,
search and articles as well as buttons. An open help window keeps its selected article when language changes.
Cancel does not undo a language change. The website link carries the selected language.
If an older server lacks English help, the reader shows the Russian guide with an explanation.
The standalone help website has its own language selector and remembers its choice.

Select the language in Interface → Behavior → Interface language. Labels in chats, tasks,
pipelines, routes, meetings and tools update without reloading the page. Dates, numbers,
help text and accessible names follow the selected language. Your task titles, messages,
drafts and file contents keep their original text.

Dismiss a toast with its cross or swipe left/right over its title, text or empty area.
A short swipe returns it to place. Buttons/details retain their ordinary behaviour;
swiping neither approves a request nor opens its target. The notification remains viewed in bell history.
Touch and focus pause its timer. On phones, searchable menu input keeps ordinary field text size;
type part of a name and select a result.

## Result

Confirmed settings are saved. Closing with unapplied changes offers an explicit choice.
Models can refresh after access has saved; Access saved followed by Recheck does not mean saving the key failed.
Recheck in the executor card without re-entering it.
Old 3D-settings URLs open the `studio3d` card in Plugins → Installed.
Provider settings/keys remain on their executor page.
External-panel shortcuts live in Interface → Keyboard shortcuts; enabling a package or choosing a library does not reset them.
Success notifications with a title or close control use a plain green check mark.
Confirmation/installation header icons have no coloured tile. Red identifies dangerous actions;
read the text and button before confirming.

## Codex Host mode

By default Codex runs in the workspace sandbox. The shared "Host mode" switch lives in
Settings → Executors → GPT (Codex) → Parameters and applies to every ordinary Codex chat,
new and existing. There is no per-chat switch and no repeated consent. Enabling requires
explicit confirmation in the shared dialog; without it the server does not save the
setting. Disabling returns the sandbox and needs no confirmation.

In Host mode Codex runs without the sandbox's filesystem and network restrictions, within
the server user's permissions. There is no automatic sudo. A prompt before every write
outside the workspace and automatic action review are not guaranteed: without the sandbox
boundary the former extension requests do not arise. GrigDesk's mandatory supervisory tool
confirmations (SSH and databases) and the direct SSH restriction remain.

The change applies to the next turn. A running turn keeps its permissions and is not
stopped by saving the setting. Before the next turn the previous Codex process and its
background work are closed with confirmed completion; if cleanup is not confirmed, the new
profile does not start and the reason is visible in Settings → Runs → Live agent processes
with a retry. The conversation, model and effort are preserved; external actions the agent
already performed are not undone by closing. "Stop" interrupts only the turn, while closing
the live process also ends its background work — these are different actions.

In chat with Host enabled, a read-only "Host" label with an honest hint replaces the mode
select; the current turn's permissions and the next turn's setting are distinguished.
Host mode requires a working application user systemd and a separate unit; without them the
run gets an explicit refusal reason. The selected Codex installation, version and managed
policy are checked at admission; incompatibility refuses without a silent switch.

## Configure quota refresh

Executors has one Automatic quota refresh switch above card selection.
It defaults off, including upgraded installations without a saved choice, and applies to all devices using the server.
Apply saves it; before application the old choice remains and cancellation restores the original.
Other windows receive it while keeping unsaved input and warning about conflicts.
When off, last values and timestamps remain. Opening a popover, reloading or using an agent does not measure quota.
Press ↻ on the desired executor to update only its data.
Before the first check a message asks you to press ↻. Retry failures; provider rate-limit cooldowns remain.
Manual refresh also works with automation enabled.
Enabling and applying immediately checks stale quotas, then continues in the background.
Forecast samples require new measurements. After a server restart in manual mode, no snapshot exists until checking.
The setting changes neither limits nor chat execution.
If ↻ stops working after a server update and asks you to select an executor/update the window,
install the current client build: older interfaces omit the target executor.
Restarting the server alone does not update embedded clients. Then verify machine and automatic-refresh choice and Apply.

## Configure the VPN gate

In System → Startup → VPN gate, enable tunnel checking before server startup and optionally set interface/probe address.
The default is off. When enabled, startup waits until the route to the probe goes through the tunnel.
Apply saves; OK saves and closes; Cancel discards unapplied changes.
Changes take effect after server restart. The page shows active values and warns when saved configuration differs.
Restart is above in the same section.

## View computer resources

Click CPU/RAM in the header, or second bar on phones.
The resource window shows compute, memory and disks with readings, temperatures when available and usage bars.
Large load/memory figures are above disk rows. Yellow/red edges and free space identify nearly full partitions.
The list scrolls below a fixed header; closing returns to the previous screen.
Connection loss keeps the last snapshot with its age.

## Limits and recovery

Supported executors show [saved access profiles](access-profiles.md).
Saving and activation are separate immediate actions without general Apply.
Profile migration starts a new per-profile forecast journal. The old `balance-log.json` remains on disk;
its samples are not mixed into the new forecast. This is a clean statistics start rather than deletion.
The server saves keys; manual machine-environment changes may require restart.
Available models and key probes do not prove paid requests work.
Settings-load failures require restoring connection or reloading.

## Related articles

[Executors](chats.md) · [Connections](connections.md) · [Speech](speech.md) · [Plugins](plugins.md) · [Qwen Code](qwen.md)
