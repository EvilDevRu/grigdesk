# Chat list filters

The chat list shows active conversations; the archive is switched by the compact
"Active / Archive" segment next to the search field. In the full list, the number
of archived conversations appears beside "Archive". The counter is hidden
when the archive is empty or a project is selected. The filters icon sits
immediately after the tabs.

## Project

Choose a project in the rail on the left. On narrow screens, use the "Chat project"
selector above search. On phones, the selector replaces the project rail. The open
conversation and its working folder stay in place. The top button with a list icon
("All chats") returns to the full list. "No project" shows chats without a project.

The plus at the bottom of the rail or next to the "Chat project" selector opens the
"New project" dialog. Enter a name to generate the ID automatically. On phones,
the dialog fills the screen. "Cancel" and "Create project" are in the footer.
Cancel and Close ask for confirmation if you have edited the draft. Once created,
the project appears in the project picker.

The rail and the "Chat project" selector show active projects. Search, the chat
archive, and other filters apply within the selected project. Archiving or deleting
the selected project returns the list to "All chats" and keeps the current conversation
open. If the catalog fails to load, the selection is kept and you can retry.
The choice is remembered for this connection.

Creating a chat with a project filter selects that project in the header and uses
its main repository. “No project” uses the user's home folder.
“All chats” uses your usual new-chat settings.

## Filters

The funnel button expands a panel under the list header. It has no visible text label;
hover to see the "Chat filters" tooltip. The number beside the funnel shows how many
filters are active:

- **State** — the "Unread", "Awaiting reply", and "Working" buttons.
  Selected buttons are highlighted; press again to turn off their filters.
- **Task** — a B24 task number, or the "With task" / "Without task" modes.
  A typed number takes priority over the mode.
- **Executor** — one of the executors from the live catalog; "Any" removes this restriction.
- **Freshness** — last 24 hours, last 7 days, last 30 days.

Fields appear in pairs and stack in a narrow panel. The "Reset filters" arrow button
sits at the top beside the state label and becomes available after selecting a filter.
It clears the filters in the panel and keeps the selected project. When the panel is closed, active filters appear as chips below
the "Filters" button: the cross removes one filter. The open panel does not duplicate
the selection with chips. On every screen, the button shows only its funnel and active
filter counter. An empty result also offers a reset.
Filter selection and the Active / Archive scope are remembered between visits.
Chat search works together with filters. If the server does not support filters
yet, the button is hidden and saved filters are not applied — the list works
as before. If the server is rolled back while the window is open, a rejected request
triggers a compatibility check and restores the regular list. If the network is
unavailable, the error remains visible with a retry action. After reconnection,
stale rows can remain until the list is loaded again. Reloading the window retrieves
current results; returning to an already loaded filter can reuse its cached page.

The server applies the filters, so "Show more" loads exactly the filtered chats.
Creating a chat returns to the active list and clears the filters in the panel.
The selected project and search text are preserved. A search may hide the new row.
While connected, new questions and run starts/completions update the state filters.
If an update fails, existing rows remain and the retry action reloads the same selection.
