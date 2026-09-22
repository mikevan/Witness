/**
 * Witness under Jest: the test boundary, loaded in `setupFilesAfterEnv`.
 *
 * The runtime is already in the sandbox (witness-jest-runtime.cjs, loaded
 * from setupFiles); this only tells it which test is running. Test id is the
 * one every other hook writes, "<test file relative to the working
 * directory>::<full test name>", so one reader understands them all.
 *
 * The whole-run counters are written when each test file finishes rather than
 * at process exit. Jest runs each test file in its own environment and throws
 * that environment away afterwards, so waiting for exit would lose every
 * file's counters but the last. The report is named by the test file for the
 * same reason the Vitest hook names it that way, and the reset afterwards
 * makes each report a delta, which keeps the driver's sum right when a worker
 * is reused for a second test file.
 */
'use strict';
const path = require('node:path');

const hooksDir = process.env.WITNESS_HOOKS_DIR;
const witness = require(hooksDir ? path.join(hooksDir, 'witness.cjs') : './witness.cjs');
const coverageDir = process.env.WITNESS_COVERAGE_DIR;

function currentPath() {
  const state = expect.getState();
  return state && state.testPath ? state.testPath : '';
}

function testId() {
  const state = expect.getState();
  const file = state && state.testPath ? path.relative(process.cwd(), state.testPath).split(path.sep).join('/') : '?';
  return `${file}::${(state && state.currentTestName) || '?'}`;
}

function slug(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

beforeEach(() => witness.begin(testId()));
afterEach(() => witness.end());

afterAll(() => {
  if (!coverageDir) {
    return;
  }
  const file = path.relative(process.cwd(), currentPath()).split(path.sep).join('/') || 'unknown';
  witness.writeReport(coverageDir, `coverage-${witness.workerTag()}-${slug(file)}.json`);
  witness.reset();
});
