# Connect Qwen Code

Qwen Code uses an external npm CLI and an API key for the selected model service.
Chat requires a Linux server with the bwrap sandbox available.
The external CLI needs Node.js 22 or later. Installation preparation also needs
local headers for the selected Node; missing headers cause a refusal before installation.

## Prepare access and models

1. Open Settings → Executors → Qwen Code and install the CLI with the standard button.
   Updating and checking the version are available there too.
2. Configure `modelProviders` in `settings.json` in the original Qwen home. For each model,
   set `id`, `name`, `baseUrl` and `envKey`, the name of the key's environment variable.
   Do not put the key itself in this JSON. You can configure several services,
   including models with identical names on different services.
3. On the Access tab, enter the key for the declared name and press Apply.
   An empty field preserves the previous key; use the window's separate action to delete it.
4. Refresh the model catalog. A new `modelProviders` entry appears after reloading,
   without updating GrigDesk. Fix malformed JSON in its source; GrigDesk does not rewrite it.
5. Select Qwen and a configured model in chat. Having a key does not confirm the account's
   access to that model: on an API refusal, check the key, service URL and account permissions.

Installation checks dependency installer hooks before confirmation. If the window reports
that the installation method for this version has not been verified, the changed package
needs verification. Verified version 0.27.2 works without disabling this protection.
The CLI's optional microphone backend uses a prebuilt addon; building it from source
requires Python 3, make and a C++ toolchain. GrigDesk chat does not require this feature.

## Chat behavior

There is one working directory; additional writable directories are not supported.
Changing the directory or access separates native memory from the previous session,
while preserving GrigDesk history. Stop interrupts the current process;
continuing uses the saved session. Successful tools show ✓ in live and saved messages;
failed tools show ✕.

Ask, Auto, Plan and No confirmations retain the sandbox boundaries and the server's
direct SSH check before tool execution. An incompatible CLI protection protocol gives
a visible refusal; execution does not fall back to an unprotected mode.
Turns are unavailable without bwrap or on another server operating system.

Attachments currently cause a refusal before sending the prompt. Place the required files
in the working directory and mention them in your message. This executor does not report quotas.

## Verification scope

The pipeline offers a Qwen runner with the same model source. Select the executor
and model in the stage editor. This grants no additional file permissions:
a verification stage writes to state, and an implementation stage to the working directory.
Verify a node separately on a test environment before assigning real tasks to it.

Automated checks cover the real CLI 0.27.2 with a local test API and a node launch
with a test CLI. Installation through the card and browser checks run separately
on a test environment. A paid smoke test requires a real key entered by a person
through the access window and runs during acceptance.
