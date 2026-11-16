// Windows driver: PowerPoint and WPS Office through COM automation, run in Windows PowerShell 5.1
// (powershell.exe, which ships with Windows and has Marshal.GetActiveObject). Values are passed in
// DC_* environment variables, never interpolated into script text.
//
// WPS Presentation exposes a PowerPoint-compatible object model under its own ProgIDs.
const { execFile, execFileSync } = require('child_process');
const { screen } = require('electron');

const APPS = {
  powerpoint: { name: 'Microsoft PowerPoint', short: 'PPT', progIds: ['PowerPoint.Application'] },
  wps: { name: 'WPS Office', short: 'WPS', progIds: ['KWPP.Application', 'WPP.Application'] },
};
const PPT_APP_PREFERENCE = ['powerpoint', 'wps'];

const installedCache = {};
function isInstalled(app) {
  if (!APPS[app]) return false;
  if (app in installedCache) return installedCache[app];
  installedCache[app] = APPS[app].progIds.some((id) => {
    try {
      execFileSync('reg', ['query', `HKCR\\${id}\\CLSID`], { stdio: 'ignore', timeout: 4000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  });
  return installedCache[app];
}

// COM needs no extra permission on Windows.
const needsAccessibility = () => false;

function ps(script, env = {}, timeout = 60000) {
  const full = `$ErrorActionPreference = 'Stop'\n${PRELUDE}\n${script}`;
  // -EncodedCommand (UTF-16LE base64) runs the script as one block; piping to "-Command -" runs it
  // line by line, which breaks multi-line statements.
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(cleanError(stderr || err.message)));
        resolve(stdout.trim());
      },
    );
  });
}

function cleanError(msg) {
  const lines = String(msg).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => !l.startsWith('At line:') && !l.startsWith('+')) || lines[0] || 'Unknown error';
  return first.replace(/^Exception calling "[^"]+" with "\d+" argument\(s\): /, '').replace(/^"|"$/g, '');
}

// Get-App returns the running instance, or (with -Create) starts one.
const PRELUDE = `
function Get-App([string[]]$ProgIds, [switch]$Create) {
  foreach ($id in $ProgIds) { try { return [Runtime.InteropServices.Marshal]::GetActiveObject($id) } catch {} }
  if ($Create) { foreach ($id in $ProgIds) { try { return New-Object -ComObject $id } catch {} } }
  return $null
}
function Exit-Shows($app) {
  for ($i = 0; $i -lt 10 -and $app.SlideShowWindows.Count -gt 0; $i++) {
    try { $app.SlideShowWindows.Item(1).View.Exit() } catch { break }
    Start-Sleep -Milliseconds 150
  }
}
$progIds = $env:DC_PROGIDS -split ','`;

const FIRE = `
$app = Get-App $progIds -Create
if (-not $app) { throw "Could not start the presentation app" }
try { $app.Visible = -1 } catch {}
if ($env:DC_AUTO -eq '1') { Exit-Shows $app }
$pres = $null
foreach ($p in $app.Presentations) { if ($p.FullName -eq $env:DC_FILE) { $pres = $p } }
# Open read-only, so a show never locks or modifies the file.
if (-not $pres) { $pres = $app.Presentations.Open($env:DC_FILE, -1, 0, -1) }
if ($env:DC_AUTO -ne '1') { try { $pres.Windows.Item(1).Activate() } catch {}; 'opened'; return }
if ($env:DC_MONITOR) {
  # PowerPoint reads the slide show monitor from this key when a show starts.
  foreach ($v in '16.0', '15.0') {
    $k = "HKCU:\\Software\\Microsoft\\Office\\$v\\PowerPoint\\Options"
    if (Test-Path $k) { Set-ItemProperty -Path $k -Name DisplayMonitor -Value $env:DC_MONITOR }
  }
}
$ss = $pres.SlideShowSettings
$n = $pres.Slides.Count
if ($n -gt 0) {
  $start = [Math]::Min([Math]::Max(1, [int]$env:DC_START), $n)
  $ss.RangeType = 2          # ppShowSlideRange
  $ss.StartingSlide = $start
  $ss.EndingSlide = $n
}
$ss.ShowType = 1             # ppShowTypeSpeaker (fullscreen)
[void]$ss.Run()
try { $app.SlideShowWindows.Item(1).Activate() } catch {}
'ok'`;

const STOP = `
$app = Get-App $progIds
if ($app) { Exit-Shows $app }`;

const NAV = `
$app = Get-App $progIds
if (-not $app -or $app.SlideShowWindows.Count -eq 0) { 'no show'; return }
$view = $app.SlideShowWindows.Item(1).View
if ($env:DC_DIR -eq 'next') { $view.Next() } else { $view.Previous() }`;

const CLOSE = `
$app = Get-App $progIds
if (-not $app) { return }
foreach ($p in @($app.Presentations)) {
  if ($p.FullName -eq $env:DC_FILE) {
    foreach ($w in @($app.SlideShowWindows)) { if ($w.Presentation.FullName -eq $env:DC_FILE) { try { $w.View.Exit() } catch {} } }
    $p.Saved = -1
    $p.Close()
  }
}`;

// "slide/total" while a show is running, "" otherwise.
const POSITION = `
$app = Get-App $progIds
if ($app -and $app.SlideShowWindows.Count -gt 0) {
  $w = $app.SlideShowWindows.Item(1)
  "{0}/{1}" -f $w.View.CurrentShowPosition, $w.Presentation.Slides.Count
}`;

// "open" while the deck is open (or any show is running), "gone" when the app has quit or the deck was closed.
const ALIVE = `
$app = Get-App $progIds
if (-not $app) { 'gone'; return }
if ($app.SlideShowWindows.Count -gt 0) { 'open'; return }
$name = [IO.Path]::GetFileName($env:DC_FILE)
foreach ($p in @($app.Presentations)) { if ($p.FullName -eq $env:DC_FILE -or $p.Name -eq $name) { 'open'; return } }
'gone'`;

const GOTO = `
$app = Get-App $progIds
if (-not $app -or $app.SlideShowWindows.Count -eq 0) { 'no show'; return }
$app.SlideShowWindows.Item(1).View.GotoSlide([int]$env:DC_SLIDE)`;

// One long-running PowerShell for the once-a-second position poll (starting powershell.exe every second
// would cost far too much CPU). Each request is one line: the script, base64-encoded, then an end marker.
const END = '__DECKCUE_END__';
let host = null;
let hostBusy = Promise.resolve();

function startHost() {
  const proc = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true });
  const h = { proc, buffer: '', waiters: [] };
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    h.buffer += chunk;
    let i;
    while ((i = h.buffer.indexOf(END)) >= 0) {
      const out = h.buffer.slice(0, i);
      h.buffer = h.buffer.slice(i + END.length).replace(/^\r?\n/, '');
      const w = h.waiters.shift();
      if (w) w(out.trim());
    }
  });
  proc.on('exit', () => { if (host === h) host = null; h.waiters.splice(0).forEach((w) => w('')); });
  proc.stdin.on('error', () => {});
  return h;
}

function hostRun(script, timeout = 5000) {
  const run = () => new Promise((resolve) => {
    if (!host) host = startHost();
    const h = host;
    const timer = setTimeout(() => { h.proc.kill(); resolve(''); }, timeout);
    h.waiters.push((out) => { clearTimeout(timer); resolve(out); });
    const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\ntry {\n${PRELUDE}\n${script}\n} catch { '' }`, 'utf16le').toString('base64');
    h.proc.stdin.write(`iex ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))); Write-Output '${END}'\n`);
  });
  hostBusy = hostBusy.then(run, run);
  return hostBusy;
}

async function position(app) {
  if (!APPS[app] || !isInstalled(app)) return null;
  const out = await hostRun(`$env:DC_PROGIDS = '${APPS[app].progIds.join(',')}'\n$progIds = $env:DC_PROGIDS -split ','\n${POSITION}`);
  const m = /(\d+)\/(\d+)\s*$/.exec(out);
  return m && Number(m[1]) > 0 ? { slide: Number(m[1]), slides: Number(m[2]) } : null;
}

// true: still open. false: closed by hand or the app has quit. null: cannot tell.
async function alive(app, file) {
  if (!APPS[app] || !isInstalled(app)) return null;
  const quoted = String(file).replace(/'/g, "''");
  const out = await hostRun(`$env:DC_PROGIDS = '${APPS[app].progIds.join(',')}'\n$progIds = $env:DC_PROGIDS -split ','\n$env:DC_FILE = '${quoted}'\n${ALIVE}`);
  return /open\s*$/.test(out) ? true : /gone\s*$/.test(out) ? false : null;
}

function goto(app, n) {
  if (!APPS[app]) return Promise.resolve(false);
  return ps(GOTO, env(app, { DC_SLIDE: String(n) }), 10000).then(() => true, () => false);
}

// Windows device names (\\\\.\\DISPLAY2) with their physical-pixel bounds, read DPI-aware so they
// line up with Electron's screen.dipToScreenRect().
const MONITORS = `
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DcDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][DcDpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) { "{0}|{1}|{2}" -f $s.DeviceName, $s.Bounds.X, $s.Bounds.Y }`;

async function monitorFor(bounds) {
  const rect = screen.dipToScreenRect(null, bounds);
  const out = await ps(MONITORS, { DC_PROGIDS: '' }, 15000);
  for (const line of out.split(/\r?\n/)) {
    const [name, x, y] = line.trim().split('|');
    if (Number(x) === rect.x && Number(y) === rect.y) return name;
  }
  return '';
}

const env = (app, extra) => ({ DC_PROGIDS: APPS[app].progIds.join(','), ...extra });

async function fire(app, { file, startSlide = 1, auto = true, bounds = null }) {
  // Only PowerPoint has a known setting for the slide show monitor; WPS uses its own choice.
  const monitor = auto && bounds && app === 'powerpoint' ? await monitorFor(bounds).catch(() => '') : '';
  return ps(FIRE, env(app, { DC_FILE: file, DC_START: String(startSlide), DC_AUTO: auto ? '1' : '0', DC_MONITOR: monitor }));
}

function stop(app) {
  if (!isInstalled(app)) return Promise.resolve();
  return ps(STOP, env(app), 15000);
}

function nav(app, dir) {
  return ps(NAV, env(app, { DC_DIR: dir }), 10000);
}

function close(app, file) {
  if (!isInstalled(app)) return Promise.resolve();
  return ps(CLOSE, env(app, { DC_FILE: file }), 15000);
}

module.exports = { APPS, PPT_APP_PREFERENCE, isInstalled, needsAccessibility, fire, stop, nav, close, position, goto, alive };
// For scripts/check-win-driver.js (CI on a Windows runner).
module.exports._test = { ps, hostRun, scripts: { FIRE, STOP, NAV, CLOSE, MONITORS, POSITION, GOTO, ALIVE }, PRELUDE };
