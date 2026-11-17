// Runs on a Windows CI runner: parses every PowerShell script of the Windows driver, then runs the
// ones that are safe without PowerPoint/WPS (through the same -EncodedCommand path the app uses).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _test } = require('../src/drivers/win');

let failed = false;
for (const [name, body] of Object.entries(_test.scripts)) {
  const file = path.join(os.tmpdir(), `deckcue-${name}.ps1`);
  fs.writeFileSync(file, `${_test.PRELUDE}\n${body}`);
  const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', check], { stdio: 'pipe' });
    console.log(`parse ok   ${name}`);
  } catch (e) {
    failed = true;
    console.log(`PARSE FAIL ${name}\n${e.stdout}`);
  }
}

(async () => {
  const env = { DC_PROGIDS: 'PowerPoint.Application,KWPP.Application' };
  for (const [name, extra] of [['STOP', {}], ['NAV', { DC_DIR: 'next' }], ['CLOSE', { DC_FILE: 'C:\\nope.pptx' }], ['MONITORS', {}]]) {
    try {
      const out = await _test.ps(_test.scripts[name], { ...env, ...extra }, 60000);
      console.log(`run ok     ${name}${out ? ` -> ${out.replace(/\r?\n/g, ' ; ')}` : ''}`);
    } catch (e) {
      failed = true;
      console.log(`RUN FAIL   ${name}: ${e.message}`);
    }
  }
  // Default audio output (Core Audio through inline C#). A CI runner may have no audio device: empty is fine.
  try {
    const { WIN_AUDIO } = require('../src/showmode')._test;
    const encoded = Buffer.from(WIN_AUDIO, 'utf16le').toString('base64');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: 'pipe' }).toString().trim();
    console.log(`run ok     AUDIO -> ${JSON.stringify(out)}`);
  } catch (e) {
    failed = true;
    console.log(`RUN FAIL   AUDIO: ${(e.stderr || e.message).toString().slice(0, 400)}`);
  }
  // The long-running PowerShell used for the once-a-second slide poll.
  try {
    const echo = await _test.hostRun("'hello'");
    const pos = await _test.hostRun(`$env:DC_PROGIDS = 'PowerPoint.Application'\n$progIds = $env:DC_PROGIDS -split ','\n${_test.scripts.POSITION}`);
    const again = await _test.hostRun("1 + 1");
    // "Is the deck still open?" with no PowerPoint running must say gone, not fail.
    const alive = await _test.hostRun(`$env:DC_PROGIDS = 'PowerPoint.Application'\n$progIds = $env:DC_PROGIDS -split ','\n$env:DC_FILE = 'C:\\nowhere\\it''s gone.pptx'\n${_test.scripts.ALIVE}`);
    // Next / previous slide goes through the same PowerShell. With nothing showing it must answer, not fail.
    const nav = await _test.hostRun(`$env:DC_PROGIDS = 'PowerPoint.Application'\n$progIds = $env:DC_PROGIDS -split ','\n$env:DC_DIR = 'next'\n${_test.scripts.NAV}`);
    if (echo !== 'hello' || again !== '2' || alive !== 'gone' || nav !== 'no show') throw new Error(`unexpected output ${JSON.stringify([echo, pos, again, alive, nav])}`);
    console.log(`host ok     echo, POSITION -> ${JSON.stringify(pos)}, ALIVE -> ${alive}, NAV -> ${nav}, reuse`);
  } catch (e) {
    failed = true;
    console.log(`HOST FAIL   ${e.message}`);
  }
  process.exit(failed ? 1 : 0);
})();
