// Loads the app's non-UI modules into Node (they attach to globalThis.STA).
const path = require('path');
const root = path.join(__dirname, '..', '..', 'js');
for (const f of ['core/util', 'io/yaml-lite', 'io/ibt', 'io/lmu', 'io/recorder', 'data/car-limits', 'model/setup', 'model/session', 'analysis/handling', 'analysis/pace', 'analysis/advisor', 'analysis/technique', 'analysis/learning', 'analysis/baseline', 'store/library', 'store/folders']) {
  require(path.join(root, f + '.js'));
}
module.exports = globalThis.STA;
