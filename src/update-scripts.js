// The two small helper scripts that finish an update after the app has closed (used by update.js).
// They live here, without Electron, so scripts/check-update-scripts.js can run them on the build machines.

// The portable .exe cannot be overwritten while it runs. This waits for it to close, copies the new file over
// it and starts it again. Paths arrive through the environment, so odd characters in them cannot break the script.
const PORTABLE_BAT = `@echo off
set TRIES=0
:again
copy /y "%NEW_EXE%" "%CUR_EXE%" >nul 2>&1
if errorlevel 1 (
  set /a TRIES+=1
  if %TRIES% GEQ 40 goto done
  timeout /t 1 /nobreak >nul
  goto again
)
del "%NEW_EXE%" >nul 2>&1
:done
if "%RELAUNCH%"=="1" start "" "%CUR_EXE%"
del "%~f0" >nul 2>&1
`;

// Waits for the running app to quit, then swaps the new app into its place. If the swap fails, the old app is
// put back, so the operator is never left without one.
const MAC_SWAP = `#!/bin/sh
n=0
while kill -0 "$APP_PID" 2>/dev/null && [ "$n" -lt 240 ]; do sleep 0.25; n=$((n+1)); done
OLD="$APP_PATH.old"
rm -rf "$OLD"
if mv "$APP_PATH" "$OLD" && mv "$STAGE" "$APP_PATH"; then
  rm -rf "$OLD"
else
  [ -d "$APP_PATH" ] || mv "$OLD" "$APP_PATH"
fi
rm -rf "$STAGE"
# Start it again the way it was started (the arguments after the script's name).
[ "$RELAUNCH" = "1" ] && /usr/bin/open "$APP_PATH" --args "$@"
exit 0
`;

module.exports = { PORTABLE_BAT, MAC_SWAP };
