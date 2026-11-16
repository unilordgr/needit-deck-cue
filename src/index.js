// needit Deck Cue and needit Command Center
// Copyright (C) 2026 needit Creative (https://needitcreative.com)
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version. It comes with no warranty. See LICENSE.

// One codebase, two apps. The packaged Command Center has deckcueMode "center" in its package.json
// (see builder-center.json); in development start it with: electron . --center
const pkg = require('../package.json');

const center = pkg.deckcueMode === 'center' || process.argv.includes('--center');
require(center ? './center/main' : './main');
