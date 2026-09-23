/**
 * Witness: the boundary recorder's runtime.
 *
 * One global, `globalThis.__witnessBoundary__`, that a boundary-instrumented
 * function reports to. It records one observation per entry: the test that
 * was running, an index and a depth within that test, the arguments as they
 * arrived, and how the call ended.
 *
 * It is a separate global and a separate record file from the counters,
 * because it answers a different question and is loaded for one run of one
 * method rather than for measurement. Its only dependency on the counter
 * runtime is `__witness__.current`, the test that is running. When the
 * counter runtime is not loaded, observations carry no test identity, and
 * the gate reports insufficient evidence rather than guessing a pairing.
 *
 * Plain CommonJS with no dependencies: it is copied into the tool's folder
 * in the project and loaded by the project's own Node, or served as a plain
 * script into a browser page. It must never throw into the code it is
 * watching.
 *
 * In a browser there is no disk, so records are held and handed out by
 * `drain()` instead, the same answer the counter runtime gives: the Karma
 * client and the Playwright fixture carry them back to the driver, which
 * writes them to the same files every other runner writes. One reader
 * understands them all.
 */
'use strict';
/*
 * Everything is inside one function on purpose.
 *
 * In a browser this file and witness.cjs are served as two classic scripts
 * into the same page, which means one shared global scope. Both of them
 * needed an `fs`, a `path` and a `threadId`, so the second one to parse died
 * on "Identifier 'fs' has already been declared" before it ran a line. The
 * global was then never defined, every instrumented call threw, the component
 * under test rendered nothing, and the gate reported a method the tests had
 * never reached. The run looked like a product failure and was a name
 * collision. witness-karma-client.js has been written this way from the
 * start, for the same reason.
 */
(function () {
var fs;
var path;
var threadId = 0;
try {
  fs = require('node:fs');
  path = require('node:path');
  threadId = require('node:worker_threads').threadId;
} catch (e) {
  // A browser page. Nothing here needs a filesystem; see drain() below.
}

const env = typeof process !== 'undefined' && process.env ? process.env : {};
const dir = fs && env.WITNESS_BOUNDARY_DIR;
const file = dir ? path.join(dir, `boundary-${process.pid}-${threadId}.jsonl`) : undefined;

/** Records made where there is no disk, waiting for something to carry them out. */
const held = [];

/** How deep a value is walked, and how many nodes of it are visited, before it is given up on. */
const MAX_DEPTH = 20;
const MAX_NODES = 10000;

/** Per test: how many entries so far, and how deep we currently are. */
const counts = new Map();
let depth = 0;

function currentTest() {
  try {
    // The counter runtime knows which test is running wherever a runner has a
    // test boundary to hook: Node's runners, and Karma through its client. A
    // page with no such hook records null here, and whatever carries the
    // records out stamps the identity on the way past, because that is the
    // moment it is known for certain.
    const w = globalThis.__witness__;
    return w && w.current !== undefined && w.current !== null ? w.current : null;
  } catch {
    return null;
  }
}

function uncomparable(why) {
  return { t: 'uncomparable', why };
}

/**
 * A value in the tagged, language-neutral form the comparator reads. The
 * Python recorder produces the same tags, so the comparator never learns
 * which language a record came from.
 *
 * Anything outside the comparable set is marked with the reason rather than
 * guessed at, and a value that crosses a bound is marked rather than
 * truncated: comparing a truncated value would pass two different things as
 * the same, which is the one answer this gate must never give.
 */
function capture(value, seen, budget, at) {
  if (at > MAX_DEPTH) {
    return uncomparable('depth-limit');
  }
  if (budget.n++ > MAX_NODES) {
    return uncomparable('node-limit');
  }
  if (value === null) {
    return { t: 'null' };
  }
  if (value === undefined) {
    return { t: 'undefined' };
  }
  const type = typeof value;
  if (type === 'number' || type === 'bigint') {
    return { t: 'num', v: String(value) };
  }
  if (type === 'string') {
    return { t: 'str', v: value };
  }
  if (type === 'boolean') {
    return { t: 'bool', v: value };
  }
  if (type === 'function') {
    return uncomparable('function');
  }
  if (type === 'symbol') {
    return uncomparable('symbol');
  }
  if (seen.has(value)) {
    return uncomparable('cycle');
  }
  if (value instanceof Date) {
    // An instant, which compares the same in both languages.
    return Number.isNaN(value.getTime()) ? uncomparable('invalid-date') : { t: 'date', v: value.getTime() };
  }
  if (value instanceof RegExp) {
    return { t: 'regex', v: { source: value.source, flags: value.flags } };
  }
  if (typeof value.then === 'function') {
    // Nothing is attached to it. Observing a caller-visible promise from
    // outside would add a rejection handler that was not there.
    return uncomparable('thenable');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return { t: 'array', v: value.map((item) => capture(item, seen, budget, at + 1)) };
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return uncomparable(value.constructor && value.constructor.name ? `instance:${value.constructor.name}` : 'instance');
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = capture(value[key], seen, budget, at + 1);
    }
    return { t: 'object', v: out };
  } finally {
    seen.delete(value);
  }
}

function captureValue(value) {
  try {
    return capture(value, new Set(), { n: 0 }, 0);
  } catch (err) {
    return uncomparable('capture-failed');
  }
}

function captureArguments(args) {
  if (args === null || args === undefined) {
    // The instrumenter could not name the parameters, so nothing about them
    // can honestly be recorded.
    return uncomparable('unnamed-parameters');
  }
  return captureValue(Array.prototype.slice.call(args));
}

function write(record) {
  if (!file) {
    // No disk. Held for drain(), rather than dropped: a browser run that
    // silently recorded nothing would read as a method no test reached.
    held.push(record);
    return;
  }
  try {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // Never fail the person's tests over an observation.
  }
}

const boundary = {
  /** A call is starting. Returns the handle the instrumented body reports to. */
  enter(target, args, isAsync) {
    let observation;
    try {
      const test = currentTest();
      const key = test === null ? '\u0000no-test' : test;
      const index = counts.get(key) || 0;
      counts.set(key, index + 1);
      observation = { target, test, index, depth, args: captureArguments(args) };
      depth += 1;
    } catch {
      observation = undefined;
    }
    let done = false;
    const finish = (kind, value) => {
      if (done || !observation) {
        return;
      }
      done = true;
      try {
        depth -= 1;
        observation.outcome = { kind, value };
        write(observation);
      } catch {
        // as above
      }
    };
    return {
      /**
       * The value is handed straight back, untouched, and captured on the
       * way past. An `async` function's return is the value its promise
       * will settle to, so it is recorded as a resolve from inside. A
       * function that is not declared async returning a promise is captured
       * like any other value, which makes it uncomparable: capture refuses
       * a thenable rather than subscribing to it.
       */
      returned(value) {
        try {
          finish(isAsync ? 'resolve' : 'return', captureValue(value));
        } catch {
          // as above
        }
        return value;
      },
      threw(error) {
        const shape = error instanceof Error ? { t: 'error', v: { name: error.constructor ? error.constructor.name : 'Error', message: String(error.message) } } : { t: 'error', v: { name: 'thrown', message: String(error) } };
        finish(isAsync ? 'reject' : 'throw', shape);
      },
      fellThrough() {
        finish(isAsync ? 'resolve' : 'return', { t: 'undefined' });
      },
    };
  },
  /**
   * The recorder could not attach at all: the named function was not found
   * in the file, or the name resolved to more than one. Recorded as a
   * record of its own so the gate reports it rather than reading an empty
   * run as a method no test reached.
   */
  problem(kind, target) {
    write({ problem: kind, target });
  },
  /**
   * Everything recorded since the last call, for a client in a browser page
   * to carry back to the driver. Empty in Node, where every record went
   * straight to disk as it was made.
   */
  drain() {
    return held.splice(0, held.length);
  },
  /** For a fixture that needs to know nothing was configured. */
  get recording() {
    return file !== undefined || !fs;
  },
};

if (!globalThis.__witnessBoundary__) {
  globalThis.__witnessBoundary__ = boundary;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.__witnessBoundary__;
}
})();
