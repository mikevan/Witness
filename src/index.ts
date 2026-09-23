/**
 * Witness: the instrumentation MikeVan's AI Development Toolkit owns.
 *
 * What a tool takes from here:
 *   - createInstrumenter(wasmDir): the instrumenter in the tool's own
 *     process, for the universe of files no test loads and for tests.
 *   - hooksDir(): the folder of hook files the tool copies into its own
 *     folder in a project (.deeptest/hooks, .untangleit/hooks) and loads
 *     from there: witness.cjs (the runtime), witness-loader.mjs (Node's
 *     loader), witness-vite.mjs (a Vite build), witness-playwright-loader.mjs
 *     and witness-playwright.template.ts (Playwright's workers), mocha.cjs
 *     (the Mocha boundary), witness-jest-runtime.cjs, witness-jest.cjs and
 *     witness-jest-transform.cjs (Jest's setup files and its transformer),
 *     and witness-instrument.cjs (the instrumenter, bundled whole for a
 *     process without this package's node_modules).
 *   - wasmDir(): the grammars and the tree-sitter runtime the hooks read
 *     through WITNESS_WASM_DIR.
 *   - The environment the hooks read, by name, so a tool sets exactly these.
 *
 * The records every hook writes are the same shape: one JSON line per test,
 * { test, files: { path: [lines] }, outcomes: { path: { branchId: [indices] } },
 * entered: { path: [functionIds] } }, and coverage-<pid>.json per process in
 * Istanbul's shape. The design is in docs/witness.md.
 */
export { Instrumenter, DECORATED_FIELD, MISPARSE } from './instrument';
export { BoundaryInstrumenter } from './boundary';
export type { BoundaryTarget, BoundaryMatch, BoundaryInstrumented, Captured, OutcomeKind, Observation, Problem, BoundaryRecord } from './boundary';
export { isProblem, readBoundaryRecords } from './boundary';
export type { Instrumented, WitnessMaps } from './instrument';
export { createInstrumenter } from './hook';
export type { WitnessInstrumenter, BoundaryEnvTarget } from './hook';
export { parseBoundaryTarget } from './hook';
export { initTreeSitter, loadLanguage, createParser, repoWasmDir } from './treeSitter';
export { hooksDir, wasmDir, HOOK_FILES, ENV, copyHooks, readPackageJson, findVitestConfig, resolveModuleDir, detectRunner, vitestWrapperConfig, witnessTransform, angularKarmaConfig, writeShadowTree, writeShadowTsConfig, parseTsConfigText, readTsPaths, renameTestFiles, posixPath, splitArgs, escapeRegex, instrumentedPathFor, writeInstrumented, detectPlaywrightCt, writePlaywrightFixture, playwrightWrapperConfig, detectAngularTestTarget } from './delivery';
export type { Runner, Rewrite, ShadowTree, TsPaths, JestResolvedConfig, AngularTestTarget } from './delivery';
export { pathCondition, pathConditionNote, upstreamPathFailure, presentPathFailure } from './compatibility';
export type { PathCondition, UpstreamPathFailure, PathFailurePresentation } from './compatibility';
export { buildFailureBrief, unclassifiedPacket, describeRunner } from './diagnosis';
export type { ProblemPacket } from './diagnosis';

/** The Node the loader needs: module.registerHooks exists from 22.15.0 and 23.5.0. */
export function nodeSupportsWitness(version: string): boolean {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) {
    return false;
  }
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 15);
}
