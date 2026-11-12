# needit Deck Cue

<img src="build/icon.png" width="128" alt="needit Deck Cue icon">

A cue launcher for presentations on macOS, built for AV operators by **needit Creative**. It works with **Microsoft PowerPoint**, **WPS Office**, **Keynote** and **PDF** files (PDFs use a player built into the app).

## Presentation apps
Deck Cue detects which apps are installed (⚙︎ Settings › System lists them).
- **.ppt / .pptx / .pps(x) / .dps** open with the app chosen in ⚙︎ Settings › *Open .ppt / .pptx with*. **Auto** uses the first one installed, in the order PowerPoint, WPS Office, Keynote.
- **.key** files always open in Keynote.
- **.pdf** files always play in the built-in PDF player.
- Any cue can override this in its editor (*Open with*).

| | PowerPoint | WPS Office | Keynote | PDF |
|---|---|---|---|---|
| How it's controlled | AppleScript | Its menus, through Accessibility | AppleScript | Built-in player |
| Accessibility permission | Only for routing to an output | **Always required** | No | No |
| Sends to a chosen output | Yes | Yes (best effort) | No (Keynote chooses; press X) | **Yes** |
| Tested | Not yet (not installed on the dev Mac) | **Yes, WPS 12.1** | Not yet | **Yes** |

**PDF player**
- Each page is shown fitted to the screen on black, on the cue's output. If the output is *Let the app choose*, it uses the first external display, or the main display if there's none.
- **Start slide** sets the first page.
- While a PDF is live, Deck Cue takes the clicker keys (→ ← ↑ ↓ Page Up / Page Down) from any app, so a presentation clicker works even when another window has focus. When the PDF ends, those keys go back to normal.
- In the player window you can also click for the next page, right-click for the previous one, type a number and press Return to jump, use Home / End, or press Esc to stop.
- With the cue's *Fullscreen* set to *Just open*, the PDF opens in your default PDF app instead.

**WPS Office notes**
- WPS has no scripting support, so Deck Cue clicks *Slide Show › Play*, types the slide number to jump, and sends arrow keys and Esc. Menu names are matched in **English**, so keep WPS's interface language set to English.
- WPS can't close a deck while a slideshow is running. With *Close the previous presentation* on, Deck Cue closes the old deck *before* starting the next one, so the editor shows for a moment during the change. Turn on *black backdrop* in Settings to hide it on the output.
- Don't leave a dialog open in WPS (Save, Recover, etc.). Deck Cue can't click Play while one is showing.

## Versions of files

Speakers change their decks until the last minute. Deck Cue watches every cue's file. This works on network shares and USB drives too.
- **UPDATED** (blue): the file changed on disk. If that cue is live, you're told that the running show still has the old version; fire the cue again to load the new one.
- **NEW VERSION** (amber): a newer file with the same name in the same folder. Version markers are recognised: `_v7` → `_v8`, `FINAL` → `FINAL 2`, `rev4` → `rev5`, `(3)`, `-2` → `-3`, `copy`. "Day 2" and "Day 3" stay separate decks. The cue editor offers **Use it** or **Ignore**.
- **Settings › Newer version of a file in its folder** chooses *Show it and ask* (default), *Switch to it automatically* or *Ignore*.

## Thumbnails

Each cue button shows its first slide. On macOS, Quick Look renders any deck or PDF, with no Office needed. On Windows, Deck Cue uses the preview PowerPoint saves inside the `.pptx`, and pdf.js for PDFs. The stage display shows the next cue's thumbnail too.

## Presenter remote (phone)

Turn it on in **Settings › Presenter remote**. Speakers scan the QR code, or open `http://<deck-cue>:9640/remote` and enter the PIN.
- They get large **NEXT / PREV** buttons, the current slide, the slide number, the timer and your stage messages.
- A Bluetooth clicker paired with the phone works too.

**Safeguards**
- Only NEXT and PREV are available to presenters.
- Five wrong PINs lock that device out for a minute. **New PIN** changes it.
- The **PRESENTER** chip in the status bar pauses it instantly (also from Companion or `POST /api/presenter/mute`).
- Untick a cue's *Presenter remote can change slides* to keep that cue operator-only.
- Presses go through Deck Cue, so a backup machine follows them.

## Live slide number

While a cue is live, Deck Cue reads which slide is showing, once a second:
- **macOS:** PowerPoint and Keynote
- **Windows:** PowerPoint and WPS (through one long-running PowerShell)
- **PDF:** always

The slide number feeds the stage display, presenter remote, Companion and OSC. A backup catches up to the exact slide where the app allows jumping (PDF, Windows PowerPoint/WPS, Keynote). **WPS for Mac** can't report its slide (no scripting), so it is followed with next/previous only.

## MIDI

**Settings › MIDI › Listen to MIDI.** It works with any connected MIDI device or virtual port (IAC, a lighting desk, QLab…):
- **Notes** fire cues. Note 60 (middle C) = cue 1, 61 = cue 2… The base note is adjustable.
- **Program Change** n fires cue n+1.
- **MIDI Show Control**: GO with a cue number fires that cue, GO without one is the GO button, and STOP / ALL_OFF stop.
- **Learn** maps any note, CC or program change to GO, Stop, Next slide, Previous slide or Blackout.
- You can filter the input and channel, and the panel shows the last message received.

## Program window (NDI / OBS capture)

Choose the output **Program window (for NDI / OBS capture)** for a PDF cue. It plays in a normal 16:9 window titled *needit Deck Cue — Program* instead of on a screen. NDI Tools *Screen Capture*, OBS (with its NDI plugin) or vMix can capture that window by name and send it as NDI, without needing a spare monitor. PowerPoint, WPS and Keynote can't render into a window, so for those cues capture their output screen instead.

Deck Cue doesn't send NDI itself. That needs the proprietary NDI SDK as a native add-on.

## Show-machine mode

One switch (**Show mode** in the top bar) makes the computer safe to run a show from.

**While it's on:**
- **No sleep, screensaver or power-saving slowdowns.** The display stays awake, and Deck Cue keeps full speed in the background, so timers, sync and remote control never stall.
- **Notifications are silenced:**
  - *Windows*: app notifications are turned off. The previous setting comes back when show mode turns off or Deck Cue quits.
  - *macOS*: Apple gives apps no way to switch Do Not Disturb. Make two Shortcuts once, `Deck Cue Show On` (Set Focus → Do Not Disturb → On) and `Deck Cue Show Off` (→ Off), and show mode runs them. The panel explains how and opens the Shortcuts app.
- **A SHOW MODE badge** appears in the status bar, and quitting asks for confirmation.

**Readiness checks in the panel:**
- **Apps that can pop up over a show:** Slack, Teams, Zoom, Webex, WhatsApp, Telegram, Signal, Discord, Skype, Messages, FaceTime, Mail, Outlook, Spotify, Dropbox, OneDrive, Google Drive, Creative Cloud, Microsoft AutoUpdate. **Quit them** asks them to close (never forced), and only when you click it.
- **Running on battery.**
- **Sound muted or at 0** (macOS).
- **Less than 5 GB free disk space.**
- **Where the sound plays**, with a warning for the computer's own speakers while a projector is connected, or for Bluetooth.

**Turn on when Deck Cue starts** keeps it on for a dedicated show machine. It can also be switched remotely: `POST /api/showmode[?state=on|off]`, OSC `/deckcue/showmode [0|1]`, or the Companion *Show-machine mode* action.

## Preflight

Deck Cue checks every cue on **this computer** and shows the result:
- a badge on each cue: ✓, ⚠ with the number of things to check, or ✕ when it won't play
- a list in the cue editor
- a **Preflight** button in the top bar ("✓ Ready", "⚠ 2 to check", "✕ 1 won't play") that opens the full report

Checks run when you add or change cues, when screens are connected, and each time you switch back to Deck Cue (after fixing a deck or installing a font, for example).

**What it checks**
| | |
|---|---|
| File | missing, password-protected, no slides, start slide beyond the last slide, hidden slides, very large files, old `.ppt` format |
| Fonts | every font the deck uses, including theme fonts. Fonts embedded in the deck count as present; so do fonts installed on the computer or bundled with PowerPoint/WPS |
| Screen | slide shape (4:3, 16:9…) against the cue's output screen ("4:3 slides on a 16:9 output: black bars at the sides"), and output screens that aren't connected |
| Video and audio | linked media that can't be found, media streamed from the internet, formats a Mac can't play (WMV, AVI…), and a reminder to rehearse video in WPS |
| Computer | presentation app not installed; WPS without Accessibility permission (Mac) |

Fonts, media and slide details are read from `.pptx`/`.ppsx`/`.potx` files and PDFs (page count, page shape, password). Keynote and old `.ppt` files get the file, app and screen checks.

In Companion, *Cue has preflight problems* and *Show has preflight problems* can colour buttons, and the `preflight` variable gives the summary.

## Main / backup

Run the same show on two computers. Each feeds the video switcher, and the **backup follows the main** in step:
- cue fires, stop, next/previous slide and blackout
- the NEXT cue
- for PDF cues, the exact page
- the speaker timer and stage messages

If the main fails, cut the switcher to the backup and keep going from the backup's own GO, keys or Companion.

**Setup** (⚙︎ Settings › Main / backup):
1. On the main computer choose **Main**. This also allows other computers in Remote control.
2. On the backup choose **Backup** and enter the main's address and port (shown in the main's Settings).
3. Make both shows match: copy the show folder to both computers, or press **Copy show from main** on the backup. Files are matched by name if their folder is different.

**How it stays in step**
- **Actions are sent instantly**, so both machines load together.
- The main also sends its full state every few seconds. The backup corrects any drift: a missed cue, a backup that joined mid-show, or a PDF page moved by its own clicker.
- If the two shows don't line up, the backup says which cues differ.

**Status bar**
- On the main: *MAIN · backup connected: <name>*.
- On the backup: *BACKUP · following <main>*, or a flashing **MAIN LOST** warning.

**Fail-safe:** after losing the main, the backup **holds**. A restarted main with nothing live will not stop the backup's show. Following resumes at the main's next deliberate action (a cue, a slide, stop).

**Limits**
- Slide changes made directly in PowerPoint/WPS/Keynote on the main (for example, a clicker plugged into the main) can't be seen. Send slide changes through Deck Cue: its slide buttons, global *Next slide* keys, Companion or OSC. Or use a clicker that drives both machines (e.g. DSAN PerfectCue).
- Exact-page correction works for PDF cues. Other cues follow next/previous.

To test both roles on one computer, start a second copy with its own settings: `open -n "needit Deck Cue.app" --args --profile=backup` (macOS), or `"needit Deck Cue.exe" --profile=backup` (Windows). Then give it different ports in Settings.

## Stage display (confidence monitor)

Open `http://<deck-cue-computer>:9640/stage` in any browser: a monitor on the stage, a tablet on the lectern, or a laptop at front of house. ⚙︎ Settings › Remote control shows the exact link and has **Open stage display** buttons. A device other than this computer needs *Allow other computers on the network* turned on.

It shows:
- the **live cue** with its slide number, and a **preview of the current and next page** for PDF cues
- the **next cue**
- the cue's **notes** (from the cue editor), as speaker notes
- a large **countdown timer** that turns amber in the last 2 minutes and red with "+MM:SS" when over time, plus the time of day
- **operator messages** as a banner across the top, optionally flashing

`/stage?view=timer` shows only the timer, for a dedicated countdown monitor. The page adapts to portrait tablets and phones.

**Operator controls** are in the bar at the bottom of the main window:
- *Timer*: type `5`, `2:30` or `1:00:00` and press Return to set it. ▶/⏸ starts and pauses, ⟲ resets.
- *Message*: type and press Return to show it on stage. ⚡ makes it flash, ✕ clears it.

Each cue can have a **Timer (min)**. When that cue fires, the timer restarts with that duration (*Settings › Start the speaker timer when a cue with a timer fires*). The timer and messages can also be controlled over the API, OSC and Companion (below).

## Remote control: Bitfocus Companion, Stream Deck, OSC

Deck Cue can be driven from a show controller. Turn it on and set ports in **⚙︎ Settings › Remote control**; these settings belong to the computer, not the show file.
- By default only programs on the same computer can connect.
- Tick **Allow other computers on the network** when Companion or the lighting desk is on another machine. Settings then shows the address to use.

### Bitfocus Companion
The module in `companion-module/` (Companion 4.0 or newer) provides:
- **Actions:** GO, Stop, Blackout (toggle/on/off), next/previous slide, fire a cue, arm a cue, arm next/previous.
- **Feedbacks:**
  - Cue is live (red), Cue is next (yellow), Cue is loading, Cue file missing
  - Blackout, Something is live
  - Cue colour (the colour set in Deck Cue)
- **Timer and message actions:** start/pause/reset/set/add time, show or clear a stage message (feedback: running, nearly done, over time, message showing).
- **Variables:** `live_name`, `next_name`, `slide_text` (PDF cues), `timer`, `stage_message`, `cue_N_name` and more.
- **Presets:** a Transport page, one button per cue that turns yellow when next and red when live, a Timer page (live countdown, 5–30 min, ±1 min) and a Stage messages page (WRAP UP, 5 MIN, …).

To install it:
1. Build the package (`cd companion-module && npm install && npm run package`), or download it from the CI run.
2. In Companion, import `needit-deckcue-<version>.tgz` under *Modules › Import module package*.
3. Add a **needit Deck Cue** connection with the host and port shown in Deck Cue's settings.

### HTTP + WebSocket API (default port 9640)
| | |
|---|---|
| `GET /api/state` | Full state: cues (number, id, name, colour, state), live cue + slide, next cue, blackout |
| `POST /api/go`, `/api/stop`, `/api/next`, `/api/prev` | Transport |
| `POST /api/blackout[?state=on\|off]` | Toggle, or set |
| `POST /api/cue/<number\|id\|name>/fire` · `/arm` | Fire or arm a cue |
| `POST /api/arm/next`, `/api/arm/prev` | Move the NEXT cue |
| `POST /api/timer/start`, `/pause`, `/reset`, `/set?seconds=N`, `/add?seconds=N` | Speaker timer (negative `add` removes time) |
| `POST /api/message?text=…&flash=1`, `/api/message/clear` | Stage message |
| `POST /api/showmode[?state=on\|off]` | Show-machine mode (toggle without state) |
| `POST /api/presenter/mute[?state=on\|off]` | Pause / allow the presenter remote |
| `POST /api/presenter/next`, `/prev`, `/check` + header `X-Presenter-Pin` | Presenter remote (PIN) |
| `GET /api/cue/<ref>/thumb` | First-slide thumbnail |
| `GET /remote` | Presenter phone remote |
| `GET /stage`, `/stage?view=timer` | Stage display page |
| `ws://host:9640/api/ws` | Pushes `{"type":"state","state":…}` on connect and on every change |

### OSC (UDP, default port 9641)
- **Input:**
  - `/deckcue/go`, `/deckcue/stop`, `/deckcue/next`, `/deckcue/prev`
  - `/deckcue/blackout [0|1]`
  - `/deckcue/cue/fire <n|id>`, `/deckcue/cue/arm <n|id>`, `/deckcue/cue/<n>/fire`, `/deckcue/cue/<n>/arm`
  - `/deckcue/arm/next`, `/deckcue/arm/prev`
  - `/deckcue/timer/start`, `/pause`, `/reset`, `/deckcue/timer/set <seconds>`, `/deckcue/timer/add <seconds>`
  - `/deckcue/message <text> [flash 0|1]`, `/deckcue/message/clear`
- **Feedback:** sent to the host:port set in Settings, and for an hour to anything that sends `/deckcue/state` (which also gets the full state at once). Only values that change are re-sent.
  - `/deckcue/live/number i`, `/deckcue/live/name s`
  - `/deckcue/next/number i`, `/deckcue/next/name s`
  - `/deckcue/blackout i`
  - `/deckcue/slide i i` (current, total; 0 when unknown)
  - `/deckcue/cue/<n>/state s`, one of `live`, `next`, `loading`, `missing` or `idle`

The current slide is only known for PDF cues so far. PowerPoint, WPS and Keynote don't report slide changes yet.

## Windows

Deck Cue also runs on Windows 10/11 (x64). There it controls **PowerPoint** and **WPS Office** through COM automation, using the built-in Windows PowerShell; no extra permissions are needed. PDFs use the same built-in player as on the Mac. Keynote doesn't exist on Windows.

There are two builds:
- **Installer**: `needit-Deck-Cue-Setup-<version>.exe`. Installs normally, with a Start menu shortcut.
- **Portable**: `needit-Deck-Cue-Portable-<version>.exe`. Nothing to install, so it can run from a USB stick. Its settings and autosave are kept in a `needit Deck Cue Data` folder next to the `.exe`.

**Choosing the output on Windows**
- *PowerPoint*: Deck Cue sets PowerPoint's slide-show monitor (`DisplayMonitor` in `HKCU\Software\Microsoft\Office\16.0\PowerPoint\Options`) to the cue's output before starting the show.
- *WPS Office*: WPS picks its own display. Set it in WPS under *Slide Show › Set Up Show*.
- *PDF*: goes to the chosen output directly.

**Status:** the Windows build has **not yet been tested with PowerPoint or WPS** on a real PC. CI checks that every Windows script parses, and runs the ones that work without PowerPoint (detect running apps, list monitors). Rehearse before a show.

## Building

Windows builds can't be made on an Apple Silicon Mac, so GitHub Actions makes them (`.github/workflows/build.yml`):
1. Open *Actions › Build › Run workflow* (or push a `v*` tag).
2. Download `needit-Deck-Cue-windows` (installer + portable) or `needit-Deck-Cue-mac` from the finished run.

## Run

```bash
npm install
npm start
```

To build a `.app` for your show machine: `npm run dist` (output in `dist/`).

## Using it

| Action | How |
|---|---|
| Create cues | Drag `.pptx` / `.ppt` / `.pps(x)` / `.key` / `.pdf` files onto empty space or the **+** tile. Several files create several cues. |
| Replace a cue's file | Drag a file onto an existing cue button. |
| Reorder | Drag a cue button onto another one. |
| Fire a cue | Click it, press its shortcut, or press **GO** to fire the NEXT cue. |
| Arm a cue as NEXT | ⌥-click it, or use ↑ / ↓. |
| Edit a cue | Hover and click ✎, or right-click the cue. |
| Lock | 🔒 stops accidental drags, edits and deletes. Cues still fire. |

**Per-cue settings:** label, file, app (auto / PowerPoint / Keynote), **Fullscreen** (Default / Start slideshow / Just open), start slide, **Output** (Default / Let PowerPoint choose / a specific display), shortcut (+ Global), color, notes.

**Keys while Deck Cue is in front:** Space = GO, Esc = Stop all, ← / → = previous / next slide, B = Blackout.

### Shortcuts: local vs global
- A **local** shortcut works only while Deck Cue is the front window. Any key is allowed.
- A **global** shortcut (🌐) works even while PowerPoint is in front. It must use ⌘, ⌃ or ⌥, or an F-key (F13–F19 are ideal for a Stream Deck or keypad). Plain keys can't be global, because they would steal Space, arrows and B from your clicker in the slideshow.
- Global GO / Stop / Blackout / Next / Prev are set in ⚙︎ Settings.

### Outputs (which screen the slideshow goes to)
PowerPoint has no scriptable setting for the slideshow display, so Deck Cue uses this approach:
- **Let PowerPoint choose:** a normal slideshow. With 2 screens and Presenter View on, slides go to the external screen.
- **A specific display:** Deck Cue runs the slideshow in window mode, moves it to that display, and makes it native fullscreen there. This needs **System Settings › Privacy & Security › Accessibility** permission for Deck Cue. Display mirroring must be off.
- **Identify** flashes a number on each display.
- Keynote picks its own display. Press **X** during a Keynote show to move it to another screen.

### Blackout
A black window covers the output display (the default output, or every non-main display). It sits above the slideshow. Press B or the button again to remove it.

### Show files
⌘S / ⌘O save and open `.deckcue` files. Work is autosaved. If a file has moved, Deck Cue looks for it next to the show file, so you can copy a show folder to another machine.

## First run on the show machine
1. Fire a cue. macOS asks to let Deck Cue control your presentation app (and System Events). Click **OK**.
2. Allow Deck Cue in **System Settings › Privacy & Security › Accessibility**. WPS Office needs this always, and PowerPoint needs it for per-display outputs. ⚙︎ Settings has a button that opens this page.
3. **Rehearse on the real projector setup.** The PowerPoint scripting could not be tested on the development machine (see below).

## Status / not yet verified
- **WPS Office** was tested end to end on one display:
  - cold start
  - start slide
  - next slide
  - changing cue while another app had focus
  - closing the previous deck
  - Stop

  Sending a show to a *specific* second display with WPS has **not** been tested (no second screen was connected).
- **PowerPoint / Keynote**: their scripts were written from documentation and have **not been run against the real apps**.
- Rehearse on the real setup before a show. The scripts are in `src/presenters.js`.

Test decks for a quick check are in `test-decks/`.
