/**
 * Witness: the instrumenter, the runtime, and the hooks.
 *
 * Three kinds of proof. The instrumenter's rewrite must be a valid program
 * (node --check) with the counters where the rules put them. The maps must
 * agree with istanbul-lib-instrument, line for line, on every fixture and
 * on Witness's own source: that differential test is the gate everything
 * else stands on. And a program run under the loader must report the
 * lines, decisions, and functions each test touched, in ES modules and in
 * CommonJS, through one hook. The tools' own suites run the same
 * differential over their fixtures and drive the hooks through their
 * runners; this suite proves the library on its own.
 */
import { beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstrumenter, repoWasmDir, nodeSupportsWitness, HOOK_FILES, ENV, DECORATED_FIELD } from '../src/index';
import type { WitnessInstrumenter } from '../src/index';

let witness: WitnessInstrumenter;
const wasmDir = repoWasmDir();

beforeAll(async () => {
  witness = await createInstrumenter(wasmDir);
});

function check(code: string, ext = '.mjs'): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'witness-check-')), `x${ext}`);
  fs.writeFileSync(file, code);
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

test('the rewrite keeps every line where it was and stays a valid program', () => {
  const source = fs.readFileSync(path.join('test', 'fixtures', 'react-jest', 'src', 'greet.js'), 'utf8');
  const out = witness.instrument('/p/greet.js', source);
  assert.equal(out.code.split('\n').length, source.split('\n').length, 'same line count');
  check(out.code);
  assert.deepEqual(Object.values(out.maps.statementMap).map((s) => s.start.line), [4, 5, 7, 11, 12, 14, 15, 17, 21]);
  assert.deepEqual(Object.values(out.maps.fnMap).map((f) => `${f.name}@${f.line}`), ['hello@3', 'helloMany@10', 'shout@20']);
  assert.deepEqual(Object.values(out.maps.branchMap).map((b) => `${b.type}@${b.line}`), ['default-arg@3', 'if@4', 'if@11', 'if@14']);
  assert.match(out.code, /^const __witness_\w+ = globalThis\.__witness__\.file\("__witness_\w+"\);/);
  assert.deepEqual(out.maps.skipped, []);
});

test('every statement shape the rules name: bodies get braces, values get wrapped, labels stay on their loops', () => {
  const source = [
    "'use strict';",
    'function f(a = 1, { b } = {}) { if (a) return 1; else if (b) { x = a && b || c; } else x = a ? 1 : 2; }',
    'const g = (x) => x * 2, h = function () {};',
    'class A { y = 3; static z = () => 1; m() { switch (y) { case 1: break; default: return; } } }',
    'let u = 0; for (const q of qs) q(); outer: while (u) do u--; while (u);',
    'a ??= b; for (let i = 0; i < 2; i++) if (i) continue; else break;',
    'const o = { k: function () { return 1; }, [c]: () => ({ n: 1 }) };',
    'export default class {}',
    'export const k = 1;',
  ].join('\n');
  const out = witness.instrument('/p/shapes.mjs', source);
  check(out.code);
  assert.match(out.code, /^'use strict';const __witness_/, 'the prologue follows the directive');
  // The condition is left exactly as written. It used to be wrapped in a
  // counter call, which stops TypeScript narrowing the variable inside the
  // body, and strict code then fails to compile; the arms carry the counters
  // instead, which is also where istanbul-lib-instrument puts them.
  assert.match(out.code, /if \(a\) \{__witness_\w+\.c\(\d+, 0\);__witness_\w+\.s\(\d+\);return 1;\}/, 'the true arm counts itself, and the condition is untouched');
  assert.match(out.code, /\} else \{__witness_\w+\.c\(\d+, 1\);if \(\(__witness_\w+\.s\(\d+\), b\)\)/, "an else-if is braced so the else arm can count itself; the inner if's statement counter still rides in front of its condition, where a comma keeps narrowing");
  assert.match(out.code, /x = \(__witness_\w+\.c\(\d+, 0\), a\) && \(__witness_\w+\.c\(\d+, 1\), b\) \|\| \(__witness_\w+\.c\(\d+, 2\), c\);/, 'each operand of a boolean run is counted beside its value');
  assert.match(out.code, /x = a \? \(__witness_\w+\.c\(\d+, 0\), 1\) : \(__witness_\w+\.c\(\d+, 1\), 2\);/, 'and so is each arm of a ternary');
  assert.match(out.code, /function f\(a = \(__witness_\w+\.c\(\d+, 0\), 1\), \{ b \} = \(__witness_\w+\.c\(\d+, 0\), \{\}\)\)/, 'a default value is counted where it is evaluated');
  assert.match(out.code, /outer: while \(u\) \{__witness_\w+\.s\(\d+\);do \{__witness_\w+\.s\(\d+\);u--;\} while \(u\);\}/, 'the label stays on its loop, the loop under it carries no counter of its own');
  assert.match(out.code, /__witness_\w+\.s\(\d+\);a \?\?= b;/, 'logical assignment is a statement, not an Istanbul branch');
  assert.match(out.code, /const g = __witness_\w+\.v\(\d+, "g", \(x\) => \(__witness_\w+\.f\(\d+\), __witness_\w+\.s\(\d+\), x \* 2\)\)/);
  assert.match(out.code, /case 1:__witness_\w+\.c\(\d+, 0\);/);
  assert.match(out.code, /default:__witness_\w+\.c\(\d+, 1\);/);
  const types = Object.values(out.maps.branchMap).map((b) => b.type);
  assert.deepEqual(types.filter((t) => t === 'default-arg').length, 2);
  assert.ok(types.includes('switch') && types.includes('cond-expr') && types.includes('binary-expr') && types.includes('if'));
  assert.deepEqual(out.maps.skipped, []);
});

/**
 * The instrumented file has to survive a strict type-check, because on the
 * Angular path it gets one: the builder compiles the shadow tree with the
 * project's own tsconfig, and a type error there stops the run dead. No other
 * runner type-checks what Witness emits, so every mistake of this kind is
 * invisible until Angular finds it, and two were found that way on real
 * projects rather than here.
 *
 * The first was erasure: the handle was `any`, so `let name = W.v(0, "name",
 * raw.trim())` was `any`, and a callback further down the chain had no
 * contextual type (TS7006). The second was narrowing: `if (W.b(0, p))` cannot
 * narrow `p`, so every strict null check in the body failed (TS18048), and
 * `typeof v === 'string'` wrapped the same way lost the union refinement
 * (TS2339). The first was fixed by typing the handle, the second by moving
 * every counter out of the condition.
 *
 * Both classes are pinned below by compiling the rewrite with tsc under
 * --strict, which is the only way to keep them fixed.
 */
test('the rewrite type-checks under --strict: no type is erased and no narrowing is lost', () => {
  const source = [
    'export interface Person { name?: string; kind: "admin" | "user" }',
    '',
    'export function label(p: Person | undefined): string {',
    '  if (!p) {',
    '    return "nobody";',
    '  }',
    '  if (p.name) {',
    '    return p.name.toUpperCase();',
    '  }',
    '  switch (p.kind) {',
    '    case "admin":',
    '      return "ADMIN";',
    '    default:',
    '      return "user";',
    '  }',
    '}',
    '',
    'export function widen(value: string | number): string {',
    '  return typeof value === "string" ? value.trim() : value.toFixed(2);',
    '}',
    '',
    'export function firstWord(text?: string): string {',
    '  const parts = text?.split(" ");',
    '  if (parts && parts.length > 0) {',
    '    return parts[0];',
    '  }',
    '  return "";',
    '}',
    '',
    'export function clean(raw: string): string {',
    '  let name = raw.trim();',
    '  return name.split(/\\s+/).map((p) => p.charAt(0)).join("");',
    '}',
    '',
  ].join('\n');
  // The source itself must be clean, or the test proves nothing about the rewrite.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-strict-'));
  const tsc = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
  const compile = (code: string, name: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, code);
    try {
      execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'ES2022', '--skipLibCheck', file], { stdio: 'pipe' });
      return '';
    } catch (err) {
      return String((err as { stdout?: Buffer }).stdout ?? err);
    }
  };
  assert.equal(compile(source, 'plain.ts'), '', 'the fixture is clean to begin with');
  assert.equal(compile(witness.instrument('/p/strict.ts', source).code, 'instrumented.ts'), '', 'and stays clean once instrumented');
  assert.equal(compile(witness.instrument('/p/embedded.ts', source, true).code, 'embedded.ts'), '', 'with the maps embedded too, which is the Angular case');
});

test('a TypeScript non-null assertion after a logical operator is blanked before parsing (tree-sitter-typescript issue 299)', () => {
  const source = "export function f(a: A | null, b: B | null): boolean {\n  return Boolean(a) && b!.kind === 'x' || a!.kind === 'y';\n}\n";
  const out = witness.instrument('/p/nn.ts', source);
  assert.deepEqual(out.maps.skipped, []);
  const run = Object.values(out.maps.branchMap).find((b) => b.type === 'binary-expr');
  assert.ok(run);
  assert.equal(run.locations.length, 3, 'three operands, as istanbul reads it');
  assert.match(out.code, /b \.kind === 'x'/, 'the assertion is gone from the rewrite; it meant nothing at run time');
  assert.equal(out.code.split('\n').length, source.split('\n').length);
});

test('differential: the maps agree with istanbul-lib-instrument on every fixture and on Witness itself', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createInstrumenter: istanbul } = require('istanbul-lib-instrument') as { createInstrumenter: (o: unknown) => { instrumentSync: (c: string, f: string) => string; lastFileCoverage: () => { statementMap: Record<string, { start: { line: number } }>; fnMap: Record<string, { loc: { start: { line: number } } }>; branchMap: Record<string, { type: string; line: number }> } } };
  const roots = [path.join('test', 'fixtures'), 'src', 'hooks'];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/node_modules|coverage|\.deeptest|\.angular|dist/.test(entry.name)) {
          walk(p);
        }
      } else if (/\.(m?[jt]sx?|c[jt]s)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        files.push(p);
      }
    }
  };
  roots.forEach(walk);
  assert.ok(files.length > 25, `${files.length} files`);
  const failures: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const plugins = ['asyncGenerators', 'bigInt', 'classProperties', 'classPrivateProperties', 'classPrivateMethods', 'dynamicImport', 'importMeta', 'numericSeparator', 'objectRestSpread', 'optionalCatchBinding', 'topLevelAwait', 'decorators-legacy', ...(/\.tsx$/.test(file) ? ['typescript', 'jsx'] : /\.(ts|mts|cts)$/.test(file) ? ['typescript'] : ['jsx'])];
    const theirs = istanbul({ esModules: true, parserPlugins: plugins });
    theirs.instrumentSync(source, file);
    const i = theirs.lastFileCoverage();
    const ours = witness.mapsOnly(file.split(path.sep).join('/'), source);
    const lines = (m: Record<string, { start?: { line: number }; loc?: { start: { line: number } } }>) => Array.from(new Set(Object.values(m).map((e) => (e.loc ?? e).start!.line))).sort((a, b) => a - b);
    const branches = (m: Record<string, { type: string; line: number }>) => Object.values(m).map((b) => `${b.type}@${b.line}`).sort();
    const same = JSON.stringify([lines(i.statementMap), lines(i.fnMap), branches(i.branchMap)]) === JSON.stringify([lines(ours.statementMap), lines(ours.fnMap), branches(ours.branchMap)]);
    if (!same || ours.skipped.length > 0) {
      failures.push(`${file}: statements ${lines(i.statementMap).join(',')} vs ${lines(ours.statementMap).join(',')}; functions ${lines(i.fnMap).join(',')} vs ${lines(ours.fnMap).join(',')}; branches ${branches(i.branchMap).join(' ')} vs ${branches(ours.branchMap).join(' ')}; skipped ${ours.skipped.map((s) => s.line).join(',')}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

/**
 * A hooks folder the way the driver makes one in a project: the plain hook
 * files plus the bundled instrumenter, because in a real project DeepTest's
 * node_modules is not there. The bundle is built here from the current
 * source every time: the tests run before the build, so dist/hooks holds
 * the previous release's bundle, and a test against that would pass or
 * fail on the wrong code (it did, once). WITNESS_TEST_BUNDLE names a
 * prebuilt one for a harness that cannot run esbuild.
 */
function hooksFolder(dir: string): string {
  const hooks = path.join(dir, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const f of HOOK_FILES.filter((f) => f !== 'witness-instrument.cjs')) {
    fs.copyFileSync(path.join('hooks', f), path.join(hooks, f));
  }
  const bundle = process.env.WITNESS_TEST_BUNDLE;
  if (!bundle) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild') as { buildSync: (o: unknown) => void };
    esbuild.buildSync({
      entryPoints: ['src/hook.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile: path.join(hooks, 'witness-instrument.cjs'),
      plugins: [],
      alias: { 'web-tree-sitter': path.resolve('node_modules/web-tree-sitter/web-tree-sitter.cjs') },
      logLevel: 'silent',
    });
  } else {
    fs.copyFileSync(bundle, path.join(hooks, 'witness-instrument.cjs'));
  }
  return hooks;
}

test('the loader: ES modules and CommonJS through one hook, with lines, outcomes, and entries per test', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-run-'));
  const hooks = hooksFolder(dir);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'esm.mjs'), 'export function pick(n) {\n  if (n > 0) {\n    return "pos";\n  } else if (n < 0) {\n    return "neg";\n  }\n  return "zero";\n}\n');
  fs.writeFileSync(path.join(src, 'cjs.cjs'), 'function twice(n = 1) {\n  return n * 2;\n}\nmodule.exports = { twice };\n');
  fs.writeFileSync(path.join(src, 'never.mjs'), 'export function unused(a) {\n  return a && a.b;\n}\n');
  // The villain, instrumented under src/ and untouched under plain/: the two
  // must agree on every input, or the rewrite changed the program.
  const villain = fs.readFileSync(path.join('test', 'fixtures', 'react-vitest', 'src', 'schedule.ts'), 'utf8');
  fs.writeFileSync(path.join(src, 'schedule.ts'), villain);
  fs.mkdirSync(path.join(dir, 'plain'));
  fs.writeFileSync(path.join(dir, 'plain', 'schedule.ts'), villain);
  fs.writeFileSync(
    path.join(dir, 'run.mjs'),
    [
      "import { pick } from './src/esm.mjs';",
      "import { pickGreeting } from './src/schedule.ts';",
      "import { pickGreeting as plain } from './plain/schedule.ts';",
      "import { createRequire } from 'node:module';",
      "const { twice } = createRequire(import.meta.url)('./src/cjs.cjs');",
      "globalThis.__witness__.begin('t1'); pick(1); globalThis.__witness__.end();",
      "globalThis.__witness__.begin('t2'); pick(-1); twice(); globalThis.__witness__.end();",
      "globalThis.__witness__.begin('t3');",
      'let checked = 0;',
      "for (const hour of [0, 9, 12, 15, 18, 23]) for (const lang of ['en', 'es', 'fr', 'xx']) for (const formal of [true, false]) for (const mood of ['great', 'bad', 'ok', 'tired']) for (const name of ['Jeff', '']) {",
      '  const a = pickGreeting(hour, name, lang, formal, mood); const b = plain(hour, name, lang, formal, mood);',
      "  if (a !== b) throw new Error(`instrumented ${JSON.stringify(a)} vs plain ${JSON.stringify(b)} for ${[hour, name, lang, formal, mood]}`);",
      '  checked += 1;',
      '}',
      "globalThis.__witness__.end();",
      "console.log('checked ' + checked);",
      '',
    ].join('\n'),
  );
  const attr = path.join(dir, 'attr');
  const cov = path.join(dir, 'cov');
  fs.mkdirSync(attr);
  // Node strips the types itself (--experimental-strip-types, on by default from 23.6), so a .ts villain runs as written.
  const stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', pathToFileURL(path.join(hooks, 'witness-loader.mjs')).href, path.join(dir, 'run.mjs')], {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, [ENV.hooksDir]: hooks, [ENV.wasmDir]: wasmDir, [ENV.sourceRoot]: src, [ENV.coverageDir]: cov, [ENV.attributionDir]: attr },
  }).toString();
  assert.match(stdout, /checked 384/, 'the instrumented villain and the plain one agree on every input');
  // coverage-<pid>-<threadId>.json: one report per worker, not per process.
  const parts = fs.readdirSync(cov).filter((f) => /^coverage-\d+-\d+\.json$/.test(f));
  assert.equal(parts.length, 1, 'one report per worker');
  const report = JSON.parse(fs.readFileSync(path.join(cov, parts[0]), 'utf8')) as Record<string, { s: Record<string, number>; b: Record<string, number[]>; f: Record<string, number> }>;
  const key = (name: string) => Object.keys(report).find((k) => k.endsWith(name))!;
  assert.ok(key('esm.mjs') && key('cjs.cjs'), Object.keys(report).join(', '));
  assert.equal(key('never.mjs'), undefined, 'a file nobody loaded is not in the run report; the driver adds it from the same maps');
  assert.equal(key('plain/schedule.ts'), undefined, 'outside the source root, untouched');
  const villainCov = report[key('src/schedule.ts')];
  assert.ok(Object.values(villainCov.s).every((n) => n > 0), 'the grid reaches every statement of the villain');
  assert.deepEqual(report[key('esm.mjs')].b['0'], [1, 1], 'the first if went each way once');
  assert.deepEqual(report[key('esm.mjs')].b['1'], [1, 0], 'the else-if went true once, false never');
  assert.deepEqual(report[key('cjs.cjs')].b['0'], [1], 'the default parameter was used once');
  assert.equal(report[key('cjs.cjs')].f['0'], 1);
  const records = fs.readdirSync(attr).flatMap((f) => fs.readFileSync(path.join(attr, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { test: string; files: Record<string, number[]>; outcomes: Record<string, Record<string, number[]>>; entered: Record<string, number[]> }));
  const byTest = Object.fromEntries(records.map((r) => [r.test, r]));
  const rel = (r: Record<string, unknown>, name: string) => r[Object.keys(r).find((k) => k.endsWith(name))!];
  assert.deepEqual(rel(byTest.t1.files, 'esm.mjs'), [2, 3]);
  assert.deepEqual(rel(byTest.t2.files, 'esm.mjs'), [2, 4, 5]);
  assert.deepEqual(rel(byTest.t2.files, 'cjs.cjs'), [2]);
  assert.deepEqual(rel(byTest.t1.outcomes, 'esm.mjs'), { '0': [0] });
  assert.deepEqual(rel(byTest.t2.outcomes, 'esm.mjs'), { '0': [1], '1': [0] });
  assert.deepEqual(rel(byTest.t2.outcomes, 'cjs.cjs'), { '0': [0] });
  assert.deepEqual(rel(byTest.t1.entered, 'esm.mjs'), [0]);
  assert.equal(byTest.t1.files[Object.keys(byTest.t1.files).find((k) => k.endsWith('cjs.cjs')) ?? ''], undefined, 't1 never touched the CommonJS file');
});

test('the Vite plugin: instruments a component build with the maps embedded and puts the runtime in the page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-vite-'));
  const hooks = hooksFolder(dir);
  const { witnessPlugin } = (await import(pathToFileURL(path.join(hooks, 'witness-vite.mjs')).href)) as { witnessPlugin: (o: { hooksDir: string; wasmDir: string; sourceRoot: string }) => { buildStart(): Promise<void>; transform(code: string, id: string): { code: string } | null; transformIndexHtml(): Array<{ tag: string; children: string }> } };
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  const plugin = witnessPlugin({ hooksDir: hooks, wasmDir, sourceRoot: src });
  await plugin.buildStart();
  const greeting = "import { hello } from '../greet';\nexport function Greeting({ name }: { name: string }) {\n  return <h1>{name ? hello(name) : 'nobody'}</h1>;\n}\n";
  const out = plugin.transform(greeting, path.join(src, 'components', 'Greeting.tsx'));
  assert.ok(out, 'a source under the root is transformed');
  // TypeScript gets a cast in the prologue, because Angular's compiler type-checks
  // instrumented source and TS7017 rejects an undeclared `globalThis.__witness__`.
  assert.match(out.code, /\(globalThis as any\)\.__witness__\.file\("__witness_\w+", \{"path":/, 'the maps ride in the file: a page cannot be told about it any other way');
  assert.match(out.code, /name \? \(__witness_\w+\.c\(0, 0\), hello\(name\)\) : \(__witness_\w+\.c\(0, 1\), 'nobody'\)/);
  assert.equal(out.code.split('\n').length, greeting.split('\n').length);
  assert.equal(plugin.transform(greeting, path.join(src, 'components', 'Greeting.spec.tsx')), null, 'a spec is left alone');
  assert.equal(plugin.transform(greeting, path.join(dir, 'elsewhere', 'x.tsx')), null, 'outside the root is left alone');
  // Vite gives transform() ids with forward slashes on every platform, so an id
  // that does not use the host separator still has to match the source root. On
  // Windows this failed and the plugin quietly instrumented nothing: the run
  // passed, the report came back empty, and every file read as untested. Every
  // id above uses path.join, so none of them caught it. The first version of
  // this test derived the id from path.sep, which on Linux is the same string
  // as the id above it, so the test could only fail on Windows. The mismatch
  // is built explicitly now: both spellings of the same path, on every host,
  // and one of them is never the host's own.
  const forward = (p: string): string => p.split('\\').join('/');
  const backward = (p: string): string => p.split('/').join('\\');
  const inside = path.join(src, 'components', 'Greeting.tsx');
  const outside = path.join(dir, 'elsewhere', 'x.tsx');
  assert.ok(plugin.transform(greeting, forward(inside)), 'a forward-slash id under the root is transformed, whatever the host separator');
  assert.ok(plugin.transform(greeting, backward(inside)), 'a backslash id under the root is transformed, whatever the host separator');
  assert.equal(plugin.transform(greeting, forward(outside)), null, 'a forward-slash id outside the root is left alone');
  assert.equal(plugin.transform(greeting, backward(outside)), null, 'a backslash id outside the root is left alone');
  const tags = plugin.transformIndexHtml();
  assert.equal(tags[0].tag, 'script');
  assert.match(tags[0].children, /globalThis\.__witness__ = witness/, 'the runtime, verbatim, ahead of every module');
});

test('the Playwright worker hook: a spec gets the fixture, the fixture and node_modules get the package', () => {
  assert.equal(nodeSupportsWitness('v22.15.0'), true);
  assert.equal(nodeSupportsWitness('v22.14.9'), false);
  assert.equal(nodeSupportsWitness('v23.5.0'), true);
  assert.equal(nodeSupportsWitness('v23.4.0'), false);
  assert.equal(nodeSupportsWitness('v24.0.0'), true);
  if (!nodeSupportsWitness(process.version)) {
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-pw-'));
  fs.mkdirSync(path.join(dir, '.deeptest', 'hooks'), { recursive: true });
  // The worker hook, end to end: a spec imports the package and gets the
  // fixture; the fixture's own import of the package, and an import from
  // inside node_modules, get the package.
  const pkg = path.join(dir, 'node_modules', '@playwright', 'experimental-ct-vue');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@playwright/experimental-ct-vue', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), "export const test = 'package test'; export const expect = 'package expect';\n");
  const helper = path.join(dir, 'node_modules', 'helper');
  fs.mkdirSync(helper, { recursive: true });
  fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({ name: 'helper', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(helper, 'index.js'), "import { test } from '@playwright/experimental-ct-vue'; export const deeper = test;\n");
  const fixtureFile = path.join(dir, '.deeptest', 'hooks', 'witness-playwright.mjs');
  fs.writeFileSync(fixtureFile, "import { test as base } from '@playwright/experimental-ct-vue';\nexport * from '@playwright/experimental-ct-vue';\nexport const test = `witness over ${base}`;\n");
  fs.writeFileSync(path.join(dir, 'a.spec.mjs'), "import { test, expect } from '@playwright/experimental-ct-vue';\nimport { deeper } from 'helper';\nconsole.log(JSON.stringify({ test, expect, deeper }));\n");
  const stdout = execFileSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(path.resolve('hooks', 'witness-playwright-loader.mjs')).href, path.join(dir, 'a.spec.mjs')], {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, [ENV.fixture]: fixtureFile, [ENV.ctPackage]: '@playwright/experimental-ct-vue' },
  }).toString();
  assert.deepEqual(JSON.parse(stdout), { test: 'witness over package test', expect: 'package expect', deeper: 'package test' }, 'the spec gets the fixture\'s test and the package\'s everything else; a package under node_modules gets the package');
});

/**
 * Two workers in one process must not share a record file. A process id does
 * not separate threads, so before the worker tag both of these appended to one
 * path and one worker's per-test lines landed in the other's file. This fails
 * with a single file if the tag is ever removed.
 */
test('two worker threads write separate record files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-workers-'));
  const hook = path.join(process.cwd(), 'hooks', 'witness.cjs');
  const workerFile = path.join(dir, 'worker.cjs');
  fs.writeFileSync(
    workerFile,
    [
      "const { workerData } = require('node:worker_threads');",
      'const w = require(workerData.hook);',
      'w.begin(`spec.test.js::case ${workerData.n}`);',
      'w.end();',
      '',
    ].join('\n'),
  );
  const { Worker } = await import('node:worker_threads');
  await Promise.all(
    [1, 2].map(
      (n) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(workerFile, {
            workerData: { hook, n },
            env: { ...process.env, [ENV.attributionDir]: dir },
          });
          worker.on('error', reject);
          worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${n} exited with ${code}`))));
        }),
    ),
  );
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('attr-witness-'));
  assert.equal(files.length, 2, `two workers should write two files, got: ${files.join(', ')}`);
  const records = files
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as { test: string });
  assert.deepEqual(
    records.map((r) => r.test).sort(),
    ['spec.test.js::case 1', 'spec.test.js::case 2'],
  );
});

/**
 * Angular's compiler requires `input()`, `input.required()` and `computed()`
 * to appear syntactically as a class-member initialiser; any wrapper around
 * one is NG8110 and the build stops. So a decorated class's field
 * initialisers are left exactly as written and recorded as skipped, with the
 * reason, while the code inside them is still counted. The skip has to reach
 * the driver through the embedded maps as well as through the loader: a
 * browser page is the only place a decorated Angular component is measured,
 * and it is the embedding path. Leaving `skipped` out of the embed would
 * show three uncounted lines in a component with nothing to say about them.
 */
test('a decorated class keeps its field initialisers as written, and says so through the embedded maps', () => {
  const component = [
    "import { Component, computed, input } from '@angular/core';",
    "import { hello } from './greet';",
    '',
    "@Component({ selector: 'app-greeting', templateUrl: './greeting.html' })",
    'export class Greeting {',
    '  readonly name = input.required<string>();',
    '  readonly loud = input(false);',
    '  readonly text = computed(() => {',
    '    return this.loud() ? hello(this.name()) : this.name();',
    '  });',
    '}',
    '',
  ].join('\n');
  const out = witness.instrument('/p/greeting.ts', component, true);
  assert.equal(out.code.split('\n').length, component.split('\n').length);
  assert.match(out.code, /readonly name = input\.required<string>\(\);/, 'the initialiser survives verbatim: a wrapper here is NG8110');
  assert.match(out.code, /readonly loud = input\(false\);/);
  assert.match(out.code, /readonly text = computed\(\(\) => \{/);
  assert.match(out.code, /return this\.loud\(\) \? \(__witness_\w+\.c\(0, 0\), hello\(this\.name\(\)\)\) : \(__witness_\w+\.c\(0, 1\), this\.name\(\)\);/, 'but the code inside the initialiser is still counted');
  assert.deepEqual(
    out.maps.skipped.map((s) => s.line),
    [6, 7, 8],
    'one per field initialiser, at the line it is written on',
  );
  assert.ok(
    out.maps.skipped.every((s) => s.reason === DECORATED_FIELD),
    'named with the reason, so the driver can explain it rather than report three dead lines',
  );

  const prologue = out.code.slice(0, out.code.indexOf('\n'));
  const embedded = JSON.parse(prologue.slice(prologue.indexOf('", ') + 3, prologue.lastIndexOf(');'))) as { skipped?: Array<{ line: number; reason: string }> };
  assert.deepEqual(embedded.skipped, out.maps.skipped, 'and it rides in the file, because a page cannot be told any other way');

  const plain = witness.instrument('/p/plain.ts', 'export class Plain {\n  readonly name = 1;\n}\n', true);
  assert.deepEqual(plain.maps.skipped, [], 'an undecorated class is not excused: its field initialiser is counted like any other value');
  assert.match(plain.code, /__witness_\w+\.v\(0, "name", 1\)/);
});

/**
 * A test boundary that breaks must be written down, never papered over.
 * Before this, begin() on an open test overwrote it: its lines were lost and
 * everything after was credited to whichever test came last, so a suite
 * whose afterEach never ran, or whose tests interleave, produced a record
 * that looked like any other. Now the open test is closed with its boundary
 * named, and a driver that sees the name refuses to score the run.
 */
test('the runtime: a broken test boundary is recorded, not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-boundary-'));
  const hook = path.join(process.cwd(), 'hooks', 'witness.cjs');
  const script = path.join(dir, 'run.cjs');
  fs.writeFileSync(
    script,
    [
      `const w = require(${JSON.stringify(hook)});`,
      "const W = w.register('h', '/p/a.js', { statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } }, fnMap: {}, branchMap: {}, skipped: [{ line: 7, reason: 'why' }] });",
      "w.begin('t1'); W.s(0);",
      "w.begin('t2'); W.s(0);", // t1 never ended
      'w.end();',
      "w.begin('t3'); W.s(0);",
      "w.end('unterminated');", // what the loader does at process exit
      'w.end();', // nothing open: a no-op, not a record
      "w.unmeasured('/p/b.js', 'could not');",
      `w.writeReport(${JSON.stringify(path.join(dir, 'cov'))});`,
      '',
    ].join('\n'),
  );
  execFileSync(process.execPath, [script], { stdio: 'pipe', env: { ...process.env, [ENV.attributionDir]: dir } });
  const file = fs.readdirSync(dir).find((f) => f.startsWith('attr-witness-'))!;
  const records = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { test: string; boundary?: string; files: Record<string, number[]> });
  assert.deepEqual(
    records.map((r) => [r.test, r.boundary ?? 'clean']),
    [
      ['t1', 'overlapped'],
      ['t2', 'clean'],
      ['t3', 'unterminated'],
    ],
    'three records, two of them marked, and the fourth end() wrote nothing',
  );
  assert.deepEqual(records[0].files, { '/p/a.js': [1] }, 'the overlapped test keeps the lines it had before the next one began');
  const covDir = path.join(dir, 'cov');
  const report = JSON.parse(fs.readFileSync(path.join(covDir, 'coverage-final.json'), 'utf8')) as Record<string, { skipped: unknown }>;
  assert.deepEqual(report['/p/a.js'].skipped, [{ line: 7, reason: 'why' }], 'what the instrumenter skipped rides in the report');
  const unmeasured = fs.readdirSync(covDir).find((f) => f.startsWith('unmeasured-'))!;
  assert.ok(unmeasured, 'a file the loader could not instrument is written beside the report');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(covDir, unmeasured), 'utf8')), [{ path: '/p/b.js', reason: 'could not' }]);
});

/**
 * The Jest transformer. Jest's `process` is synchronous and the instrumenter
 * is not, so this file never instruments: the driver does that before the run
 * and writes the result under the instrumented folder, and this substitutes it
 * for the source before handing it to the project's own transformer. What has
 * to hold is that the substitution happens, that the project's transformer is
 * still the thing that compiles, that a file outside the source root is passed
 * through untouched, and that the cache key moves whenever either the source
 * or the instrumentation does.
 */
test('the Jest transformer substitutes the instrumented source and still calls the project\'s own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-jest-'));
  const sourceRoot = path.join(dir, 'src');
  const instrumentedDir = path.join(dir, 'instrumented');
  fs.mkdirSync(path.join(sourceRoot, 'deep'), { recursive: true });
  fs.mkdirSync(path.join(instrumentedDir, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'deep', 'a.js'), 'ORIGINAL');
  fs.writeFileSync(path.join(instrumentedDir, 'deep', 'a.js'), 'INSTRUMENTED');
  fs.writeFileSync(path.join(sourceRoot, 'plain.js'), 'PLAIN');
  fs.writeFileSync(path.join(dir, 'outside.js'), 'OUTSIDE');
  const upstreamPath = path.join(dir, 'upstream.cjs');
  fs.writeFileSync(
    upstreamPath,
    ["module.exports = { createTransformer: (opts) => ({", "  process: (text) => ({ code: `UP[${opts.tag}](${text})` }),", "  getCacheKey: (text) => `base:${text}`,", '}) };', ''].join('\n'),
  );

  const before = { root: process.env[ENV.sourceRoot], instr: process.env[ENV.instrumentedDir] };
  process.env[ENV.sourceRoot] = sourceRoot;
  process.env[ENV.instrumentedDir] = instrumentedDir;
  try {
    const transformPath = path.resolve('hooks', 'witness-jest-transform.cjs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = require as unknown as { (id: string): { createTransformer: (o: unknown) => { process: (t: string, p: string) => { code: string }; getCacheKey: (t: string, p: string) => string } }; cache: Record<string, unknown> };
    delete req.cache[transformPath];
    const transformer = req(transformPath).createTransformer({ upstream: [upstreamPath, { tag: 'babel' }] });

    assert.equal(transformer.process('ORIGINAL', path.join(sourceRoot, 'deep', 'a.js')).code, 'UP[babel](INSTRUMENTED)', "the instrumented text goes in, and the project's transformer compiles it");
    assert.equal(transformer.process('PLAIN', path.join(sourceRoot, 'plain.js')).code, 'UP[babel](PLAIN)', 'a file with no instrumented copy falls back to its source rather than failing the run');
    assert.equal(transformer.process('OUTSIDE', path.join(dir, 'outside.js')).code, 'UP[babel](OUTSIDE)', 'a file outside the source root is never substituted');

    const key = () => transformer.getCacheKey('ORIGINAL', path.join(sourceRoot, 'deep', 'a.js'));
    const first = key();
    assert.equal(first, key(), 'the same inputs give the same key');
    fs.writeFileSync(path.join(instrumentedDir, 'deep', 'a.js'), 'INSTRUMENTED v2');
    assert.notEqual(first, key(), 'a change in what the instrumenter produced invalidates the cached transform');
    assert.notEqual(
      transformer.getCacheKey('CHANGED', path.join(sourceRoot, 'plain.js')),
      transformer.getCacheKey('PLAIN', path.join(sourceRoot, 'plain.js')),
      'and for a file with no instrumented copy, the source still decides the key',
    );

    // The case the salt exists for, and the case the first version of this test
    // could not see. An upstream whose key does not depend on the text it is
    // given, because it hashes the file on disk or only its own config, would
    // hand back the same key for a file whose instrumented text has changed
    // underneath it, and Jest would serve the stale transform. Removing the
    // salt has to fail here, and with an upstream that keys on the text it
    // cannot, because that upstream hides the defect.
    const blindPath = path.join(dir, 'blind-upstream.cjs');
    fs.writeFileSync(blindPath, ['module.exports = { createTransformer: () => ({', '  process: (text) => ({ code: text }),', "  getCacheKey: (_text, filePath) => `only-the-path:${filePath}`,", '}) };', ''].join('\n'));
    const blind = req(transformPath).createTransformer({ upstream: [blindPath, {}] });
    const target = path.join(sourceRoot, 'deep', 'a.js');
    const blindFirst = blind.getCacheKey('ORIGINAL', target);
    fs.writeFileSync(path.join(instrumentedDir, 'deep', 'a.js'), 'INSTRUMENTED v3');
    assert.notEqual(blindFirst, blind.getCacheKey('ORIGINAL', target), 'the key moves even when the wrapped transformer ignores the text it is handed');
  } finally {
    process.env[ENV.sourceRoot] = before.root;
    process.env[ENV.instrumentedDir] = before.instr;
  }
});

/**
 * The boundary recorder, end to end: instrument one function, run the
 * program, and read what came back.
 *
 * The rewrite has to be invisible to the code it watches. It wraps the body
 * in try/catch rather than in a function, so `this`, `arguments`, and every
 * control-flow statement keep working, and it never attaches anything to a
 * caller-visible promise, because a rejection handler that was not there
 * changes unhandled-rejection behaviour. A recorder that changes what it
 * measures is worse than no recorder.
 */
test('the boundary recorder: entries, returns, throws, and an async boundary observed from inside', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-boundary-'));
  const hooks = hooksFolder(dir);
  const source = [
    'export class Greeter {',
    '  greet(name, loud) {',
    '    if (!name) {',
    '      throw new TypeError("no name");',
    '    }',
    '    if (loud) {',
    '      return name.toUpperCase();',
    '    }',
    '    return name;',
    '  }',
    '}',
    'export function plain(n) {',
    '  if (n < 0) {',
    '    return;',
    '  }',
    '  n + 1;',
    '}',
    'export async function later(x) {',
    '  if (x === 0) {',
    '    throw new RangeError("zero");',
    '  }',
    '  return x * 2;',
    '}',
    'export function mapper(list) {',
    '  const doubled = list.map(function (n) { return n * 2; });',
    '  return doubled.length;',
    '}',
    'export function wrapper() {',
    '  return Promise.reject(new Error("nobody handles me"));',
    '}',
    'export function mutate(bag) {',
    '  bag.items.push("late");',
    '  return bag.items.length;',
    '}',
    '',
  ].join('\n');

  const greet = witness.instrumentBoundary('/p/g.mjs', source, { name: 'greet', container: 'Greeter' });
  assert.ok(greet.ok, 'the method is found by name inside its class');
  assert.equal(greet.target.line, 2);
  assert.equal(greet.target.async, false);
  assert.equal(greet.code.split('\n').length, source.split('\n').length, 'every line stays where it was');
  check(greet.code);

  assert.equal(witness.instrumentBoundary('/p/g.mjs', source, { name: 'missing' }).ok, false);
  const ambiguous = witness.instrumentBoundary('/p/g.mjs', 'function f(){}\nclass A { f(){} }\n', { name: 'f' });
  assert.deepEqual(ambiguous, { ok: false, reason: 'ambiguous', found: 2 }, 'two functions of that name is a question for the caller, never a guess');

  // One file carrying all three boundaries, so one run exercises them all.
  let code = source;
  for (const target of [{ name: 'greet', container: 'Greeter' }, { name: 'plain' }, { name: 'later' }, { name: 'mapper' }, { name: 'wrapper' }, { name: 'mutate' }]) {
    const out = witness.instrumentBoundary('/p/g.mjs', code, target);
    assert.ok(out.ok, `${target.name} is found`);
    code = out.code;
  }
  fs.writeFileSync(path.join(dir, 'g.mjs'), code);
  fs.writeFileSync(
    path.join(dir, 'run.mjs'),
    [
      `import { createRequire } from 'node:module';`,
      `createRequire(import.meta.url)(${JSON.stringify(path.join(hooks, 'witness-boundary.cjs').split(path.sep).join('/'))});`,
      `globalThis.__witness__ = { current: 't1' };`,
      // Counting the rejections Node reports as unhandled is how the run proves
      // the recorder attached nothing: a handler the recorder added would have
      // handled this one, and the count would be zero.
      `let unhandled = 0;`,
      `process.on('unhandledRejection', () => { unhandled += 1; });`,
      `const { Greeter, plain, later, mapper, wrapper, mutate } = await import('./g.mjs');`,
      `const g = new Greeter();`,
      `if (g.greet('Jeff', false) !== 'Jeff') { throw new Error('the rewrite changed the answer'); }`,
      `if (g.greet('Jeff', true) !== 'JEFF') { throw new Error('the rewrite changed the answer'); }`,
      `try { g.greet(''); } catch (e) { if (!(e instanceof TypeError)) { throw new Error('the rewrite changed the error'); } }`,
      `plain(-1);`,
      `if (await later(21) !== 42) { throw new Error('the rewrite changed the answer'); }`,
      `try { await later(0); } catch (e) { if (!(e instanceof RangeError)) { throw new Error('the rewrite changed the rejection'); } }`,
      `if (mapper([1, 2, 3]) !== 3) { throw new Error('the rewrite changed the answer'); }`,
      `wrapper();`,
      `const bag = { items: ['a'] };`,
      `if (mutate(bag) !== 2) { throw new Error('the rewrite changed the answer'); }`,
      `await new Promise((r) => setTimeout(r, 20));`,
      `console.log('ran unhandled=' + unhandled);`,
      '',
    ].join('\n'),
  );
  const out = execFileSync(process.execPath, [path.join(dir, 'run.mjs')], { env: { ...process.env, WITNESS_BOUNDARY_DIR: dir }, encoding: 'utf8' });
  assert.match(out, /ran unhandled=1/, 'the program behaves exactly as it did, and the rejection nobody handled is still unhandled');

  const lines = fs.readdirSync(dir).filter((f) => f.startsWith('boundary-'));
  assert.equal(lines.length, 1);
  const seen = fs.readFileSync(path.join(dir, lines[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { target: string; test: string; index: number; depth: number; args: { t: string; v: unknown }; outcome: { kind: string; value: { t: string; v: unknown } } });

  assert.deepEqual(seen.map((r) => `${r.target}:${r.outcome.kind}`), ['Greeter.greet:return', 'Greeter.greet:return', 'Greeter.greet:throw', 'plain:return', 'later:resolve', 'later:reject', 'mapper:return', 'wrapper:return', 'mutate:return']);
  assert.deepEqual(seen.map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'one index per entry, in entry order, within the test that was running');
  assert.ok(seen.every((r) => r.test === 't1' && r.depth === 0));
  assert.deepEqual(seen[0].args, { t: 'array', v: [{ t: 'str', v: 'Jeff' }, { t: 'bool', v: false }] }, 'arguments as they arrived, in the tagged form the comparator reads');
  assert.deepEqual(seen[1].outcome.value, { t: 'str', v: 'JEFF' });
  assert.deepEqual(seen[2].outcome.value, { t: 'error', v: { name: 'TypeError', message: 'no name' } });
  assert.deepEqual(seen[3].outcome.value, { t: 'undefined' }, 'a bare return records the undefined it hands back');
  assert.deepEqual(seen[4].outcome.value, { t: 'num', v: '42' }, 'an async return is observed inside the async boundary, never on the promise');
  assert.deepEqual(seen[5].outcome.value, { t: 'error', v: { name: 'RangeError', message: 'zero' } });
  assert.deepEqual(seen[6].outcome.value, { t: 'num', v: '3' }, 'a return inside a nested function belongs to that function, not to this boundary');
  assert.deepEqual(seen[7].outcome.value, { t: 'uncomparable', why: 'thenable' }, 'a promise returned by a function that is not async is recorded as uncomparable, never subscribed to');
  assert.deepEqual(seen[8].args, { t: 'array', v: [{ t: 'object', v: { items: { t: 'array', v: [{ t: 'str', v: 'a' }] } } }] }, 'arguments are snapshotted at entry, so a method that mutates what it was handed is not compared against its own mutation');
});
