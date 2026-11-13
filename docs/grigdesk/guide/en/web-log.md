# Window log and diagnostics

The window log connects interface errors with time, requests and connection state.

## Before you begin

Check the selected machine. Diagnostics need enough detail for reproduction but do not replace steps.

## What to do

1. Open diagnostics settings and choose a suitable logging level.
2. Before reproduction, open Server → Window log, enter a brief comment and Mark failure.
   Wait for Saved on server and record time and section.
3. Reproduce once and retain exact steps and the error message.
4. Download today's log (UTC) and provide a limited excerpt with version and event time.
5. Remove keys, tokens, pairing strings, private addresses and personal conversations before sharing.
   Restore normal logging afterwards.

## Result

The saved material helps diagnose interface/connection failures. The general level controls diagnostic volume.

## Limits and recovery

The selected server retains the current and previous 13 UTC days.
Large logs rotate into compressed parts; reaching 20 MiB in a day does not stop logging.
The combined limit is 280 MiB and 128 archive parts, after which the oldest data is removed,
so the available period can be shorter. Download combines all retained parts of today into one NDJSON.
For another day, run from source on the server:

```bash
node server/scripts/web-log.mjs --day YYYY-MM-DD --json
```

Expired or volume-evicted records cannot be recovered from logs; save needed excerpts separately.
Missing events do not prove missing actions when delivery failed. Do not publish full profiles or data folders.
Diagnostics alone are not acceptance of a user scenario.
Detailed logging distinguishes start, waiting and completion of section, tool, settings and dialog opening.
Requests correlate through serverRequest. Fast openings also log;
backgrounding ends observation separately from a freeze.

## Related articles

[Troubleshooting](troubleshooting.md) · [Settings](settings.md) · [Connections](connections.md)
