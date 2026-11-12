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
