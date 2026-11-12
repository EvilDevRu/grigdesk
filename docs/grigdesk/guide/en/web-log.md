# Window log and diagnostics

The window log helps match an interface error with its time, request and connection state.

## Before you start

Check the selected machine. Diagnostics should be detailed enough to reproduce the issue but do not replace a description of steps.

## What to do

1. Open diagnostics settings and select the required logging level.
2. Before reproducing, open Server → Window log, enter a short comment and press Mark failure. Wait for Saved on server and record the time and section.
3. Reproduce the problem once, keeping exact steps and the error message.
4. Press Download today's log (UTC) and attach a limited excerpt with version and event time.
5. Before sharing, remove keys, tokens, pairing strings, private addresses and personal messages. Return to the normal level afterward.

## Result

You have material for analyzing window and connection errors. The shared level controls the volume of diagnostics collected.

## Limitations and recovery

The selected server keeps logs for the current and previous 13 UTC days. Large files are automatically compressed in parts; reaching the first 20 MiB in a day does not stop recording. The total limit is 280 MiB and 128 archive parts: oldest data is removed at that limit, so actual retention may be shorter. Download combines all remaining parts of today into one NDJSON. For another day, run from source on the server machine:

```bash
node server/scripts/web-log.mjs --day YYYY-MM-DD --json
```

Records removed by age or size cannot be recovered from the log. Save required excerpts separately before retention expires.

A missing event does not prove no action occurred when delivery was interrupted. Do not publish an entire profile or data directory. Diagnostic information does not prove successful acceptance of a user scenario.

## Related articles

[Troubleshooting](troubleshooting.md) · [Settings](settings.md) · [Connections](connections.md)

At detailed level, the log distinguishes start, waiting and completion of opening a section, tool, settings or dialog. Requests correlate with the server through serverRequest. Fast openings are recorded too; going into the background ends observation separately from a freeze.
