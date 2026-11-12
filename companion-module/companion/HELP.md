## needit Deck Cue

Controls [needit Deck Cue](https://github.com/unilordgr/needit-deck-cue), a cue launcher for PowerPoint, WPS Office, Keynote and PDF presentations.

### Setup
1. In Deck Cue open **⚙︎ Settings › Remote control** and make sure it is enabled.
2. If Companion runs on another computer, tick **Allow other computers on the network**. Deck Cue then shows the address to use.
3. Enter that host and the port (default **9640**) in this connection.

### Actions
- **GO**: fire the NEXT cue.
- **Stop all**.
- **Blackout**: toggle, on or off.
- **Next slide** / **Previous slide**.
- **Fire cue** / **Arm cue**: pick a cue, or type its number or name.
- **Arm next cue** / **Arm previous cue**.
- **Timer: start / pause / start-pause / reset / set (minutes) / add or remove time**: the speaker timer on Deck Cue's stage display.
- **Stage message: show / clear**: text on the stage display, optionally flashing. Variables are allowed.

### Feedbacks
- **Cue is live** (red), **Cue is next** (yellow), **Cue is loading**, **Cue file missing**.
- **Blackout is on**, **Something is live**.
- **Timer is running**, **Timer is nearly done** (amber, threshold in seconds), **Timer is over time** (red), **Stage message is showing**.
- **Cue colour**: the colour set on the cue in Deck Cue.

### Variables
- `show_name`
- `live_number`, `live_name`, `next_number`, `next_name`
- `slide`, `slides`, `slide_text` (for example "3/12"; for PDF cues)
- `blackout`, `cue_count`, and `cue_N_name` for every cue
- `timer` (e.g. "04:59"; "+00:12" when over time), `timer_seconds`, `timer_state`, `stage_message`

### Presets
- **Transport**: GO (shows the next cue), Stop, Blackout, slide buttons, live and next displays.
- **Cues**: one button per cue, coloured, turning yellow when next and red when live.
- **Timer**: live countdown button (start/pause; amber near the end, red when over), reset, set 5–30 min, ±1 min.
- **Stage messages**: WRAP UP, 5 MIN, 1 MIN, LOUDER, CHECK MIC, clear.
