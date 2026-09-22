# Changelog

## 1.0.17

Karma, and two defects in the rewrite that only a type-checking compiler could
have found.

`witness-karma.cjs` and `witness-karma-client.js` put the runtime in front of
the bundle and the test boundary on Jasmine, and hand each record back through
the Karma server. Nothing is mapped and no statement map crosses the wire: a
driver that instruments the source before the browser sees it gets records
that already name the person's own files and lines.

The handle is declared with a type now, not cast to `any`. `W.v` returns the
value it was given, so an `any` handle made every instrumented declarator
`any` too, and the erasure spread until a callback further down the chain had
no contextual type. Under `noImplicitAny` that is TS7006, and it stopped an
Angular build on a real project.

No counter wraps a condition any more. TypeScript cannot narrow a variable
through a function call, so `if (W.b(0, p))` left `p` possibly undefined in
the body and `typeof v === 'string'` wrapped the same way lost the union
refinement. No signature fixes that and no compiler option fixes it, because
the second failure is not a strictness error. The counters moved into the
arms instead: an `if` counts inside each arm, with a synthetic `else` when it
has none, a ternary counts inside each branch, and a boolean run or a default
value counts as the first operand of a comma expression. The condition is left
exactly as the person wrote it. That is also where istanbul-lib-instrument
puts its branch counters. `W.b` and `W.l` are gone; every way through a
decision reports through `W.c`.

The synthetic `else` has to be emitted as part of the consequent's own closing
edit. As an edit of its own it collided with an enclosing block that ends at
the same offset, and `if (a) { if (b) { x } }` came out as `}} else {}`.

A new test compiles the rewrite with `tsc --strict` and fails if any type is
erased or any narrowing is lost. Both defects reproduce against it.

The embedded maps carry `skipped` as well. A browser page is the only place a
decorated Angular component is measured, and it is the embedding path, so
leaving it out lost the skip reason exactly where it was needed.

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
