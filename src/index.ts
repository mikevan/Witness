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
 *     (the Mocha boundary), and witness-instrument.cjs (the instrumenter,
 *     bundled whole for a process without this package's node_modules).
 *   - wasmDir(): the grammars and the tree-sitter runtime the hooks read
 *     through WITNESS_WASM_DIR.
 *   - The environment the hooks read, by name, so a tool sets exactly these.
 *
 * The records every hook writes are the same shape: one JSON line per test,
 * { test, files: { path: [lines] }, outcomes: { path: { branchId: [indices] } },
 * entered: { path: [functionIds] } }, and coverage-<pid>.json per process in
 * Istanbul's shape. The design is in docs/witness.md.
 */
import * as path from 'node:path';

export { Instrumenter } from './instrument';
export type { Instrumented, WitnessMaps } from './instrument';
export { createInstrumenter } from './hook';
export type { WitnessInstrumenter } from './hook';
export { initTreeSitter, loadLanguage, createParser, repoWasmDir } from './treeSitter';

/** The hook files as built, beside this module's dist. */
export function hooksDir(): string {
  return path.join(__dirname, 'hooks');
}

/** The tree-sitter runtime and the three grammars, beside this module's dist. */
export function wasmDir(): string {
  return __dirname;
}

/** Every hook file a tool copies into a project, in dist/hooks. */
export const HOOK_FILES = ['witness.cjs', 'witness-instrument.cjs', 'witness-loader.mjs', 'witness-vite.mjs', 'witness-playwright-loader.mjs', 'witness-playwright.template.ts', 'mocha.cjs'] as const;

/** The environment the hooks read. A tool sets these on the process it launches. */
export const ENV = {
  /** where the hook files are (witness.cjs and witness-instrument.cjs) */
  hooksDir: 'WITNESS_HOOKS_DIR',
  /** where the grammars are */
  wasmDir: 'WITNESS_WASM_DIR',
  /** absolute folder whose files are instrumented */
  sourceRoot: 'WITNESS_SOURCE_ROOT',
  /** where coverage-<pid>.json goes at exit */
  coverageDir: 'WITNESS_COVERAGE_DIR',
  /** where the per-test records go */
  attributionDir: 'WITNESS_ATTRIBUTION_DIR',
  /** absolute path of the Playwright fixture file */
  fixture: 'WITNESS_FIXTURE',
  /** the Playwright component package the project uses */
  ctPackage: 'WITNESS_CT_PACKAGE',
} as const;

/** The Node the loader needs: module.registerHooks exists from 22.15.0 and 23.5.0. */
export function nodeSupportsWitness(version: string): boolean {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) {
    return false;
  }
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 15);
}
