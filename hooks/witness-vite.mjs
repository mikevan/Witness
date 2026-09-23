/**
 * Witness as a Vite plugin, for runners that build the code under test with
 * Vite and run it in a browser page (Playwright component tests). Every
 * source under the source root is instrumented as Vite transforms it, with
 * its maps embedded, and the Witness runtime is injected into the page's
 * HTML ahead of every module, so `window.__witness__` exists before the
 * first counter fires. Nothing is installed in the project: the plugin,
 * the runtime, and the instrumenter all come from the tool's hooks folder.
 *
 * With WITNESS_BOUNDARY_TARGET set this does the other job instead: a
 * recorded run, where exactly one function in exactly one file is rewritten
 * for UntangleIt's behaviour gate and every other file is served as
 * written. Counting lines is not the question then, and instrumenting a
 * whole project to watch one method would change far more than it measured.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// Vite hands `transform` module ids with forward slashes on every platform,
// while path.resolve on Windows answers with backslashes. Comparing the two
// directly meant nothing under the source root ever matched on Windows, the
// plugin instrumented nothing, and the run still passed with an empty report.
// Both sides are normalised, so the comparison is the same everywhere.
const toPosix = (p) => p.split('\\').join('/');
const SOURCE = /\.(m?[jt]sx?|c[jt]s)$/;
const SKIP = /[\\/](node_modules|\.deeptest|\.untangleit|playwright)[\\/]|\.(test|spec|ct)\.[cm]?[jt]sx?$|[\\/]__tests__[\\/]|\.d\.ts$/;

/**
 * @param {{ hooksDir?: string; wasmDir: string; sourceRoot: string }} options
 */
const unmeasured = new Map();

function noteUnmeasured(file, reason) {
  const dir = process.env.WITNESS_COVERAGE_DIR;
  if (!dir) {
    return;
  }
  unmeasured.set(file, String(reason || 'Witness could not instrument it.'));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const list = Array.from(unmeasured, ([p, r]) => ({ path: p, reason: r }));
    fs.writeFileSync(path.join(dir, `unmeasured-vite-${process.pid}.json`), JSON.stringify(list));
  } catch {
    // never fail the build over the note
  }
}

export function witnessPlugin(options) {
  const hooksDir = options.hooksDir || here;
  const { parseBoundaryTarget } = require(path.join(hooksDir, 'witness-instrument.cjs'));
  const boundaryTarget = parseBoundaryTarget(process.env.WITNESS_BOUNDARY_TARGET);
  const boundaryRuntime = boundaryTarget ? require(path.join(hooksDir, 'witness-boundary.cjs')) : undefined;
  const boundaryName = boundaryTarget ? `${boundaryTarget.container ? `${boundaryTarget.container}.` : ''}${boundaryTarget.name}` : '';
  let boundarySeen = false;
  const sourceRoot = toPosix(path.resolve(options.sourceRoot));
  const runtimeSource = fs.readFileSync(path.join(hooksDir, 'witness.cjs'), 'utf8');
  let instrumenter;
  return {
    name: 'witness',
    enforce: 'pre',
    async buildStart() {
      const { createInstrumenter } = require(path.join(hooksDir, 'witness-instrument.cjs'));
      instrumenter = await createInstrumenter(options.wasmDir);
    },
    buildEnd() {
      if (boundaryTarget && !boundarySeen) {
        // The file was never built, so the rewrite never happened. Silence
        // would read as a method the tests did not reach, which is a
        // different answer from one the recorder never got near.
        boundaryRuntime.problem('target-not-found', boundaryName);
      }
    },
    transform(code, id) {
      const file = toPosix(id.split('?')[0]);
      if (!instrumenter) {
        return null;
      }
      if (boundaryTarget) {
        if (file !== boundaryTarget.file) {
          return null;
        }
        // Seen, whatever comes of it. Only a file the build never reached
        // still needs reporting at the end.
        boundarySeen = true;
        try {
          const out = instrumenter.instrumentBoundary(file, code, { name: boundaryTarget.name, container: boundaryTarget.container });
          if (!out.ok) {
            boundaryRuntime.problem('target-not-found', boundaryName);
            return null;
          }
          return { code: out.code, map: null };
        } catch (err) {
          boundaryRuntime.problem('target-not-found', boundaryName);
          this.warn(`Witness could not record ${file}: ${err && err.message}`);
          return null;
        }
      }
      if (!file.startsWith(sourceRoot) || !SOURCE.test(file) || SKIP.test(file)) {
        return null;
      }
      try {
        const out = instrumenter.instrument(file, code, true);
        // Every line is where it was; columns moved. No map is right: Vite then
        // treats the output as line-aligned with the input, which it is.
        return { code: out.code, map: null };
      } catch (err) {
        // The file is served as written. It is written down beside the
        // reports so the driver shows it as unmeasured, not as measured at
        // zero. The plugin runs in Vite's process, which has no runtime, so
        // it writes the file itself, one per process, like the reports.
        this.warn(`Witness could not instrument ${file}: ${err && err.message}`);
        noteUnmeasured(file, err && err.message);
        return null;
      }
    },
    transformIndexHtml() {
      const scripts = [{ tag: 'script', injectTo: 'head-prepend', children: runtimeSource }];
      if (boundaryTarget) {
        // A recorded run in a page: the boundary runtime has to be there
        // before the rewritten module evaluates, and it holds its records
        // because a page has no disk. The fixture drains them afterwards.
        scripts.push({ tag: 'script', injectTo: 'head-prepend', children: fs.readFileSync(path.join(hooksDir, 'witness-boundary.cjs'), 'utf8') });
      }
      return scripts;
    },
  };
}
