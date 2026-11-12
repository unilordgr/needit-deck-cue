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
  process.exit(failed ? 1 : 0);
})();
