// Runs the helper scripts that finish an update (src/update-scripts.js) against throwaway files, on the system
// this is run on: the portable .exe replacement on Windows, the app swap on macOS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PORTABLE_BAT, MAC_SWAP } = require('../src/update-scripts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'needit update test '));
const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

if (process.platform === 'win32') {
  // A path with a space, an ampersand and a percent sign: the things that break batch files.
  const folder = path.join(dir, 'Show & Tell 100%');
  fs.mkdirSync(folder);
  const cur = path.join(folder, 'needit Deck Cue.exe');
  const next = path.join(folder, 'new build.exe');
  fs.writeFileSync(cur, 'old');
  fs.writeFileSync(next, 'new');
  const bat = path.join(dir, 'update.bat');
  fs.writeFileSync(bat, PORTABLE_BAT, 'ascii');
  const r = spawnSync('cmd.exe', ['/c', bat], { env: { ...process.env, NEW_EXE: next, CUR_EXE: cur, RELAUNCH: '0' }, timeout: 60000 });
  if (r.status !== 0) fail(`the batch file ended with ${r.status}: ${r.stderr}`);
  if (fs.readFileSync(cur, 'utf8') !== 'new') fail('the old file was not replaced');
  if (fs.existsSync(next)) fail('the downloaded file was left behind');
  if (fs.existsSync(bat)) fail('the batch file did not remove itself');
  console.log('ok    portable update: the file was replaced, nothing left behind');

  // The real case: the old .exe is still locked for a few seconds while the app closes. The script must wait
  // and try again, without a console (that is how the app starts it).
  fs.writeFileSync(cur, 'old');
  fs.writeFileSync(next, 'newer');
  fs.writeFileSync(bat, PORTABLE_BAT, 'ascii');
  const { spawn } = require('child_process');
  const lock = spawn('powershell.exe', ['-NoProfile', '-Command', "$f = [IO.File]::Open($env:LOCK_FILE, 'Open', 'ReadWrite', 'None'); 'locked'; Start-Sleep -Seconds 4; $f.Close()"], { env: { ...process.env, LOCK_FILE: cur }, stdio: ['ignore', 'pipe', 'ignore'] });
  const locked = spawnSync('powershell.exe', ['-NoProfile', '-Command', "for ($i = 0; $i -lt 50; $i++) { try { $f = [IO.File]::Open($env:LOCK_FILE, 'Open', 'ReadWrite', 'None'); $f.Close(); Start-Sleep -Milliseconds 200 } catch { 'locked'; break } }"], { env: { ...process.env, LOCK_FILE: cur }, encoding: 'utf8' });
  if (!/locked/.test(locked.stdout || '')) fail('could not lock the test file');
  const started = Date.now();
  const r2 = spawnSync('cmd.exe', ['/c', bat], { env: { ...process.env, NEW_EXE: next, CUR_EXE: cur, RELAUNCH: '0' }, timeout: 90000, stdio: 'ignore', windowsHide: true });
  lock.kill();
  if (r2.status !== 0) fail(`with the file locked, the batch file ended with ${r2.status}`);
  if (fs.readFileSync(cur, 'utf8') !== 'newer') fail('with the file locked, it gave up instead of waiting');
  if (Date.now() - started < 1500) fail('it did not wait for the lock');
  console.log(`ok    portable update: waited ${Math.round((Date.now() - started) / 100) / 10} s for the locked file, then replaced it`);
} else if (process.platform === 'darwin') {
  const app = path.join(dir, 'needit Deck Cue.app');
  const stage = `${app}.update`;
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'version'), 'old');
  fs.writeFileSync(path.join(stage, 'Contents', 'version'), 'new');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, MAC_SWAP, { mode: 0o700 });
  // APP_PID is a process that has already ended, so the script does not wait.
  const done = spawnSync('/usr/bin/true');
  const r = spawnSync('/bin/sh', [script], { env: { PATH: '/usr/bin:/bin', APP_PID: String(done.pid), APP_PATH: app, STAGE: stage, RELAUNCH: '0' }, timeout: 90000 });
  if (r.status !== 0) fail(`the script ended with ${r.status}: ${r.stderr}`);
  if (fs.readFileSync(path.join(app, 'Contents', 'version'), 'utf8') !== 'new') fail('the app was not swapped');
  if (fs.existsSync(stage) || fs.existsSync(`${app}.old`)) fail('a staging or old copy was left behind');
  // A swap that cannot happen (nothing staged) must leave the app where it was.
  const r2 = spawnSync('/bin/sh', [script], { env: { PATH: '/usr/bin:/bin', APP_PID: String(done.pid), APP_PATH: app, STAGE: stage, RELAUNCH: '0' }, timeout: 90000 });
  if (r2.status !== 0 || !fs.existsSync(path.join(app, 'Contents', 'version'))) fail('a failed swap lost the app');
  console.log('ok    macOS update: the app was swapped, a failed swap keeps the old app');
} else {
  console.log('skip  no update helper for this system');
}
fs.rmSync(dir, { recursive: true, force: true });
