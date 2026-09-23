/**
 * Witness: the instrumenter as the hooks load it. Bundled by esbuild into
 * dist/hooks/witness-instrument.cjs with web-tree-sitter inside, because
 * it runs in the project's own Node process where DeepTest's node_modules
 * does not exist. The grammars are read from the wasm folder the driver
 * names in DEEPTEST_WASM_DIR.
 */
import * as path from 'node:path';
import { createParser, initTreeSitter } from './treeSitter';
import { Instrumenter, Instrumented, WitnessMaps } from './instrument';
import { BoundaryInstrumenter, BoundaryInstrumented, BoundaryMatch, BoundaryTarget } from './boundary';

export interface WitnessInstrumenter {
  instrument(filePath: string, source: string, embedMaps?: boolean): Instrumented;
  mapsOnly(filePath: string, source: string): WitnessMaps;
  /**
   * Rewrites one named function so its entries, returns, and throws are
   * recorded. A separate entry point from `instrument`, which rewrites a
   * whole file and produces an executable-line universe; this produces no
   * maps and touches nothing but the one function.
   */
  instrumentBoundary(filePath: string, source: string, target: BoundaryTarget): BoundaryInstrumented;
  /**
   * The function starting on a line, by name and by the class it belongs
   * to. The caller that knows a line is the one recording before a
   * hand-off; the run afterwards has only the name and the container.
   */
  locateBoundary(filePath: string, source: string, line: number): BoundaryMatch | undefined;
}

/** Picks the grammar by extension: .ts and .mts/.cts use TypeScript, .tsx TSX, everything else JavaScript (which reads JSX). */
export async function createInstrumenter(wasmDir: string): Promise<WitnessInstrumenter> {
  await initTreeSitter(path.join(wasmDir, 'web-tree-sitter.wasm'));
  const typescript = new Instrumenter(await createParser(path.join(wasmDir, 'tree-sitter-typescript.wasm')));
  const tsx = new Instrumenter(await createParser(path.join(wasmDir, 'tree-sitter-tsx.wasm')));
  const javascript = new Instrumenter(await createParser(path.join(wasmDir, 'tree-sitter-javascript.wasm')));
  const boundaries = {
    typescript: new BoundaryInstrumenter(await createParser(path.join(wasmDir, 'tree-sitter-typescript.wasm'))),
    tsx: new BoundaryInstrumenter(await createParser(path.join(wasmDir, 'tree-sitter-tsx.wasm'))),
    javascript: new BoundaryInstrumenter(await createParser(path.join(wasmDir, 'tree-sitter-javascript.wasm'))),
  };
  const pickBoundary = (filePath: string): BoundaryInstrumenter => {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.tsx' ? boundaries.tsx : ext === '.ts' || ext === '.mts' || ext === '.cts' ? boundaries.typescript : boundaries.javascript;
  };
  const pick = (filePath: string): Instrumenter => {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.tsx' ? tsx : ext === '.ts' || ext === '.mts' || ext === '.cts' ? typescript : javascript;
  };
  return {
    instrument: (filePath, source, embedMaps = false) => pick(filePath).instrument(filePath, source, embedMaps),
    mapsOnly: (filePath, source) => pick(filePath).mapsOnly(filePath, source),
    instrumentBoundary: (filePath, source, target) => pickBoundary(filePath).instrument(filePath, source, target),
    locateBoundary: (filePath, source, line) => pickBoundary(filePath).locate(filePath, source, line),
  };
}

/**
 * The one function a recorded run watches, as the driver puts it in
 * WITNESS_BOUNDARY_TARGET. One JSON shape carries both languages: the
 * JavaScript recorder reads `file`, the Python recorder reads `module`, and
 * both read `name` and `container`. Undefined when no recorded run is
 * configured, which is every ordinary measured run.
 */
export interface BoundaryEnvTarget {
  /** Absolute path, forward slashes. Read by the JavaScript recorder. */
  file?: string;
  /** Importable module name. Read by the Python recorder. */
  module?: string;
  name: string;
  container?: string;
}

export function parseBoundaryTarget(value: string | undefined): BoundaryEnvTarget | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as BoundaryEnvTarget;
    return typeof parsed?.name === 'string' && parsed.name ? parsed : undefined;
  } catch {
    return undefined;
  }
}
