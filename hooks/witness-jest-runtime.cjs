/**
 * Witness under Jest: the runtime, loaded first in `setupFiles`.
 *
 * It has to be first, and it has to be in setupFiles rather than
 * setupFilesAfterEnv, because an instrumented module calls the runtime in its
 * prologue and a project's own setup file may import source. setupFiles run
 * before the test framework and before anything the test file pulls in, so
 * loading here means the runtime exists whenever the first counter fires.
 *
 * Jest gives every test file its own module registry and its own global, so
 * this runs once per test file and `globalThis.__witness__` is fresh each
 * time. That is why the driver instruments with the maps embedded: each
 * instrumented module registers itself with whatever runtime it lands beside,
 * rather than depending on a registration that happened in another sandbox.
 */
'use strict';
const path = require('node:path');

const hooksDir = process.env.WITNESS_HOOKS_DIR;
require(hooksDir ? path.join(hooksDir, 'witness.cjs') : './witness.cjs');

// A recorded run needs the boundary runtime here too, and for the same
// reason: the rewritten function calls it as soon as it is entered, and Jest
// hands every test file a fresh global. It is a separate global and a
// separate record file, so an ordinary measured run never loads it.
if (process.env.WITNESS_BOUNDARY_TARGET && hooksDir) {
  require(path.join(hooksDir, 'witness-boundary.cjs'));
}
