# Executor access profiles

A profile saves one executor connection. Several can be saved, with one active at a time.
The selection applies to conversations, service calls and pipelines.

1. Open Settings → Executors, choose an executor and its Access tab.
2. Select Add profile, enter a name and sign-in method, then Continue.
3. For API access, enter the key for the chosen mode. For CLI access, follow the wizard:
   entering a code on a website and pasting a code from a website are different steps.
4. Wait for verification and Saved status. Opening a link does not prove sign-in succeeded.
5. Activate the required connection; the active row has a check mark.
   In the top-bar executor menu, connection buttons sit below limits and forecast in a shared segmented control.
   The active connection is filled; overflow connections are under “…”. Clicking the current one does not switch again.
   The row appears only with multiple accounts. The header gear opens settings for managing connections.

Add profile is above the list. The circular arrow restores sign-in, the pencil renames, and the bin deletes
an inactive connection after confirmation. Renaming preserves readiness, selection and statistics.
These actions save immediately without the general Apply button.

GLM API and Coding Plan profiles have distinct keys and statistics. DeepSeek sign-in warns if account identity
cannot be determined. The old key remains until confirmation; cancelling changes nothing.
Confirmation preserves the profile and history but begins new executor memory with a note.

Restore sign-in affects the chosen profile without activating an inactive one.
To delete the active profile, first select another. Switching is available only when the executor has no active
conversations or unfinished pipelines. Work, approval waits, background work and sleep count as activity;
a paused pipeline also holds access. Disabled buttons explain why and update automatically when work ends.

After connection loss, the wizard checks the actual outcome without resending the key.
Retry interrupted or expired sign-in. Unsupported CLI versions show a reason and preserve previous access.
Failed executor sign-in does not sign you out of GrigDesk or automatically choose another account.
When an old GLM key fails and accounts cannot be compared, replacing it requires confirmation after key verification.
After cancelling CLI sign-in, wait for its process to exit; turns, switching and another sign-in may remain unavailable until then.

A lost response is resolved before the next action. Another profile cannot inherit an unresolved attempt.
Unknown outcomes survive window reload without saving secret input.
Network errors, rejected keys, rate limits, expired codes and save failures are explained separately.
The wizard stays open if cancellation cannot yet be confirmed.

Real CLI sign-ins and quotas depend on version and account. Synthetic automated checks do not replace verification
with the account owner. Incomplete input survives settings-page navigation.
Finish or cancel the wizard before general Apply. Closing settings or losing authorization clears secret fields.
An existing profile's mode is fixed; add another profile for a different mode.
Refreshing the same account's token preserves its forecast.
