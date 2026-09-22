# Changelog

## 1.0.16

Three hooks for Jest: the runtime, the test boundary, and a transformer that
wraps the project's own.

Jest's `process` is synchronous and this library's instrumenter is not, so
`witness-jest-transform.cjs` never instruments. It reads the source a driver
instrumented before the run, from the folder named by
`WITNESS_INSTRUMENTED_DIR`, substitutes it, and calls the project's
transformer with it. Its cache key is the upstream key over that text, salted
with the text itself, so a transformer that keys only on a file path cannot
serve a stale transform after the instrumenter's output has changed.

`witness-jest-runtime.cjs` loads the runtime from `setupFiles`, ahead of a
project's own, because an instrumented module calls the runtime in its
prologue and a project's setup file may import source.
`witness-jest.cjs` carries the test boundary and writes the whole-run counters
when each test file finishes, since Jest throws away the environment between
test files and anything left to process exit would be lost.

## 1.0.14

The runtime writes down a broken test boundary instead of papering over it.

`begin()` on a test that is still open used to overwrite it: the open test's
lines were lost and everything after was credited to whichever test came
last. A process ending with a test open wrote that test at exit as if it had
ended. Both produced a record that looked like any other. Now the open test
is closed and its record says `boundary: "overlapped"` or `"unterminated"`,
and a driver that sees the key refuses to score the run.

A file under the source root that the loader or the Vite plugin could not
instrument is noted beside the reports (`unmeasured-<worker>.json`) with the
reason, so a driver can show it as unmeasured rather than as measured and
never executed. What the instrumenter skipped rides on the file's report
entry under `skipped`. The Playwright fixture writes a record for a test
whose page never loaded the runtime, so an empty test is not a missing one.

The separator regression test builds both spellings of a path explicitly,
so it fails on Linux as well as Windows when the plugin stops normalising.

## 1.0.9

Witness leaves DeepTest and becomes its own library, `@projectrevivesolutions/witness`, at the toolkit version. The instrumenter, the runtime, the Node loader, the Vite plugin, the Playwright worker hook and fixture, the Mocha boundary, the esbuild bundle, the grammars, and the tests move here unchanged in what they measure; the hooks now read `WITNESS_*` environment names instead of `DEEPTEST_*`, so any tool can drive them. DeepTest bundles it; UntangleIt declares it for its behaviour gate.
