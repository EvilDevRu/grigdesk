# Pipeline widget on your phone

The GrigDesk widget shows three pipeline counters for the selected machine on your
phone's home screen: "Running", "Waiting for you" and "Stalled". Task text never
appears on the widget.

## How to add it

1. Open the home screen widget list (long-press an empty spot, then "Widgets").
2. Find GrigDesk → "Pipeline" and drag it onto the home screen.
3. The widget immediately shows the latest data or a status line.

## How to read it

- "Running" — tasks with a live executor.
- "Waiting for you" — a gate, a scout question or a stop that needs a human.
- "Stalled" — the pipeline crashed and waits for analysis.
- The line next to the title shows the update time or a status ("Updating…", "Offline",
  "No machine", "Unlock needed", "Pairing needed", "Update the app", "Update the server").
- Dashes mean there is no successful snapshot for this machine yet. Switching machines hides old counters.

## Updates and tap

Counters refresh on a 15-minute schedule and on pipeline events while the app is open
or backgrounded with the background link enabled. The first event requests a refresh immediately;
the last event in a burst is retained for the end of the 10-second window. Android and network
conditions can delay execution. The arrow button requests a refresh; repeated presses are queued. Tapping the widget opens the Pipeline section; with the app lock
enabled you unlock first. The widget uses the machine selected in the app; counters
keep updating while locked because they are numbers, not conversations.
