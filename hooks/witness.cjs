/**
 * Witness: the runtime. One global, `globalThis.__witness__`, that
 * instrumented files report to, and an Istanbul-shaped view of the same
 * counters at `globalThis.__coverage__` for reporters that expect it.
 *
 * What it records that Istanbul does not: for every statement, decision
 * outcome, and function entry, the id of the test that was running. The
 * hooks tell it which test that is (begin/end); the per-test record goes
 * out as one JSON line per test, the same shape the tools' other hooks
 * write, so the driver reads all of them with one reader.
 *
 * Plain CommonJS with no dependencies: it is copied into the project's
 * hooks folder (.deeptest/hooks or .untangleit/hooks) and loaded by the project's Node. It must never
 * throw into the code it is measuring.
 */
'use strict';
// One file for two places. Under Node it writes its records to disk; in a
// browser page (served by the Witness Vite plugin) there is no disk, so
// `end()` returns the record and the fixture on the Node side writes it.
const inNode = typeof process !== 'undefined' && process.versions && process.versions.node && typeof require === 'function';
const fs = inNode ? require('node:fs') : undefined;
const path = inNode ? require('node:path') : undefined;

// A process id is not unique enough. A runner that puts its workers in threads
// (Vitest can) gives each worker its own globalThis, so each loads its own copy
// of this file, while they all share one process id. Two workers would then
// append per-test lines to the same path. Node's own threadId separates them,
// is 0 on the main thread, and costs the library no knowledge of any runner.
const threadId = inNode ? require('node:worker_threads').threadId : 0;

/** Unique per worker, across processes and across threads within a process. */
function workerTag() {
  return `${process.pid}-${threadId}`;
}

const attributionDir = inNode ? process.env.WITNESS_ATTRIBUTION_DIR : undefined;
const attributionFile = attributionDir ? path.join(attributionDir, `attr-witness-${workerTag()}.jsonl`) : undefined;

const files = new Map(); // handle -> { path, cov, W }
// Files under the source root that a loader tried to instrument and could
// not: path -> reason. They are reported beside the counters, because a file
// that ran uninstrumented would otherwise look like a file that ran nothing.
const unmeasured = new Map();
let currentTest = undefined;
let hits = new Map(); // path -> Set(line) for the current test
let outcomes = new Map(); // path -> Map(branchId -> Set(index)) for the current test
let entered = new Map(); // path -> Set(fnId) for the current test

function coverageView() {
  if (!globalThis.__coverage__) {
    globalThis.__coverage__ = {};
  }
  return globalThis.__coverage__;
}

function zeros(map, branches) {
  const out = {};
  for (const id of Object.keys(map)) {
    out[id] = branches ? map[id].locations.map(() => 0) : 0;
  }
  return out;
}

function noteLine(filePath, line) {
  if (currentTest === undefined) {
    return;
  }
  let set = hits.get(filePath);
  if (!set) {
    set = new Set();
    hits.set(filePath, set);
  }
  set.add(line);
}

function noteOutcome(filePath, branchId, index) {
  if (currentTest === undefined) {
    return;
  }
  let perFile = outcomes.get(filePath);
  if (!perFile) {
    perFile = new Map();
    outcomes.set(filePath, perFile);
  }
  let set = perFile.get(branchId);
  if (!set) {
    set = new Set();
    perFile.set(branchId, set);
  }
  set.add(index);
}

function noteEntry(filePath, fnId) {
  if (currentTest === undefined) {
    return;
  }
  let set = entered.get(filePath);
  if (!set) {
    set = new Set();
    entered.set(filePath, set);
  }
  set.add(fnId);
}

function makeHandle(filePath, cov) {
  const sm = cov.statementMap;
  const bm = cov.branchMap;
  const W = {
    s(id) {
      cov.s[id] += 1;
      noteLine(filePath, sm[id].start.line);
    },
    v(id, name, value) {
      cov.s[id] += 1;
      noteLine(filePath, sm[id].start.line);
      if (typeof value === 'function' && value.name === '' && name) {
        try {
          Object.defineProperty(value, 'name', { value: name, configurable: true });
        } catch {
          // a frozen function keeps its empty name
        }
      }
      return value;
    },
    f(id) {
      cov.f[id] += 1;
      noteEntry(filePath, id);
    },
    b(id, value) {
      const index = value ? 0 : 1;
      cov.b[id][index] += 1;
      noteOutcome(filePath, id, index);
      noteLine(filePath, bm[id].locations[index].start.line || bm[id].line);
      return value;
    },
    l(id, index, value) {
      cov.b[id][index] += 1;
      noteOutcome(filePath, id, index);
      return value;
    },
    c(id, index) {
      cov.b[id][index] += 1;
      noteOutcome(filePath, id, index);
    },
  };
  return W;
}

const witness = {
  /** Called by the loader, in the loading thread, right after instrumenting a file. */
  register(handle, filePath, maps) {
    const cov = {
      path: filePath,
      statementMap: maps.statementMap,
      fnMap: maps.fnMap,
      branchMap: maps.branchMap,
      s: zeros(maps.statementMap, false),
      f: zeros(maps.fnMap, false),
      b: zeros(maps.branchMap, true),
      // What the instrumenter decided not to count, line and reason. It rides
      // in the report so a driver can show it; Istanbul readers ignore the key.
      skipped: Array.isArray(maps.skipped) ? maps.skipped : [],
    };
    coverageView()[filePath] = cov;
    const W = makeHandle(filePath, cov);
    files.set(handle, { path: filePath, cov, W });
    return W;
  },
  /** Called by the instrumented file's prologue; with maps when the file carries its own (a browser page). */
  file(handle, maps) {
    let entry = files.get(handle);
    if (!entry && maps) {
      witness.register(handle, maps.path, maps);
      entry = files.get(handle);
    }
    if (!entry) {
      // Instrumented by a loader this process never ran: count nothing, break nothing.
      const noop = () => undefined;
      return { s: noop, f: noop, c: noop, v: (_id, _name, value) => value, b: (_id, value) => value, l: (_id, _i, value) => value };
    }
    return entry.W;
  },
  /**
   * A test is starting. If one is still open, its boundary is broken: either
   * the runner interleaves tests (concurrent tests in one worker) or the
   * previous test's end never came. The open test is closed and its record
   * says so, rather than being silently overwritten, so a driver can refuse
   * to draw a card from it. Lines counted after this point belong to the
   * new test and to nothing else.
   */
  begin(testId) {
    if (currentTest !== undefined) {
      witness.end('overlapped');
    }
    currentTest = testId;
    hits = new Map();
    outcomes = new Map();
    entered = new Map();
  },
  /**
   * The current test ended: write its record (Node) or return it (browser),
   * and forget it. `boundary` is set only by a caller closing a test that
   * did not end on its own: 'overlapped' from begin(), 'unterminated' from a
   * loader at process exit. A record carrying it is evidence that the
   * attribution was cut off, never evidence about the test.
   */
  end(boundary) {
    if (currentTest === undefined) {
      return undefined;
    }
    let record;
    try {
      record = { test: currentTest, files: {}, outcomes: {}, entered: {} };
      if (boundary) {
        record.boundary = boundary;
      }
      for (const [file, lines] of hits) {
        record.files[file] = Array.from(lines).sort((a, b) => a - b);
      }
      for (const [file, perFile] of outcomes) {
        record.outcomes[file] = {};
        for (const [id, set] of perFile) {
          record.outcomes[file][id] = Array.from(set).sort((a, b) => a - b);
        }
      }
      for (const [file, set] of entered) {
        record.entered[file] = Array.from(set).sort((a, b) => a - b);
      }
      if (attributionFile) {
        fs.appendFileSync(attributionFile, `${JSON.stringify(record)}\n`);
      }
    } catch {
      // Never fail the user's tests over attribution.
    }
    currentTest = undefined;
    return record;
  },
  /** The whole-run counters as a plain object, for a fixture to carry out of a browser page. */
  snapshot() {
    return JSON.parse(JSON.stringify(coverageView()));
  },
  /** Zero every counter, so a page reused by a second test starts clean. */
  reset() {
    for (const cov of Object.values(coverageView())) {
      for (const id of Object.keys(cov.s)) {
        cov.s[id] = 0;
      }
      for (const id of Object.keys(cov.f)) {
        cov.f[id] = 0;
      }
      for (const id of Object.keys(cov.b)) {
        cov.b[id] = cov.b[id].map(() => 0);
      }
    }
    hits = new Map();
    outcomes = new Map();
    entered = new Map();
  },
  /**
   * A file under the source root that a loader could not instrument. It ran
   * as written, so its counters do not exist, and a driver that walked the
   * source tree would otherwise count it as measured and never executed.
   */
  unmeasured(filePath, reason) {
    unmeasured.set(filePath, String(reason || 'Witness could not instrument it.'));
  },
  /**
   * The whole-run counters, Istanbul's shape, written where the driver reads
   * them. The unmeasured files go beside it under the same worker tag, in a
   * file of their own, so `__coverage__` stays exactly Istanbul's shape.
   */
  writeReport(dir, name = 'coverage-final.json') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(coverageView()));
    if (unmeasured.size > 0) {
      const list = Array.from(unmeasured, ([file, reason]) => ({ path: file, reason }));
      fs.writeFileSync(path.join(dir, `unmeasured-${workerTag()}.json`), JSON.stringify(list));
    }
  },
  /** Unique per worker; a hook names its per-worker report with this. */
  workerTag,
  get current() {
    return currentTest;
  },
};

if (!globalThis.__witness__) {
  globalThis.__witness__ = witness;
}

if (inNode) {
  module.exports = globalThis.__witness__;
}
