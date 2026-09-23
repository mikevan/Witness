/**
 * Witness: the loader. `node --import <this file>` before any runner, and
 * every source under the source root is instrumented as Node loads it,
 * ES module or CommonJS alike, through module.registerHooks (Node 22.15
 * and later; synchronous, in-thread, and it applies to require() as well
 * as import, which the older module.register never did). Test files,
 * node_modules, and the tools' own folders are left alone. At exit the
 * whole-run counters are written as coverage-final.json.
 *
 * Environment, all set by the driver:
 *   WITNESS_HOOKS_DIR        where witness.cjs and witness-instrument.cjs are
 *   WITNESS_WASM_DIR         where the tree-sitter grammars are
 *   WITNESS_SOURCE_ROOT      absolute folder whose files are instrumented
 *   WITNESS_COVERAGE_DIR     where coverage-<pid>.json goes at exit
 *   WITNESS_ATTRIBUTION_DIR  where the per-test records go
 *   WITNESS_BOUNDARY_TARGET  a recorded run: the one function to watch
 *   WITNESS_BOUNDARY_DIR     where a recorded run's observations go
 *
 * A recorded run is the other thing this loader does. With a boundary
 * target set it rewrites exactly that one function in exactly that one
 * file, for UntangleIt's behaviour gate, and leaves every other file alone:
 * counting lines is not the question being asked, and instrumenting a whole
 * project to watch one method would change far more than it measured.
 */
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const hooksDir = process.env.WITNESS_HOOKS_DIR || path.dirname(fileURLToPath(import.meta.url));
const witness = require(path.join(hooksDir, 'witness.cjs'));
const { createInstrumenter, parseBoundaryTarget } = require(path.join(hooksDir, 'witness-instrument.cjs'));
const boundaryTarget = parseBoundaryTarget(process.env.WITNESS_BOUNDARY_TARGET);
const boundaryRuntime = boundaryTarget ? require(path.join(hooksDir, 'witness-boundary.cjs')) : undefined;
let boundarySeen = false;
const sourceRoot = path.resolve(process.env.WITNESS_SOURCE_ROOT || process.cwd());
const coverageDir = process.env.WITNESS_COVERAGE_DIR;
const SOURCE = /\.(m?[jt]sx?|c[jt]s)$/;
const SKIP = /[\\/](node_modules|\.deeptest|\.untangleit)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|[\\/]__tests__[\\/]|\.d\.ts$/;

const instrumenter = await createInstrumenter(process.env.WITNESS_WASM_DIR || hooksDir);

/**
 * A recorded run: one function in one file, and nothing else touched.
 *
 * A name that resolves to no function or to more than one is a question for
 * the caller, never a guess. It is written as a record of its own so the
 * gate reports "could not be found again" rather than reading an empty run
 * as a method no test reached.
 */
function boundary(file, source, result) {
  const posix = file.split(path.sep).join('/');
  if (posix !== boundaryTarget.file) {
    return result;
  }
  // Seen, whatever comes of it. A file that was read and refused has already
  // said why; only a file the run never loaded still needs reporting at exit.
  boundarySeen = true;
  try {
    const out = instrumenter.instrumentBoundary(posix, source, { name: boundaryTarget.name, container: boundaryTarget.container });
    if (!out.ok) {
      boundaryRuntime.problem('target-not-found', `${boundaryTarget.container ? `${boundaryTarget.container}.` : ''}${boundaryTarget.name}`);
      return result;
    }
    // Nothing is injected into the file. The runtime was loaded above, at
    // this loader's own startup, so the global exists before any user module
    // is read; injecting a require() would also have been a syntax error in
    // an ES module, which is half of what this loader handles.
    return { ...result, source: out.code, shortCircuit: true };
  } catch (err) {
    boundaryRuntime.problem('target-not-found', boundaryTarget.name);
    process.stderr.write(`Witness could not record ${file}: ${err && err.message}\n`);
    return result;
  }
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:')) {
      return result;
    }
    const file = fileURLToPath(url);
    if (!file.startsWith(sourceRoot) || !SOURCE.test(file) || SKIP.test(file)) {
      return result;
    }
    // A require()d CommonJS file arrives with no format at all (Node 22);
    // everything else that is a script has one of these.
    const format = result.format;
    if (format !== undefined && format !== 'module' && format !== 'commonjs' && format !== 'module-typescript' && format !== 'commonjs-typescript') {
      return result;
    }
    const source = result.source === undefined || result.source === null ? require('node:fs').readFileSync(file, 'utf8') : String(result.source);
    if (boundaryTarget) {
      return boundary(file, source, result);
    }
    try {
      const out = instrumenter.instrument(file.split(path.sep).join('/'), source);
      witness.register(out.handle, file.split(path.sep).join('/'), out.maps);
      return { ...result, source: out.code, shortCircuit: true };
    } catch (err) {
      // The file runs as written. Say so in the report, not only on stderr:
      // a driver that walks the source tree would otherwise show it as a
      // measured file that ran nothing.
      witness.unmeasured(file.split(path.sep).join('/'), err && err.message);
      process.stderr.write(`Witness could not instrument ${file}: ${err && err.message}\n`);
      return result;
    }
  },
});

process.on('exit', () => {
  try {
    if (boundaryTarget && !boundarySeen) {
      // The file was never loaded, so the rewrite never happened. Silence
      // here would read as a method the tests did not reach, which is a
      // different answer from one the recorder never got near.
      boundaryRuntime.problem('target-not-found', boundaryTarget.name);
    }
    // A test still open at exit never got its end(). Its record is written
    // marked 'unterminated', so the driver knows the boundary was cut.
    witness.end('unterminated');
    if (coverageDir) {
      // One file per worker, not per process: a runner with workers has
      // several, in processes or in threads, and the driver sums them all.
      witness.writeReport(coverageDir, `coverage-${witness.workerTag()}.json`);
    }
  } catch {
    // never fail the run over the report
  }
});
