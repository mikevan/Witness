/**
 * Witness: getting Witness instrumentation in front of a project's own test
 * runner.
 *
 * This is the shared layer under both tools. DeepTest runs an instrumented
 * suite to measure coverage; UntangleIt runs a recorded suite to compare a
 * method's behaviour before and after an untangling. The question each asks
 * is different, but the work of reaching Jest, Vitest, Mocha, Angular's two
 * runners, and Playwright's component tests is the same work, and it lived
 * in DeepTest until the behaviour gate needed it too.
 *
 * The architecture this file exists to hold up:
 *
 *   DeepTest    -> Witness instrumented test run -> the project's own runner
 *   UntangleIt  -> Witness recorded test run     -> the project's own runner
 *
 * The tools stay independent and neither requires the other. Witness owns
 * the path in.
 *
 * The rule that has not changed: the project runs its tests the way the
 * project runs them. Nothing here replaces a runner, rewrites a project's
 * config in place, or edits a line of a person's source. Every generated
 * file goes in the calling tool's own folder, and every hook is found
 * through the environment.
 *
 * What is NOT here: coverage maps, per-test attribution, the executable-line
 * universe, evidence reconciliation, and every verdict. Those are the
 * consumer's, because they are what the consumer is for.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The hook files as built, beside this module's dist. */
export function hooksDir(): string {
  return path.join(__dirname, 'hooks');
}

/** The tree-sitter runtime and the three grammars, beside this module's dist. */
export function wasmDir(): string {
  return __dirname;
}

/** Every hook file a tool copies into a project, in dist/hooks. */
export const HOOK_FILES = ['witness.cjs', 'witness-instrument.cjs', 'witness-loader.mjs', 'witness-vite.mjs', 'witness-vitest.mjs', 'witness-jest-runtime.cjs', 'witness-jest.cjs', 'witness-jest-transform.cjs', 'witness-karma.cjs', 'witness-karma-client.js', 'witness-boundary.cjs', 'witness_boundary.py', 'witness-playwright-loader.mjs', 'witness-playwright.template.ts', 'mocha.cjs'] as const;

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
  /** where the boundary recorder's observations go */
  boundaryDir: 'WITNESS_BOUNDARY_DIR',
  /** the one function the boundary recorder watches, as the Python recorder reads it: module:Qualified.name */
  boundaryTarget: 'WITNESS_BOUNDARY_TARGET',
  /** where the per-test records go */
  attributionDir: 'WITNESS_ATTRIBUTION_DIR',
  /** absolute path of the Playwright fixture file */
  fixture: 'WITNESS_FIXTURE',
  /** the Playwright component package the project uses */
  ctPackage: 'WITNESS_CT_PACKAGE',
  /**
   * where the pre-instrumented sources are, mirroring each file's path
   * relative to the source root. Jest's transform contract is synchronous and
   * the instrumenter is not, so the Jest path instruments ahead of the run and
   * the transformer reads from here.
   */
  instrumentedDir: 'WITNESS_INSTRUMENTED_DIR',
} as const;



/** The runners a Polyglot tool can measure or record through. */
export type Runner = 'jest' | 'vitest' | 'ng-vitest' | 'ng-karma' | 'mocha' | 'playwright-ct';

/** Forward slashes, on every host, because every generated config is read by tools that expect them. */
export function posixPath(p: string): string {
  return p.split(path.sep).join('/');
}

/** A runner argument string as the person typed it, split on spaces. */
export function splitArgs(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every Witness hook, copied into the calling tool's own folder in the
 * project and loaded from there. The hooks are found through the
 * environment rather than by a relative path, so a bundling runner cannot
 * rewrite its way out of finding them.
 */
export function copyHooks(hookDir: string, from: string = hooksDir()): string {
  fs.mkdirSync(hookDir, { recursive: true });
  for (const file of HOOK_FILES) {
    const source = path.join(from, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(hookDir, file));
    }
  }
  return hookDir;
}

export function readPackageJson(workspaceRoot: string): { deps: Record<string, string>; scripts: Record<string, string>; jest?: unknown; mocha?: unknown } | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
    return {
      deps: { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) },
      scripts: (pkg.scripts as Record<string, string> | undefined) ?? {},
      jest: pkg.jest,
      mocha: pkg.mocha,
    };
  } catch {
    return undefined;
  }
}

export function findVitestConfig(workspaceRoot: string): string | undefined {
  for (const name of ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs', 'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    if (fs.existsSync(path.join(workspaceRoot, name))) {
      return name;
    }
  }
  return undefined;
}

/**
 * Finds an installed package by walking up from the workspace, the way Node
 * resolves modules. Monorepos hoist runners to the repository root.
 */
export function resolveModuleDir(workspaceRoot: string, name: string): string | undefined {
  let dir = workspaceRoot;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Which runner the project uses, from its dependencies and config files.
 *
 * Playwright's component tests are checked first, because a component-testing
 * project usually has Vite and often a Vitest hoisted somewhere above it, and
 * answering "vitest" for one of those runs the wrong runner entirely. That
 * check used to live in each consumer, and when this function moved into
 * Witness one consumer got the version without it: UntangleIt's behaviour
 * gate then ran Vitest against a Playwright project and recorded nothing.
 * One answer, in one place, is the point of this layer.
 */
export function detectRunner(workspaceRoot: string): Runner | undefined {
  if (detectPlaywrightCt(workspaceRoot)) {
    return 'playwright-ct';
  }
  const pkg = readPackageJson(workspaceRoot);
  const hasVitest = Boolean(pkg?.deps.vitest) || Boolean(resolveModuleDir(workspaceRoot, 'vitest'));
  const hasJest = Boolean(pkg?.deps.jest) || Boolean(resolveModuleDir(workspaceRoot, 'jest'));
  const hasMocha = Boolean(pkg?.deps.mocha) || Boolean(resolveModuleDir(workspaceRoot, 'mocha'));
  const testScript = pkg?.scripts.test ?? '';
  const named = (word: string): boolean => new RegExp(`\\b${word}\\b`).test(testScript);
  // The test script settles a tie; otherwise the order is Vitest, Jest, Mocha.
  const present = [hasVitest && 'vitest', hasJest && 'jest', hasMocha && 'mocha'].filter((r): r is 'vitest' | 'jest' | 'mocha' => Boolean(r));
  if (present.length > 1) {
    const chosen = present.filter((r) => named(r));
    if (chosen.length === 1) {
      return chosen[0];
    }
  }
  return present[0];
}

// ------------------------------------------------------------ Vitest

/**
 * The wrapper config a Vitest run is given: the project's own config
 * merged, the Witness Vite plugin added, and the Witness setup file put
 * ahead of the project's.
 *
 * The plugin is imported relatively, not as a file URL. Vite bundles the
 * wrapper and everything it imports relatively, so a TypeScript config goes
 * through esbuild like it would on its own; a file URL would be left to
 * Node, which strips the types itself and warns about it.
 */
export function vitestWrapperConfig(options: { tool: string; workDir: string; hookDir: string; wasmDir: string; sourceRoot: string; workspaceRoot: string; userConfig?: string }): string {
  const relativeImport = (p: string): string => {
    const rel = path.relative(options.workDir, p).split(path.sep).join('/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  };
  return [
    `// Generated by ${options.tool} on every run. Wraps the project config; do not edit.`,
    "import { defineConfig, mergeConfig } from 'vitest/config';",
    `import { witnessPlugin } from ${JSON.stringify(relativeImport(path.join(options.hookDir, 'witness-vite.mjs')))};`,
    options.userConfig ? `import base from ${JSON.stringify(relativeImport(path.join(options.workspaceRoot, options.userConfig)))};` : 'const base = {};',
    "const resolved = typeof base === 'function' ? await base({ command: 'serve', mode: 'test' }) : base;",
    'const merged = mergeConfig(resolved, defineConfig({',
    '  plugins: [witnessPlugin({',
    `    hooksDir: ${JSON.stringify(options.hookDir)},`,
    `    wasmDir: ${JSON.stringify(options.wasmDir)},`,
    `    sourceRoot: ${JSON.stringify(options.sourceRoot)},`,
    '  })],',
    '}));',
    '// setupFiles is replaced, not merged. mergeConfig concatenates arrays, so a',
    "// merge leaves the project's own setup file first, and a project's setup file",
    '// usually lives under the source root, which means it is instrumented and',
    '// calls the runtime in its prologue. Loaded second, the Witness hook is too',
    '// late and every test file dies on "reading \'file\' of undefined".',
    'const theirs = merged.test?.setupFiles ?? [];',
    `merged.test = { ...merged.test, setupFiles: [${JSON.stringify(path.join(options.hookDir, 'witness-vitest.mjs'))}, ...(Array.isArray(theirs) ? theirs : [theirs])] };`,
    'export default merged;',
    '',
  ].join('\n');
}

// -------------------------------------------------------------- Jest

/** The parts of `jest --showConfig`'s resolved project config a driver reads. */
export interface JestResolvedConfig {
  /** [pattern, resolved transformer path, its options]. Jest fills in its default (babel-jest) when a project sets none. */
  transform?: Array<[string, string, unknown]>;
  setupFiles?: string[];
  setupFilesAfterEnv?: string[];
}

/**
 * The project's transform table with every transformer wrapped by ours, and
 * the original passed through as an option so the wrapper can call it. The
 * patterns are the project's own, untouched, so a project that transforms
 * different file types differently keeps doing exactly that.
 *
 * Undefined when the resolved config could not be read or names no
 * transformer, because there is then nothing to wrap and instrumenting
 * nothing would measure nothing.
 */
export function witnessTransform(entries: Array<[string, string, unknown]> | undefined, witnessTransformPath: string): Record<string, [string, { upstream: [string, unknown] }]> | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const table: Record<string, [string, { upstream: [string, unknown] }]> = {};
  for (const [pattern, modulePath, options] of entries) {
    if (typeof pattern !== 'string' || typeof modulePath !== 'string') {
      return undefined;
    }
    table[pattern] = [witnessTransformPath, { upstream: [modulePath, options ?? {}] }];
  }
  return table;
}

// ----------------------------------------------------------- Angular

/**
 * The Karma config an Angular Karma run is given.
 *
 * The hook cannot go in through `--setup-files` here. The builder ignores
 * that option for Karma and says so in a warning. What it does support is
 * `--runner-config`, a Karma config, so this wraps the project's own when
 * there is one, and reproduces the builder's defaults when there is not,
 * because the builder applies those only when no config file is given. The
 * framework serves the runtime ahead of the bundle, so the global exists
 * before any instrumented module's prologue runs; the reporter writes what
 * the browser sends back to disk. A bare "Chrome" becomes "ChromeHeadless"
 * so no window opens.
 */
export function angularKarmaConfig(options: { tool: string; workspaceRoot: string; hookDir: string; userConfig?: string }): string {
  const posix = (p: string): string => p.split(path.sep).join('/');
  return [
    `// Generated by ${options.tool} on every run. Wraps the Karma config Angular would load; do not edit.`,
    "'use strict';",
    "const { createRequire } = require('node:module');",
    `const projectRequire = createRequire(${JSON.stringify(posix(options.workspaceRoot) + '/')});`,
    'module.exports = function (config) {',
    options.userConfig
      ? `  require(${JSON.stringify(posix(path.join(options.workspaceRoot, options.userConfig)))})(config);`
      : [
          '  config.set({',
          "    basePath: '',",
          "    frameworks: ['jasmine'],",
          "    plugins: ['karma-jasmine', 'karma-chrome-launcher'].map((p) => projectRequire(p)),",
          "    reporters: ['progress'],",
          "    browsers: ['ChromeHeadless'],",
          '  });',
        ].join('\n'),
    '  config.set({',
    `    plugins: (config.plugins || []).concat([require(${JSON.stringify(posix(path.join(options.hookDir, 'witness-karma.cjs')))})]),`,
    "    frameworks: (config.frameworks || ['jasmine']).concat(['witness']),",
    "    reporters: (config.reporters || ['progress']).filter((r) => r !== 'kjhtml').concat(['witness']),",
    "    browsers: (config.browsers && config.browsers.length ? config.browsers : ['ChromeHeadless']).map((b) => (b === 'Chrome' ? 'ChromeHeadless' : b)),",
    '  });',
    '};',
    '',
  ].join('\n');
}

// ------------------------------------------------------- Shadow tree

/**
 * What a rewrite does to one file: the replacement text, or undefined to
 * copy the file through untouched. Throwing means the file could not be
 * rewritten, and the original is mirrored in its place so the build still
 * has a module where it expects one.
 */
export type Rewrite = (absolutePath: string, source: string) => string | undefined;

export interface ShadowTree {
  /** The folder the mirror was written into, absolute. */
  root: string;
  /** Workspace-relative paths that were written rewritten. */
  rewritten: string[];
  /** How many files were copied through untouched, including those a rewrite refused. */
  copied: number;
  /** The files a rewrite refused, with the reason, in the order they were tried. */
  refused: Array<{ path: string; reason: string }>;
}

/**
 * The shadow source tree: the project's source root mirrored file for file,
 * with the named files rewritten and everything else copied as it is.
 *
 * This exists because Angular's unit-test builder bundles the application
 * before either runner sees it. There is no plugin hook in front of that,
 * and no schema in the builder exposes one, so the only place left to
 * rewrite is before the builder reads the files at all. Rewriting the input
 * rather than the output is also what keeps the coordinates: Witness
 * rewrites source textually on the source's own lines and labels its maps
 * with the ORIGINAL path, so a record names the file in the person's editor
 * and the line they can put a cursor on. Reading them back out of a bundle
 * would need a source map the builder does not emit for tests, which is the
 * failure the Angular path spent 1.0.12 to 1.0.15 in.
 *
 * Everything that is not rewritten is copied rather than skipped, and that
 * is the half that is easy to get wrong. A component names its template and
 * stylesheet by relative path, a stylesheet names an image by relative
 * path, and each of those is resolved from the file that names it. Mirror
 * only the TypeScript and every one of those references dangles.
 *
 * Both consumers use this, with different rewrites. DeepTest instruments
 * the whole measurable universe for counters. UntangleIt rewrites exactly
 * one function in one file for the behaviour gate. Same mirror, and no
 * second copy of it.
 */
export function writeShadowTree(options: { sourceRoot: string; instrumentedDir: string; files: string[]; workspaceRoot: string; rewrite: Rewrite }): ShadowTree {
  const { sourceRoot, instrumentedDir, workspaceRoot, rewrite } = options;
  const rewritten: string[] = [];
  const refused: Array<{ path: string; reason: string }> = [];
  const handled = new Set<string>();

  for (const rel of options.files) {
    const absolute = path.resolve(workspaceRoot, rel);
    handled.add(absolute);
    const target = path.join(instrumentedDir, path.relative(sourceRoot, absolute));
    try {
      const replacement = rewrite(posixPath(absolute), fs.readFileSync(absolute, 'utf8'));
      if (replacement === undefined) {
        handled.delete(absolute);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, replacement, 'utf8');
      rewritten.push(rel);
    } catch (err) {
      // It could not be rewritten, so nothing was written for it and the
      // mirror would have a hole where the build expects a module. The
      // original goes in its place: the build succeeds, the file runs as
      // written, and the caller is told which file and why.
      refused.push({ path: rel, reason: (err as Error).message.split('\n')[0] });
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(absolute, target);
      } catch {
        // The commonest reason a file cannot be rewritten is that it could
        // not be read, and then it cannot be copied either. The build will
        // say what is missing far better than a guess here would.
      }
    }
  }

  let copied = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') {
          walk(from);
        }
        continue;
      }
      if (handled.has(from)) {
        continue;
      }
      const to = path.join(instrumentedDir, path.relative(sourceRoot, from));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied += 1;
    }
  };
  walk(sourceRoot);

  // Nothing is logged from here. The counts go back to the caller, which says
  // what happened in its own words: the same mirror is a measured universe to
  // one tool and a single recorded method to the other.
  return { root: instrumentedDir, rewritten, copied, refused };
}

/**
 * The tsconfig the builder type-checks the shadow tree with: the project's
 * own test tsconfig, extended, with two things changed.
 *
 * `include` points at the mirror, because that is what is being compiled.
 * And every path alias whose target is inside the source root is repointed
 * into the mirror, because an alias left pointing at the real source would
 * quietly pull the unrewritten file into the build. Aliases that point
 * outside the source root are kept as they are, resolved to absolute so
 * they do not have to be relative to a folder they were not written
 * relative to.
 */
export function writeShadowTsConfig(workDir: string, projectTsConfig: string | undefined, sourceRoot: string, instrumentedDir: string): string {
  const generated = path.join(workDir, 'tsconfig.shadow.json');
  const compilerOptions: { paths?: Record<string, string[]> } = {};
  if (projectTsConfig) {
    const { paths } = readTsPaths(projectTsConfig);
    const entries = Object.entries(paths);
    if (entries.length > 0) {
      const inside = (target: string): boolean => {
        const rel = path.relative(sourceRoot, target);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      };
      compilerOptions.paths = Object.fromEntries(entries.map(([alias, targets]) => [alias, targets.map((t) => (inside(t) ? posixPath(path.join(instrumentedDir, path.relative(sourceRoot, t))) : t))]));
    }
  }
  const config = {
    ...(projectTsConfig ? { extends: relativeFrom(workDir, projectTsConfig) } : {}),
    ...(compilerOptions.paths ? { compilerOptions } : {}),
    include: [`${relativeFrom(workDir, instrumentedDir)}/**/*.ts`, `${relativeFrom(workDir, instrumentedDir)}/**/*.tsx`],
  };
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(generated, `${JSON.stringify(config, undefined, 2)}\n`, 'utf8');
  return generated;
}

/** A posix path from one folder to another, prefixed with ./ so a tsconfig reads it as relative and not as a package. */
function relativeFrom(from: string, to: string): string {
  const rel = posixPath(path.relative(from, to));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * A tsconfig with comments and trailing commas, which is what `tsc --init`
 * writes and what every Angular project therefore has. Only enough of JSONC
 * is handled to read one of these: comments outside strings, and a comma
 * before a closing brace or bracket.
 */
export function parseTsConfigText(text: string): Record<string, unknown> | undefined {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The path aliases a tsconfig is in effect under, with every target resolved to an absolute posix path. */
export interface TsPaths {
  paths: Record<string, string[]>;
  baseUrl?: string;
}

/**
 * The `paths` a tsconfig declares, following `extends` to the end of the
 * chain. A nearer config's `paths` replaces a further one's outright, which
 * is TypeScript's own rule: `compilerOptions` merges key by key, and `paths`
 * is one key. Each target is resolved where TypeScript resolves it, against
 * `baseUrl` when the same config declares one and against the config's own
 * folder when it does not, so the caller gets absolute paths and never has
 * to reproduce that rule again.
 */
export function readTsPaths(file: string, seen = new Set<string>()): TsPaths {
  const absolute = path.resolve(file);
  if (seen.has(absolute) || !fs.existsSync(absolute)) {
    return { paths: {} };
  }
  seen.add(absolute);
  const parsed = parseTsConfigText(fs.readFileSync(absolute, 'utf8'));
  if (!parsed) {
    return { paths: {} };
  }
  const dir = path.dirname(absolute);
  const options = (parsed.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
  const extend = parsed.extends;
  const bases = (Array.isArray(extend) ? extend : typeof extend === 'string' ? [extend] : []).filter((e): e is string => typeof e === 'string' && e.startsWith('.'));
  let inherited: TsPaths = { paths: {} };
  for (const base of bases) {
    const from = readTsPaths(path.resolve(dir, base), seen);
    inherited = { paths: { ...inherited.paths, ...from.paths }, baseUrl: from.baseUrl ?? inherited.baseUrl };
  }
  const baseUrl = options.baseUrl === undefined ? inherited.baseUrl : posixPath(path.resolve(dir, options.baseUrl));
  if (!options.paths) {
    return { paths: inherited.paths, baseUrl };
  }
  const against = options.baseUrl === undefined ? dir : path.resolve(dir, options.baseUrl);
  const resolved: Record<string, string[]> = {};
  for (const [alias, targets] of Object.entries(options.paths)) {
    resolved[alias] = (Array.isArray(targets) ? targets : []).map((t) => posixPath(path.resolve(against, t)));
  }
  return { paths: resolved, baseUrl };
}

/**
 * Records written against the shadow tree name their test file inside it.
 * Only the leading folder changes; the rest of the path and the test name
 * are untouched, so a card's lines and its test names point at the same
 * place in the person's project.
 */
export function renameTestFiles(lines: string[], from: string, to: string): string[] {
  return lines.map((line) => {
    if (!line.includes(from)) {
      return line;
    }
    try {
      const record = JSON.parse(line) as { test?: string };
      if (typeof record.test !== 'string' || !record.test.startsWith(from)) {
        return line;
      }
      return JSON.stringify({ ...record, test: `${to}${record.test.slice(from.length)}` });
    } catch {
      return line;
    }
  });
}

/**
 * Where a pre-instrumented file goes, and where the Jest transformer looks
 * for it: the file's path relative to the source root, under the
 * instrumented directory. Jest's transform contract is synchronous and the
 * instrumenter is not, so that path instruments ahead of the run and the
 * transformer reads from here.
 *
 * A recorded run writes exactly one file here, because it watches exactly
 * one function. A measured run writes the whole universe.
 */
export function instrumentedPathFor(instrumentedDir: string, sourceRoot: string, absolute: string): string {
  return path.join(instrumentedDir, path.relative(sourceRoot, absolute));
}

/** Writes one pre-instrumented file where the transformer will find it. */
export function writeInstrumented(instrumentedDir: string, sourceRoot: string, absolute: string, code: string): string {
  const target = instrumentedPathFor(instrumentedDir, sourceRoot, absolute);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, code, 'utf8');
  return target;
}

// -------------------------------------------------------- Playwright

const PLAYWRIGHT_CT_PACKAGES = ['@playwright/experimental-ct-react', '@playwright/experimental-ct-vue', '@playwright/experimental-ct-svelte', '@playwright/experimental-ct-solid', '@playwright/experimental-ct-react17'];
const PLAYWRIGHT_CT_CONFIGS = ['playwright-ct.config.ts', 'playwright-ct.config.mts', 'playwright-ct.config.js', 'playwright-ct.config.mjs', 'playwright-ct.config.cjs'];

/** The component-testing package a project uses, and the config file it runs from. */
export function detectPlaywrightCt(workspaceRoot: string): { package: string; configFile?: string } | undefined {
  const pkg = readPackageJson(workspaceRoot);
  const found = PLAYWRIGHT_CT_PACKAGES.find((name) => Boolean(pkg?.deps[name]) || Boolean(resolveModuleDir(workspaceRoot, name)));
  if (!found) {
    return undefined;
  }
  return { package: found, configFile: PLAYWRIGHT_CT_CONFIGS.find((f) => fs.existsSync(path.join(workspaceRoot, f))) };
}

/**
 * The fixture Playwright's workers load.
 *
 * Playwright runs code inside a test's worker only through a fixture a test
 * file imports, so the fixture is written into the calling tool's folder and
 * a resolve hook in every Playwright process answers each spec's import of
 * the component package with this file. The spec keeps its ordinary import
 * and nothing in the project changes.
 */
export function writePlaywrightFixture(workDir: string, ctPackage: string, from: string = hooksDir()): string {
  const template = fs.readFileSync(path.join(from, 'witness-playwright.template.ts'), 'utf8');
  const dir = path.join(workDir, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'witness-playwright.ts');
  const content = template.split('__PACKAGE__').join(ctPackage);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
    fs.writeFileSync(file, content, 'utf8');
  }
  return file;
}

/** The wrapper config: the project's own with the Witness Vite plugin added and its relative paths re-rooted. */
export function playwrightWrapperConfig(options: { tool: string; workspaceRoot: string; configFile: string }): string {
  const baseUrl = pathToFileURL(path.join(options.workspaceRoot, options.configFile)).href;
  return [
    `// Generated by ${options.tool} on every run. Wraps the project's Playwright config; do not edit.`,
    `import base from ${JSON.stringify(baseUrl)};`,
    "import { witnessPlugin } from './hooks/witness-vite.mjs';",
    "import * as path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const here = path.dirname(fileURLToPath(import.meta.url));',
    `const projectRoot = ${JSON.stringify(options.workspaceRoot)};`,
    "const abs = (p) => (typeof p === 'string' && !path.isAbsolute(p) ? path.resolve(projectRoot, p) : p);",
    "const plugin = witnessPlugin({ hooksDir: path.join(here, 'hooks'), wasmDir: process.env.WITNESS_WASM_DIR, sourceRoot: process.env.WITNESS_SOURCE_ROOT });",
    'function withWitness(use) {',
    "  // Playwright joins ctTemplateDir onto the config's own folder with path.join, so it stays relative to the tool's folder.",
    '  // Playwright reuses a built bundle when its sources and dependencies are unchanged, config included, so the Witness build lives in its own cache folder, emptied before every run.',
    "  use = { ...use, ctTemplateDir: path.relative(here, abs(use?.ctTemplateDir ?? 'playwright')), ctCacheDir: path.join(here, 'playwright-cache') };",
    '  const vite = use.ctViteConfig;',
    "  if (typeof vite === 'function') {",
    '    return { ...use, ctViteConfig: async (...args) => { const c = await vite(...args); return { ...c, plugins: [...(c?.plugins ?? []), plugin] }; } };',
    '  }',
    '  return { ...use, ctViteConfig: { ...(vite ?? {}), plugins: [...(vite?.plugins ?? []), plugin] } };',
    '}',
    "const config = { ...base, use: withWitness(base.use), testDir: abs(base.testDir ?? '.'), outputDir: abs(base.outputDir ?? 'test-results') };",
    "for (const k of ['snapshotDir', 'globalSetup', 'globalTeardown']) { if (base[k] !== undefined) { config[k] = abs(base[k]); } }",
    'if (Array.isArray(base.projects)) {',
    '  config.projects = base.projects.map((p) => ({ ...p, ...(p.testDir ? { testDir: abs(p.testDir) } : {}), ...(p.use ? { use: withWitness(p.use) } : {}) }));',
    '}',
    'export default config;',
    '',
  ].join('\n');
}

/** Where an Angular project's test target keeps its sources and its tsconfig. */
export interface AngularTestTarget {
  /** Absolute path of the project's source root, which the builder's include is relative to. */
  projectSourceRoot: string;
  /** The tsconfig the builder type-checks tests with, workspace-relative, when it names one. */
  tsConfig?: string;
}

/**
 * The Angular project using the unit-test builder, with the tsconfig that
 * builder would type-check tests under.
 *
 * Both consumers need this and for the same reason: the builder compiles the
 * shadow tree, and a shadow tree that is not in the TypeScript program fails
 * the build outright on any file carrying Angular metadata. The generated
 * tsconfig has to extend the right one, so the builder's own order of
 * preference is kept exactly: the target's own tsConfig, then
 * tsconfig.spec.json in the project root when it exists, then the build
 * target's. Extending the wrong one would type-check the mirror under the
 * application's settings rather than the test's, and lose the test types.
 */
export function detectAngularTestTarget(workspaceRoot: string): AngularTestTarget | undefined {
  let angular: Record<string, unknown> | undefined;
  try {
    angular = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'angular.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const projects = angular?.projects as Record<string, { root?: string; sourceRoot?: string; architect?: Record<string, { builder?: string; options?: { tsConfig?: string } }> }> | undefined;
  for (const project of Object.values(projects ?? {})) {
    const test = project.architect?.test;
    if (test?.builder !== '@angular/build:unit-test') {
      continue;
    }
    const projectRoot = path.join(workspaceRoot, project.root ?? '');
    const spec = posixPath(path.join(project.root ?? '', 'tsconfig.spec.json'));
    const tsConfig =
      typeof test.options?.tsConfig === 'string'
        ? test.options.tsConfig
        : fs.existsSync(path.join(workspaceRoot, spec))
          ? spec
          : typeof project.architect?.build?.options?.tsConfig === 'string'
            ? (project.architect.build.options.tsConfig as string)
            : undefined;
    return {
      projectSourceRoot: project.sourceRoot === undefined ? path.join(projectRoot, 'src') : path.join(workspaceRoot, project.sourceRoot),
      tsConfig,
    };
  }
  return undefined;
}
