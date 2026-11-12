// macOS driver: PowerPoint and Keynote through AppleScript, WPS Office through its menus (System Events).
// Arguments are passed via `on run argv`, never interpolated into script text.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APPS = {
  powerpoint: { bundle: 'com.microsoft.Powerpoint', name: 'Microsoft PowerPoint', short: 'PPT', paths: ['/Applications/Microsoft PowerPoint.app'] },
  keynote: { bundle: 'com.apple.iWork.Keynote', name: 'Keynote', short: 'KEY', paths: ['/Applications/Keynote.app'] },
  // WPS has no AppleScript dictionary; it is driven through its menus with System Events (needs Accessibility).
  wps: { bundle: 'com.kingsoft.wpsoffice.mac.global', name: 'WPS Office', short: 'WPS', paths: ['/Applications/wpsoffice.app', '/Applications/WPS Office.app'] },
};
// Order used when .pptx files are set to open with "whatever is installed".
const PPT_APP_PREFERENCE = ['powerpoint', 'wps', 'keynote'];

const installedCache = {};
function isInstalled(app) {
  if (app in installedCache) return installedCache[app];
  let ok = false;
  try {
    const out = execFileSync('mdfind', [`kMDItemCFBundleIdentifier == '${APPS[app].bundle}'`], { timeout: 4000 }).toString().trim();
    ok = out.length > 0;
  } catch { /* fall through */ }
  if (!ok) ok = APPS[app].paths.some((p) => fs.existsSync(p));
  installedCache[app] = ok;
  return ok;
}

const needsAccessibility = (app, routed) => app === 'wps' || (app === 'powerpoint' && routed);

function osa(script, args = [], timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args.map(String)], { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(cleanError(stderr || err.message)));
      resolve(stdout.trim());
    });
  });
}

function cleanError(msg) {
  const m = String(msg).trim();
  if (m.includes('-1743')) return 'macOS blocked automation. Allow Deck Cue in System Settings › Privacy & Security › Automation.';
  if (m.includes('-1719') || m.includes('-25211')) return 'Accessibility permission needed. Allow Deck Cue in System Settings › Privacy & Security › Accessibility.';
  return m.replace(/^\d+:\d+: execution error: /, '');
}

function openWithLaunchServices(bundle, file) {
  // Opening through LaunchServices grants the sandboxed app access to the file (no "Grant Access" dialog).
  return new Promise((resolve, reject) => {
    execFile('open', ['-b', bundle, file], (err) => (err ? reject(err) : resolve()));
  });
}

const PPT_FIRE = `
on run argv
	set fileName to item 2 of argv
	set baseName to item 3 of argv
	set startN to (item 4 of argv) as integer
	set autoShow to (item 5 of argv) is "1"
	set routeIt to (item 6 of argv) is "1"
	tell application "Microsoft PowerPoint"
		activate
		set thePres to missing value
		repeat 160 times
			try
				repeat with p in presentations
					set n to name of p
					if n is fileName or n is baseName then
						set thePres to contents of p
						exit repeat
					end if
				end repeat
			end try
			if thePres is not missing value then exit repeat
			delay 0.25
		end repeat
		if thePres is missing value then error "PowerPoint did not finish opening " & fileName
		if not autoShow then return "opened"
		try
			repeat 10 times
				if (count of slide show windows) is 0 then exit repeat
				exit slide show (slide show view of slide show window 1)
				delay 0.2
			end repeat
		end try
		set ss to slide show settings of thePres
		try
			set range type of ss to slide show range
		end try
		try
			if startN > (count of slides of thePres) then set startN to 1
			set starting slide of ss to startN
			set ending slide of ss to (count of slides of thePres)
		end try
		if routeIt then
			set show type of ss to slide show type window
		else
			set show type of ss to slide show type speaker
		end if
		run slide show ss
	end tell
	if routeIt then
		set x to (item 7 of argv) as integer
		set y to (item 8 of argv) as integer
		set ww to (item 9 of argv) as integer
		set hh to (item 10 of argv) as integer
		delay 0.6
		tell application "System Events" to tell process "Microsoft PowerPoint"
			set frontmost to true
			set w to missing value
			repeat 15 times
				try
					set w to (first window whose name contains "Slide Show")
				end try
				if w is not missing value then exit repeat
				delay 0.15
			end repeat
			if w is missing value then set w to window 1
			try
				if value of attribute "AXFullScreen" of w then
					set value of attribute "AXFullScreen" of w to false
					delay 0.8
				end if
			end try
			set position of w to {x, y}
			set size of w to {ww, hh}
			delay 0.3
			try
				set value of attribute "AXFullScreen" of w to true
			end try
		end tell
	end if
	return "ok"
end run`;

const PPT_STOP = `
if application "Microsoft PowerPoint" is running then
	tell application "Microsoft PowerPoint"
		repeat 10 times
			if (count of slide show windows) is 0 then exit repeat
			exit slide show (slide show view of slide show window 1)
			delay 0.1
		end repeat
	end tell
end if`;

const PPT_NAV = `
on run argv
	tell application "Microsoft PowerPoint"
		if (count of slide show windows) is 0 then return "no show"
		set v to slide show view of slide show window 1
		if item 1 of argv is "next" then
			go to next slide v
		else
			go to previous slide v
		end if
	end tell
end run`;

const PPT_CLOSE = `
on run argv
	if application "Microsoft PowerPoint" is not running then return
	tell application "Microsoft PowerPoint"
		repeat with n in argv
			try
				close (first presentation whose name is (contents of n)) saving no
			end try
		end repeat
	end tell
end run`;

const KN_FIRE = `
on run argv
	set f to POSIX file (item 1 of argv)
	set startN to (item 2 of argv) as integer
	set autoShow to (item 3 of argv) is "1"
	tell application "Keynote"
		activate
		set d to open (f as alias)
		if autoShow then
			try
				if playing then stop front document
			end try
			delay 0.3
			if startN > (count of slides of d) then set startN to 1
			start d from slide startN of d
		end if
	end tell
	return "ok"
end run`;

const KN_STOP = `
if application "Keynote" is running then
	tell application "Keynote"
		try
			if playing then stop front document
		end try
	end tell
end if`;

const KN_NAV = `
on run argv
	tell application "Keynote"
		if not playing then return "no show"
		if item 1 of argv is "next" then
			show next
		else
			show previous
		end if
	end tell
end run`;

const KN_CLOSE = `
on run argv
	if application "Keynote" is not running then return
	tell application "Keynote"
		repeat with n in argv
			try
				close (first document whose name is (contents of n)) saving no
			end try
		end repeat
	end tell
end run`;

const WPS_PROC = `first process whose bundle identifier is "${APPS.wps.bundle}"`;

// WPS notes (verified against WPS Office 12.1 for Mac):
// - Documents share one tabbed window named after the active tab; a slideshow is a separate untitled
//   window in its own fullscreen Space.
// - While a slideshow runs, Slide Show › Play is disabled. That is the reliable "show is running" signal,
//   because System Events cannot see windows in another Space.
// - Activating WPS does not switch to the show's Space while a document window is in the current Space,
//   so focusShow() minimizes the document windows first.
// - Menu titles are matched in English.
const WPS_HELPERS = `
on wpsProc()
	tell application "System Events" to return (${WPS_PROC})
end wpsProc

on wpsRunning()
	tell application "System Events" to return (exists (${WPS_PROC}))
end wpsRunning

on playEnabled(p)
	tell application "System Events" to return enabled of menu item "Play" of menu 1 of menu bar item "Slide Show" of menu bar 1 of p
end playEnabled

on showWindow(p)
	tell application "System Events"
		repeat with w in (windows of p)
			set n to ""
			try
				set n to name of w
			end try
			if n is missing value or n is "" then return contents of w
		end repeat
	end tell
	return missing value
end showWindow

-- Brings a running slideshow to the front. Returns false when no slideshow is running.
on focusShow(p)
	tell application "System Events" to set frontmost of p to true
	delay 0.4
	if my playEnabled(p) then return false
	if my showWindow(p) is not missing value then return true
	tell application "System Events"
		repeat with w in (windows of p)
			try
				set value of attribute "AXMinimized" of w to true
			end try
		end repeat
	end tell
	delay 0.6
	tell application id "${APPS.wps.bundle}" to activate
	repeat 20 times
		delay 0.15
		if my showWindow(p) is not missing value then exit repeat
	end repeat
	return true
end focusShow

on restoreWindows(p)
	tell application "System Events"
		repeat with w in (windows of p)
			try
				if value of attribute "AXMinimized" of w then set value of attribute "AXMinimized" of w to false
			end try
		end repeat
	end tell
end restoreWindows`;

const WPS_STOP = `${WPS_HELPERS}
if not my wpsRunning() then return
set p to my wpsProc()
if not my focusShow(p) then return
repeat 3 times
	tell application "System Events" to key code 53
	repeat 20 times
		delay 0.15
		if my playEnabled(p) then exit repeat
	end repeat
	if my playEnabled(p) then exit repeat
	my focusShow(p)
end repeat
my restoreWindows(p)
-- let macOS finish the fullscreen exit animation before anything else is clicked
delay 1`;

const WPS_FIRE = `${WPS_HELPERS}
on run argv
	set fileName to item 1 of argv
	set startN to (item 2 of argv) as integer
	set autoShow to (item 3 of argv) is "1"
	set routeIt to (item 4 of argv) is "1"
	tell application "System Events"
		set p to missing value
		set docWin to missing value
		repeat 160 times
			try
				set p to ${WPS_PROC}
				set docWin to (first window of p whose name is fileName)
				exit repeat
			end try
			delay 0.25
		end repeat
		if docWin is missing value then error "WPS Office did not finish opening " & fileName
		set frontmost of p to true
		if not autoShow then return "opened"
		if routeIt then
			set targetX to (item 5 of argv) as integer
			set targetY to (item 6 of argv) as integer
			set targetW to (item 7 of argv) as integer
			set targetH to (item 8 of argv) as integer
			try
				if value of attribute "AXFullScreen" of docWin then
					set value of attribute "AXFullScreen" of docWin to false
					delay 0.8
				end if
			end try
			set position of docWin to {targetX + 40, targetY + 40}
			delay 0.3
		end if
		set sw to missing value
		repeat with attempt from 1 to 3
			set frontmost of p to true
			delay 0.4
			if not my playEnabled(p) then
				delay 0.8
				if not my playEnabled(p) then error "WPS Office is busy. Close any open dialog or slideshow in WPS and try again."
			end if
			try
				click menu item "Play" of menu 1 of menu bar item "Slide Show" of menu bar 1 of p
			on error
				keystroke return using {shift down}
			end try
			repeat 25 times
				set sw to my showWindow(p)
				if sw is not missing value then exit repeat
				delay 0.15
			end repeat
			if sw is not missing value then exit repeat
			delay 0.6
		end repeat
		if sw is missing value then error "WPS Office did not start the slideshow"
		if startN > 1 then
			-- Wait for the show window to hold keyboard focus and the fullscreen animation to finish,
			-- otherwise the typed slide number is lost.
			repeat 20 times
				try
					if value of attribute "AXFocused" of sw then exit repeat
				end try
				try
					if (value of attribute "AXFocusedWindow" of p) is sw then exit repeat
				end try
				delay 0.1
			end repeat
			delay 1
			set frontmost of p to true
			keystroke (startN as text)
			delay 0.1
			key code 36
		end if
		if routeIt then
			set {showX, showY} to position of sw
			if showX < targetX or showX >= targetX + targetW or showY < targetY or showY >= targetY + targetH then
				try
					set value of attribute "AXFullScreen" of sw to false
					delay 0.8
				end try
				set position of sw to {targetX, targetY}
				set size of sw to {targetW, targetH}
				delay 0.3
				try
					set value of attribute "AXFullScreen" of sw to true
				end try
			end if
		end if
	end tell
	return "ok"
end run`;

const WPS_NAV = `${WPS_HELPERS}
on run argv
	set p to my wpsProc()
	if not my focusShow(p) then return "no show"
	tell application "System Events"
		if item 1 of argv is "next" then
			key code 124
		else
			key code 123
		end if
	end tell
end run`;

const WPS_CLOSE = `
on run argv
	tell application "System Events"
		if not (exists (${WPS_PROC})) then return
		set p to ${WPS_PROC}
		set frontmost of p to true
		repeat with n in argv
			try
				click (first menu item of menu 1 of menu bar item "Window" of menu bar 1 of p whose name ends with (" " & (contents of n)))
				delay 0.4
				if name of window 1 of p is (contents of n) then
					click menu item "Close" of menu 1 of menu bar item "File" of menu bar 1 of p
					delay 0.6
					try
						click (first button of sheet 1 of window 1 of p whose name starts with "Don")
					end try
				end if
			end try
		end repeat
	end tell
end run`;

function names(file) {
  const fileName = path.basename(file);
  return [fileName, path.basename(file, path.extname(file))];
}

async function fire(app, { file, startSlide = 1, auto = true, bounds = null }) {
  if (app === 'wps') {
    if (auto) await osa(WPS_STOP, [], 15000).catch(() => {});
    await openWithLaunchServices(APPS.wps.bundle, file);
    const b = bounds || { x: 0, y: 0, width: 0, height: 0 };
    return osa(WPS_FIRE, [path.basename(file), startSlide, auto ? '1' : '0', bounds ? '1' : '0', b.x, b.y, b.width, b.height]);
  }
  if (app === 'powerpoint') {
    await openWithLaunchServices(APPS.powerpoint.bundle, file);
    const [fileName, baseName] = names(file);
    const route = auto && bounds ? '1' : '0';
    const b = bounds || { x: 0, y: 0, width: 0, height: 0 };
    return osa(PPT_FIRE, [file, fileName, baseName, startSlide, auto ? '1' : '0', route, b.x, b.y, b.width, b.height]);
  }
  return osa(KN_FIRE, [file, startSlide, auto ? '1' : '0']);
}

const SCRIPTS = {
  powerpoint: { stop: PPT_STOP, nav: PPT_NAV, close: PPT_CLOSE },
  keynote: { stop: KN_STOP, nav: KN_NAV, close: KN_CLOSE },
  wps: { stop: WPS_STOP, nav: WPS_NAV, close: WPS_CLOSE },
};

function stop(app) {
  if (!isInstalled(app)) return Promise.resolve();
  return osa(SCRIPTS[app].stop, [], 15000);
}

function nav(app, dir) {
  return osa(SCRIPTS[app].nav, [dir], 10000);
}

function close(app, file) {
  if (!isInstalled(app)) return Promise.resolve();
  return osa(SCRIPTS[app].close, app === 'wps' ? [path.basename(file)] : names(file), 15000);
}

module.exports = { APPS, PPT_APP_PREFERENCE, isInstalled, needsAccessibility, fire, stop, nav, close };
