/**
 * Witness under Karma: the Karma plugin the generated config loads.
 *
 * Two halves. The framework puts two scripts in front of the specs, in order:
 * the runtime, so `globalThis.__witness__` exists before any instrumented
 * module evaluates its prologue, and the client, which puts the test boundary
 * on Jasmine. The reporter receives what the client sends and writes it where
 * every other hook writes it, so the driver reads Karma with the same reader
 * it reads Vitest and Jest with.
 *
 * This exists as a Karma plugin, rather than as a setup file, because the
 * `@angular/build:unit-test` builder ignores `setupFiles` for the Karma runner
 * and says so in a warning. What it does support is `runnerConfig`, a path to
 * a Karma config; the driver generates one that wraps the project's own and
 * adds this plugin. That is the only hook the runner offers, and it is enough.
 *
 * The records arrive already in source coordinates, so the reporter writes
 * them through untouched: no statement maps cross the wire and no source map
 * is consulted. The whole-run counters arrive once, when Jasmine finishes, and
 * are written as the Istanbul-shaped report the driver already reads.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const attributionDir = process.env.WITNESS_ATTRIBUTION_DIR;
const coverageDir = process.env.WITNESS_COVERAGE_DIR;
const attributionFile = attributionDir ? path.join(attributionDir, `attr-witness-karma-${process.pid}.jsonl`) : undefined;
const boundaryDir = process.env.WITNESS_BOUNDARY_DIR;
const boundaryFile = boundaryDir ? path.join(boundaryDir, `boundary-karma-${process.pid}.jsonl`) : undefined;

function framework(files) {
  // Unshifted, not pushed: Jasmine's own framework has already put itself at
  // the front, and the runtime must precede the bundle rather than the
  // adapter. Both are served as classic scripts; witness.cjs guards its
  // Node-only requires on `process`, so it loads in a page as written.
  files.push({ pattern: path.join(__dirname, 'witness.cjs'), included: true, served: true, watched: false });
  if (process.env.WITNESS_BOUNDARY_TARGET) {
    // A recorded run: the boundary runtime goes in the page too, before the
    // bundle, because the rewritten function calls it as soon as it is
    // entered. It guards its Node-only requires, so it loads in a page as
    // written, and it holds its records for the client to carry back.
    files.push({ pattern: path.join(__dirname, 'witness-boundary.cjs'), included: true, served: true, watched: false });
  }
  files.push({ pattern: path.join(__dirname, 'witness-karma-client.js'), included: true, served: true, watched: false });
}
framework.$inject = ['config.files'];

function reporter(emitter) {
  emitter.on('browser_info', (_browser, info) => {
    const message = info && info.witness;
    if (!message) {
      return;
    }
    try {
      if (message.record && attributionFile) {
        fs.appendFileSync(attributionFile, `${JSON.stringify(message.record)}\n`);
      }
      if (message.boundary && message.boundary.length && boundaryFile) {
        fs.mkdirSync(boundaryDir, { recursive: true });
        fs.appendFileSync(boundaryFile, `${message.boundary.map((r) => JSON.stringify(r)).join('\n')}\n`);
      }
      if (message.coverage && coverageDir) {
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, `coverage-karma-${process.pid}.json`), JSON.stringify(message.coverage));
      }
    } catch {
      // Never fail the user's tests over attribution.
    }
  });
}
reporter.$inject = ['emitter'];

module.exports = {
  'framework:witness': ['factory', framework],
  'reporter:witness': ['type', reporter],
};
