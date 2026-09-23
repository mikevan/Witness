/**
 * Witness under Vitest. Loaded through `test.setupFiles` in the wrapper config
 * a tool generates per run, beside the Witness Vite plugin that does the
 * instrumenting. The plugin cannot deliver the runtime here the way it does for
 * Playwright: a Vitest run under node or jsdom has no page, so there is no
 * `transformIndexHtml` to inject into. This file loads it instead.
 *
 * It must be first in `setupFiles`. A project's own setup file often lives
 * under the source root, which means it is instrumented, and an instrumented
 * module calls the runtime in its prologue. Merged in after the project's, this
 * file loads too late and the run dies on `reading 'file' of undefined`.
 *
 * The runtime is found through WITNESS_HOOKS_DIR and not by a relative import,
 * because a bundling runner (the Angular builder) rewrites import.meta.url, and
 * a relative path would then point into the bundle rather than at the hook.
 *
 * The test id is the one every other hook writes: "<test file relative to the
 * working directory>::<full test name>", so one reader understands them all.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';

const require = createRequire(import.meta.url);
const hooksDir = process.env.WITNESS_HOOKS_DIR;
const witness = require(hooksDir ? path.join(hooksDir, 'witness.cjs') : './witness.cjs');

// A recorded run needs the boundary runtime in the worker before the rewritten
// function is loaded, for the same reason the counter runtime has to be here:
// the plugin instruments in Vite's process, and this is the only hook that runs
// in the process the code runs in. It is a separate global and a separate file,
// so an ordinary measured run never loads it.
if (process.env.WITNESS_BOUNDARY_TARGET && hooksDir) {
  require(path.join(hooksDir, 'witness-boundary.cjs'));
}

function testId() {
  const state = expect.getState();
  const file = state.testPath ? path.relative(process.cwd(), state.testPath).split(path.sep).join('/') : '?';
  return `${file}::${state.currentTestName || '?'}`;
}

beforeEach(() => witness.begin(testId()));
afterEach(() => witness.end());

// The loader writes the whole-run report at process exit; under Vitest there is
// no loader and a worker may end without one, so the report is written when a
// test file finishes. The name is discriminated by the test file, not by a
// counter: Vitest gives each test file a fresh module registry, so a counter
// here resets every time and every file would write over the last one, which
// measured as zero hits for every file but the last. The reset afterwards makes
// each report a delta, which keeps the driver's sum correct when a worker is
// reused without isolation.
const coverageDir = process.env.WITNESS_COVERAGE_DIR;

function slug(file) {
  let h = 0;
  for (let i = 0; i < file.length; i += 1) {
    h = (h * 31 + file.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

afterAll(() => {
  if (!coverageDir) {
    return;
  }
  const state = expect.getState();
  const file = state.testPath ? path.relative(process.cwd(), state.testPath).split(path.sep).join('/') : 'unknown';
  witness.writeReport(coverageDir, `coverage-${witness.workerTag()}-${slug(file)}.json`);
  witness.reset();
});
