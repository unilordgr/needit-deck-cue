// One codebase, two apps. The packaged Command Center has deckcueMode "center" in its package.json
// (see builder-center.json); in development start it with: electron . --center
const pkg = require('../package.json');

const center = pkg.deckcueMode === 'center' || process.argv.includes('--center');
require(center ? './center/main' : './main');
