# Changelog

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
