# Executor access profiles

A profile saves a connection for one executor. Several connections can be saved, but only one is active. This choice applies to conversations, service calls and pipelines.

1. Open Settings → Executors, select an executor and the Access tab.
2. Press Add profile, enter a name and sign-in method, then Continue.
3. For API access, enter the key for the selected mode. For CLI access, follow the wizard: “Enter this code on the website” and “Code from the website” describe different directions.
4. Wait for verification and Saved. Opening a link does not yet mean successful sign-in.
5. Choose Activate in the required connection's row. A check marks the active row. In the executor menu in the header, press a connection button at the bottom below limits and forecasts. Buttons form a shared switcher; the current connection has a filled background. Overflow connections appear under “…”. Pressing the current button does not switch access again. The row appears only when more than one account is saved. The management button on the right opens this same Access tab; with one account, use the header gear.

Add profile is above the list. The circular arrow restores sign-in, the pencil renames, and the trash icon removes an inactive connection after confirmation. Renaming preserves executor availability, the selected connection and statistics. These changes save immediately without the shared Apply button.

GLM's ordinary API and Coding Plan are saved as separate profiles with their own keys and statistics. Signing in to DeepSeek again warns that the account could not be identified. Until confirmation, the previous key works; cancel changes nothing. Confirmation retains profile and history but starts a new executor session with a memory notice.

Restore sign-in concerns the chosen profile and does not enable an inactive connection. You cannot delete an active profile: explicitly choose another first. Switching is available when this executor has no active conversations or unfinished pipelines. Working, awaiting confirmation, background work and sleeping count as activity; a paused pipeline keeps access pinned. While busy, switch buttons are disabled with an explanation. Availability updates automatically after work ends.

After disconnection, wait for recovery: the wizard learns the actual result without resending the key. After interrupted/expired sign-in, use Retry. If the CLI version is unsupported, the wizard explains refusal and keeps the previous connection. Another account is never automatically substituted when sign-in is lost. GrigDesk sign-in remains; restore the selected executor's access. If the old GLM key no longer works and accounts cannot be compared, the wizard asks to confirm replacement after verifying the new key. The connection stays unchanged until confirmation.

After cancelling CLI sign-in, wait for its process to finish: new turns, profile switching and another sign-in may be temporarily unavailable. If an operation's response is lost, the next step checks its outcome first. Another profile does not receive the previous attempt until recovery. Unknown outcomes survive window reload; secret input is not saved for this. Network errors, key rejection, rate limits, expired codes and save failures have separate explanations. If cancellation cannot yet be confirmed, the wizard stays open.

Actual CLI sign-ins and quotas depend on version and account. Automated synthetic checks do not replace checking with the access owner.

Unfinished input survives switching settings pages. Finish the wizard or cancel input before the shared Apply action. Closing Settings or losing sign-in clears secret fields. An existing profile's mode is fixed; add another profile for another mode. Refreshing a token for the same account preserves its forecast.
