/**
 * Witness under Jest: the transformer that wraps the project's own.
 *
 * Jest's transform contract is synchronous. `require` always uses `process`,
 * and only `import` will use `processAsync` (@jest/transform types, Jest 30).
 * Witness's instrumenter is asynchronous, because tree-sitter initialises its
 * WASM asynchronously, and there is no synchronous way in. So the
 * instrumenting does not happen here. The driver instruments every source
 * file before Jest starts, in the same walk that produces the executable-line
 * universe, and writes the result under WITNESS_INSTRUMENTED_DIR mirroring
 * each file's path relative to WITNESS_SOURCE_ROOT. This file is the lookup.
 *
 * It instruments the input rather than the output, which is the other half of
 * the same decision. Witness rewrites source textually, on the source's own
 * lines, so its maps are already in the coordinates the person's editor uses.
 * Handing that to Babel and letting Babel compile around the counters keeps
 * those coordinates. Instrumenting Babel's output instead would put the
 * counters in compiled coordinates and need a source map to get back, which
 * is the same shape as the bundled-chunk problem on the Angular path.
 *
 * The counters are plain function calls, so a transformer that strips types
 * or compiles JSX carries them through untouched. One that minified or
 * eliminated dead code could drop them; no test transform does that, and the
 * react-jest port would show it if one did.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sourceRoot = process.env.WITNESS_SOURCE_ROOT;
const instrumentedDir = process.env.WITNESS_INSTRUMENTED_DIR;

/**
 * The project's own transformer, as Jest resolved it. A transformer may
 * export itself, export itself as `default` under CommonJS interop, or export
 * a `createTransformer` factory (babel-jest does the last of those), so all
 * three shapes are taken.
 */
function loadUpstream(spec) {
  if (!Array.isArray(spec) || typeof spec[0] !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(spec[0]);
  const mod = loaded && loaded.__esModule && loaded.default ? loaded.default : loaded;
  if (mod && typeof mod.createTransformer === 'function') {
    return mod.createTransformer(spec[1]);
  }
  return mod;
}

/**
 * The pre-instrumented text for a file, or undefined when there is none: the
 * file sits outside the source root, or the instrumenter could not take it.
 * Undefined means the original source is used and the file is simply not
 * measured, which is a fact the driver reports rather than hides.
 */
function instrumentedFor(sourcePath) {
  if (!sourceRoot || !instrumentedDir) {
    return undefined;
  }
  const relative = path.relative(sourceRoot, sourcePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  try {
    return fs.readFileSync(path.join(instrumentedDir, relative), 'utf8');
  } catch {
    return undefined;
  }
}

function digest(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(String(part));
    hash.update('\0');
  }
  return hash.digest('hex');
}

module.exports = {
  createTransformer(options) {
    const upstream = loadUpstream(options && options.upstream);
    const text = (sourceText, sourcePath) => instrumentedFor(sourcePath) ?? sourceText;
    return {
      process(sourceText, sourcePath, jestOptions) {
        const input = text(sourceText, sourcePath);
        if (!upstream || typeof upstream.process !== 'function') {
          return { code: input };
        }
        return upstream.process(input, sourcePath, jestOptions);
      },
      async processAsync(sourceText, sourcePath, jestOptions) {
        const input = text(sourceText, sourcePath);
        if (!upstream) {
          return { code: input };
        }
        if (typeof upstream.processAsync === 'function') {
          return upstream.processAsync(input, sourcePath, jestOptions);
        }
        return upstream.process(input, sourcePath, jestOptions);
      },
      /**
       * The upstream key, computed over the text Jest will actually be given,
       * salted with that text. Hashing the instrumented text covers both
       * things a stale cache could miss at once: it changes when the source
       * changes, and it changes when the instrumenter's behaviour changes,
       * because it is the output of one applied to the other.
       */
      getCacheKey(sourceText, sourcePath, jestOptions) {
        const input = text(sourceText, sourcePath);
        const base =
          upstream && typeof upstream.getCacheKey === 'function' ? upstream.getCacheKey(input, sourcePath, jestOptions) : digest(input, sourcePath);
        return digest(base, input);
      },
    };
  },
};
