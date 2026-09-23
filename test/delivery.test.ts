/**
 * Witness: the runner-delivery layer both tools stand on.
 *
 * This layer moved out of DeepTest when the behaviour gate needed it, so
 * the architecture is now:
 *
 *   DeepTest    -> Witness instrumented test run -> the project's own runner
 *   UntangleIt  -> Witness recorded test run     -> the project's own runner
 *
 * DeepTest's own suite still drives every generated config through its
 * runners, so what is proved here is the part DeepTest never exercises: the
 * rewrite contract UntangleIt depends on, where one file in a whole tree is
 * rewritten and every other file has to arrive untouched.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as vm from 'node:vm';
import { writeShadowTree, vitestWrapperConfig, angularKarmaConfig, copyHooks, HOOK_FILES, hooksDir, ENV, repoWasmDir, readBoundaryRecords, isProblem, createInstrumenter, witnessTransform, writeInstrumented, playwrightWrapperConfig, writeShadowTsConfig, posixPath } from '../src/index';
import type { BoundaryRecord, JestResolvedConfig } from '../src/index';

const wasmDir = repoWasmDir();

/** The hooks as a tool copies them into a project, with the instrumenter bundled. */
function hooksFolder(dir: string): string {
  const hooks = path.join(dir, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const f of HOOK_FILES.filter((f) => f !== 'witness-instrument.cjs')) {
    fs.copyFileSync(path.join('hooks', f), path.join(hooks, f));
  }
  fs.copyFileSync(path.join('dist', 'hooks', 'witness-instrument.cjs'), path.join(hooks, 'witness-instrument.cjs'));
  return hooks;
}

function tree(): { root: string; sourceRoot: string; mirror: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-mirror-'));
  const app = path.join(root, 'src', 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'greeting.ts'), 'export function hello(name: string) {\n  return name;\n}\n');
  fs.writeFileSync(path.join(app, 'other.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(app, 'greeting.html'), '<h1>{{ text() }}</h1>\n');
  fs.writeFileSync(path.join(app, 'logo.svg'), '<svg/>\n');
  fs.writeFileSync(path.join(app, 'greeting.spec.ts'), "describe('x', () => {});\n");
  return { root, sourceRoot: path.join(root, 'src'), mirror: path.join(root, '.untangleit', 'instrumented') };
}

/**
 * UntangleIt's use of the mirror: one function in one file is rewritten and
 * the rest of the project has to arrive byte for byte, because a component
 * names its template by relative path and a stylesheet names an image the
 * same way. This is also what keeps UntangleIt out of the person's source.
 */
test('the mirror rewrites only what it is given and copies everything else through untouched', () => {
  const { root, sourceRoot, mirror } = tree();
  const asked: string[] = [];
  const out = writeShadowTree({
    workspaceRoot: root,
    sourceRoot,
    instrumentedDir: mirror,
    files: ['src/app/greeting.ts'],
    rewrite: (absolute, source) => {
      asked.push(absolute);
      return source.replace('return name;', 'return name; /* recorded */');
    },
  });

  assert.deepEqual(out.rewritten, ['src/app/greeting.ts']);
  assert.deepEqual(out.refused, []);
  assert.equal(asked.length, 1, 'a rewrite is offered exactly the files it was given, and no others');
  assert.match(asked[0], /\/src\/app\/greeting\.ts$/, 'always forward slashes, whatever the host');

  assert.match(fs.readFileSync(path.join(mirror, 'app', 'greeting.ts'), 'utf8'), /recorded/);
  for (const [beside, text] of [
    ['other.ts', 'export const x = 1;\n'],
    ['greeting.html', '<h1>{{ text() }}</h1>\n'],
    ['logo.svg', '<svg/>\n'],
    ['greeting.spec.ts', "describe('x', () => {});\n"],
  ]) {
    assert.equal(fs.readFileSync(path.join(mirror, 'app', beside), 'utf8'), text, `${beside} arrives as it was, or the reference to it dangles`);
  }
  assert.equal(out.copied, 4, 'and the file that was rewritten is not also copied over the top of itself');
});

/**
 * Returning undefined means "leave this one alone", which is how a caller
 * hands the mirror a candidate set and decides file by file. The file must
 * then take the ordinary copy path exactly once: an earlier shape of this
 * skipped it in both passes and left a hole in the tree, and a hole is a
 * build failure rather than a measurement anyone would question.
 */
test('a rewrite that declines a file leaves it to the copy pass, once', () => {
  const { root, sourceRoot, mirror } = tree();
  const out = writeShadowTree({
    workspaceRoot: root,
    sourceRoot,
    instrumentedDir: mirror,
    files: ['src/app/greeting.ts', 'src/app/other.ts'],
    rewrite: (absolute, source) => (absolute.endsWith('other.ts') ? undefined : `${source}// touched\n`),
  });

  assert.deepEqual(out.rewritten, ['src/app/greeting.ts']);
  assert.equal(fs.readFileSync(path.join(mirror, 'app', 'other.ts'), 'utf8'), 'export const x = 1;\n', 'declined means untouched, not missing');
  assert.equal(out.copied, 4, 'the declined file is copied through with the rest, and only with the rest');
});

/**
 * A file the rewrite cannot take is still a module the build expects to
 * find. The original goes in its place so the build succeeds and the file
 * runs as written, and the caller is told which file and why, because a
 * file that silently vanished from a report reads as "nothing wrong here".
 */
test('a rewrite that throws leaves the original in the mirror and reports the reason', () => {
  const { root, sourceRoot, mirror } = tree();
  const out = writeShadowTree({
    workspaceRoot: root,
    sourceRoot,
    instrumentedDir: mirror,
    files: ['src/app/greeting.ts'],
    rewrite: () => {
      throw new Error('the parser refused this file\nand said more about it');
    },
  });

  assert.deepEqual(out.rewritten, []);
  assert.deepEqual(out.refused, [{ path: 'src/app/greeting.ts', reason: 'the parser refused this file' }], 'the first line of the reason, so a log line stays a line');
  assert.equal(fs.readFileSync(path.join(mirror, 'app', 'greeting.ts'), 'utf8'), 'export function hello(name: string) {\n  return name;\n}\n', 'the original stands in, or the build has a hole where a module should be');
});

/** A file named but not present is refused rather than crashing the mirror. */
test('a file that is not there is refused, and the rest of the tree is still mirrored', () => {
  const { root, sourceRoot, mirror } = tree();
  const out = writeShadowTree({
    workspaceRoot: root,
    sourceRoot,
    instrumentedDir: mirror,
    files: ['src/app/gone.ts'],
    rewrite: (_absolute, source) => source,
  });

  assert.equal(out.refused.length, 1);
  assert.equal(out.refused[0].path, 'src/app/gone.ts');
  assert.ok(!fs.existsSync(path.join(mirror, 'app', 'gone.ts')), 'nothing is invented in its place');
  assert.ok(fs.existsSync(path.join(mirror, 'app', 'greeting.html')), 'and one missing file does not stop the mirror');
});

/** Every hook a runner might need, in the calling tool's own folder. */
test('the hooks are copied into the folder the calling tool names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-hooks-'));
  // The source tree's hooks folder. In a built package this is the default,
  // dist/hooks beside the compiled module, which is what a tool copies from.
  const source = path.join(__dirname, '..', 'hooks');
  const out = copyHooks(path.join(dir, '.untangleit', 'hooks'), source);
  assert.equal(out, path.join(dir, '.untangleit', 'hooks'));
  for (const file of HOOK_FILES) {
    if (file === 'witness-instrument.cjs') {
      // The only one the build makes rather than ships: it is the whole
      // instrumenter bundled for a process without this package's node_modules.
      continue;
    }
    assert.ok(fs.existsSync(path.join(out, file)), `${file} is copied, or the runner that needs it cannot find it`);
  }
  assert.ok(fs.existsSync(path.join(out, 'witness-boundary.cjs')), 'including the boundary runtime, which is what makes a recorded run reachable at all');
  assert.ok(fs.existsSync(path.join(hooksDir().replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`), 'witness-boundary.cjs')), 'and the build puts it in the package, or nothing above can copy it');
});

/**
 * Both generated configs name the tool that generated them. They are
 * written into a person's project and a person reads them, so "do not edit"
 * has to say who wrote it.
 */
test('a generated config says which tool wrote it, because two tools now write them', () => {
  const vitest = vitestWrapperConfig({ tool: 'UntangleIt', workDir: path.join('p', '.untangleit'), hookDir: path.join('p', '.untangleit', 'hooks'), wasmDir: path.join('w'), sourceRoot: path.join('p', 'src'), workspaceRoot: 'p' });
  assert.match(vitest, /Generated by UntangleIt on every run/);
  assert.match(vitest, /witnessPlugin/, "the project's own config is merged, never replaced");
  assert.match(vitest, /setupFiles: \[/, 'and the Witness setup file goes ahead of the project\'s, or the runtime is too late');

  const karma = angularKarmaConfig({ tool: 'UntangleIt', workspaceRoot: '/p', hookDir: '/p/.untangleit/hooks' });
  assert.match(karma, /Generated by UntangleIt on every run/);
  assert.match(karma, /witness-karma\.cjs/);
});

/**
 * A recorded run through the loader, which is how Mocha and plain Node
 * reach the boundary recorder. The whole point of routing it through the
 * existing loader rather than a second delivery path is that UntangleIt
 * needs nothing DeepTest did not already have; the loader just has to know
 * which function is being watched.
 *
 * What has to be true, and each of these has been wrong at some point in a
 * design that looked fine: only the one file is touched, every other file
 * runs exactly as written, the program behaves identically, and a target
 * that cannot be found says so instead of producing an empty run that reads
 * as a method no test reached.
 */
test('a recorded run through the loader watches one function and leaves the rest of the project alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-recorded-'));
  const hooks = hooksFolder(dir);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'greeter.mjs'), ['export class Greeter {', '  greet(name) {', '    if (!name) {', '      throw new TypeError("no name");', '    }', '    return `Hello, ${name}`;', '  }', '}', ''].join('\n'));
  fs.writeFileSync(path.join(src, 'other.cjs'), 'function untouched(n) {\n  return n + 1;\n}\nmodule.exports = { untouched };\n');
  fs.writeFileSync(
    path.join(dir, 'run.mjs'),
    [
      `globalThis.__witness__ = { current: 'spec.js::greets' };`,
      `const { Greeter } = await import('./src/greeter.mjs');`,
      `const { createRequire } = await import('node:module');`,
      `const { untouched } = createRequire(import.meta.url)('./src/other.cjs');`,
      `const g = new Greeter();`,
      `if (g.greet('Jeff') !== 'Hello, Jeff') { throw new Error('the rewrite changed the answer'); }`,
      `try { g.greet(''); } catch (e) { if (!(e instanceof TypeError)) { throw new Error('the rewrite changed the error'); } }`,
      `if (untouched(1) !== 2) { throw new Error('a file nobody asked about was changed'); }`,
      `console.log('ran');`,
      '',
    ].join('\n'),
  );

  const run = (target: Record<string, unknown>, into: string): BoundaryRecord[] => {
    fs.mkdirSync(into, { recursive: true });
    const out = execFileSync(process.execPath, ['--import', pathToFileURL(path.join(hooks, 'witness-loader.mjs')).href, path.join(dir, 'run.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, [ENV.hooksDir]: hooks, [ENV.wasmDir]: wasmDir, [ENV.sourceRoot]: src, [ENV.boundaryDir]: into, WITNESS_BOUNDARY_TARGET: JSON.stringify(target) },
    });
    assert.match(out, /ran/, 'the program behaves exactly as it did, recorded or not');
    return readBoundaryRecords(into);
  };

  const seen = run({ file: path.join(src, 'greeter.mjs').split(path.sep).join('/'), name: 'greet', container: 'Greeter' }, path.join(dir, 'rec'));
  assert.deepEqual(
    seen.map((r) => (isProblem(r) ? r.problem : `${r.target}:${r.outcome.kind}`)),
    ['Greeter.greet:return', 'Greeter.greet:throw'],
    'both paths through the watched method, and nothing from anywhere else',
  );
  const first = seen[0];
  assert.ok(!isProblem(first));
  assert.equal(first.test, 'spec.js::greets', 'the test that was running, from the counter runtime the recorder shares');
  assert.deepEqual(first.args, { t: 'array', v: [{ t: 'str', v: 'Jeff' }] });

  // The other file ran as written: no counters, no boundary handle, nothing.
  assert.equal(fs.readFileSync(path.join(src, 'other.cjs'), 'utf8'), 'function untouched(n) {\n  return n + 1;\n}\nmodule.exports = { untouched };\n', 'and the person\'s source on disk is never edited either way');

  const missing = run({ file: path.join(src, 'greeter.mjs').split(path.sep).join('/'), name: 'notThere' }, path.join(dir, 'rec2'));
  assert.deepEqual(missing, [{ problem: 'target-not-found', target: 'notThere' }], 'a name that resolves to nothing says so, rather than leaving an empty run to be read as a method no test reached');

  const ambiguous = run({ file: path.join(src, 'greeter.mjs').split(path.sep).join('/'), name: 'greet' }, path.join(dir, 'rec3'));
  assert.deepEqual(ambiguous.filter(isProblem), [], 'one match without a container is still one match');

  const neverLoaded = run({ file: path.join(src, 'nothing-here.mjs').split(path.sep).join('/'), name: 'greet' }, path.join(dir, 'rec4'));
  assert.deepEqual(neverLoaded, [{ problem: 'target-not-found', target: 'greet' }], 'a file the run never loaded is reported too: never reached and never watched are different answers');
});

/**
 * A recorded run through Vitest, which is the runner most Polyglot projects
 * use. It goes through the same generated wrapper config and the same Vite
 * plugin DeepTest's measured runs go through: the recorder is reachable
 * because the delivery already existed, which is the whole point of putting
 * this layer in Witness rather than building a second one in UntangleIt.
 *
 * A generated-string test cannot prove a path records anything, so this one
 * runs the runner.
 */
test('a recorded run through Vitest records the watched method and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-vitest-rec-'));
  const hooks = hooksFolder(dir);
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  // The runner and its config resolve from the project, as they do in a real one.
  fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","private":true,"type":"module"}\n');
  fs.writeFileSync(path.join(src, 'greeter.ts'), ['export class Greeter {', '  greet(name: string, loud: boolean): string {', '    if (!name) {', '      throw new TypeError("no name");', '    }', '    return loud ? name.toUpperCase() : name;', '  }', '}', 'export function untouched(n: number): number {', '  return n + 1;', '}', ''].join('\n'));
  fs.writeFileSync(
    path.join(dir, 'test', 'greeter.test.ts'),
    ['import { test, expect } from "vitest";', 'import { Greeter, untouched } from "../src/greeter";', 'test("greets", () => {', '  const g = new Greeter();', '  expect(g.greet("Jeff", false)).toBe("Jeff");', '  expect(g.greet("Jeff", true)).toBe("JEFF");', '});', 'test("refuses", () => {', '  expect(() => new Greeter().greet("", false)).toThrow(TypeError);', '  expect(untouched(1)).toBe(2);', '});', ''].join('\n'),
  );

  const workDir = path.join(dir, '.untangleit');
  fs.mkdirSync(workDir, { recursive: true });
  const boundaryDir = path.join(workDir, 'boundary');
  fs.mkdirSync(boundaryDir, { recursive: true });
  const wrapperPath = path.join(workDir, 'vitest.config.mjs');
  fs.writeFileSync(wrapperPath, vitestWrapperConfig({ tool: 'UntangleIt', workDir, hookDir: hooks, wasmDir, sourceRoot: src, workspaceRoot: dir }), 'utf8');

  execFileSync(process.execPath, [path.resolve('node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', wrapperPath], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      [ENV.hooksDir]: hooks,
      [ENV.wasmDir]: wasmDir,
      [ENV.sourceRoot]: src,
      [ENV.boundaryDir]: boundaryDir,
      WITNESS_BOUNDARY_TARGET: JSON.stringify({ file: path.join(src, 'greeter.ts').split(path.sep).join('/'), name: 'greet', container: 'Greeter' }),
      CI: 'true',
      NO_COLOR: '1',
    },
  });

  const seen = readBoundaryRecords(boundaryDir);
  assert.deepEqual(
    seen.map((r) => (isProblem(r) ? r.problem : `${r.target}:${r.outcome.kind}`)),
    ['Greeter.greet:return', 'Greeter.greet:return', 'Greeter.greet:throw'],
    'three entries to the watched method, and nothing from the function beside it',
  );
  const first = seen[0];
  assert.ok(!isProblem(first));
  assert.equal(first.test, 'test/greeter.test.ts::greets', "the test that was running, from Vitest's own state");
  assert.deepEqual(first.args, { t: 'array', v: [{ t: 'str', v: 'Jeff' }, { t: 'bool', v: false }] });
  const last = seen[2];
  assert.ok(!isProblem(last));
  assert.equal(last.test, 'test/greeter.test.ts::refuses', 'and a second test is a second identity, or nothing could ever be paired');
  assert.deepEqual(last.outcome.value, { t: 'error', v: { name: 'TypeError', message: 'no name' } });
});

/** Whether this machine can run the Python recorder at all. */
function pytestAvailable(): string | undefined {
  for (const interpreter of ['python3', 'python']) {
    try {
      execFileSync(interpreter, ['-m', 'pytest', '--version'], { stdio: 'ignore' });
      return interpreter;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/**
 * The Python recorder, and the reason it is in this suite beside the
 * JavaScript one: there is one behaviour gate and one meaning of
 * equivalent, so the two recorders have to produce the same records for the
 * same method. They are asserted against the same expected lines.
 *
 * Python needs no shadow tree and no loader. A pytest plugin wraps the
 * target by module and qualified name, which is why this path was the one
 * that worked first and exposed that the JavaScript half had no delivery.
 */
test('the Python recorder writes the same records the JavaScript one writes', () => {
  const interpreter = pytestAvailable();
  if (!interpreter) {
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-pytest-'));
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'pkg', 'greeter.py'), ['class Greeter:', '    def greet(self, name, loud=False):', '        if not name:', '            raise TypeError("no name")', '        return name.upper() if loud else name', '', '', 'class Other:', '    def elsewhere(self):', '        return 1', '', '', 'def untouched(n):', '    return n + 1', ''].join('\n'));
  fs.writeFileSync(
    path.join(dir, 'tests', 'test_greeter.py'),
    ['import pytest', 'from pkg.greeter import Greeter, untouched', '', '', 'def test_greets():', '    g = Greeter()', '    assert g.greet("Jeff", False) == "Jeff"', '    assert g.greet("Jeff", loud=True) == "JEFF"', '    assert g.greet("Ann") == "Ann"', '', '', 'def test_refuses():', '    with pytest.raises(TypeError):', '        Greeter().greet("")', '    assert untouched(1) == 2', ''].join('\n'),
  );
  const boundaryDir = path.join(dir, '.untangleit', 'boundary');
  fs.mkdirSync(boundaryDir, { recursive: true });
  const hooks = copyHooks(path.join(dir, '.untangleit', 'hooks'), path.join(__dirname, '..', 'hooks'));

  execFileSync(interpreter, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-p', 'witness_boundary', 'tests'], {
    cwd: dir,
    encoding: 'utf8',
    // No container: the editor knows the file and the name, not the class.
    env: { ...process.env, PYTHONPATH: `${dir}${path.delimiter}${hooks}`, [ENV.boundaryDir]: boundaryDir, WITNESS_BOUNDARY_TARGET: JSON.stringify({ module: 'pkg.greeter', name: 'greet' }) },
  });

  const seen = readBoundaryRecords(boundaryDir);
  assert.deepEqual(seen.map((r) => (isProblem(r) ? r.problem : `${r.target}:${r.outcome.kind}`)), ['Greeter.greet:return', 'Greeter.greet:return', 'Greeter.greet:return', 'Greeter.greet:throw']);
  const first = seen[0];
  assert.ok(!isProblem(first));
  assert.deepEqual(first.args, { t: 'array', v: [{ t: 'str', v: 'Jeff' }, { t: 'bool', v: false }] }, 'the receiver is not an argument, exactly as JavaScript never records `this`');
  const second = seen[1];
  assert.ok(!isProblem(second));
  assert.deepEqual(second.args, { t: 'array', v: [{ t: 'str', v: 'Jeff' }, { t: 'bool', v: true }] }, 'a keyword call and a positional call are the same call, or two runs of an unchanged test could never pair');
  assert.equal(second.test, 'tests/test_greeter.py::test_greets', "the test identity is pytest's own node id");
  const third = seen[2];
  assert.ok(!isProblem(third));
  assert.deepEqual(third.args, { t: 'array', v: [{ t: 'str', v: 'Ann' }, { t: 'bool', v: false }] }, 'the arguments the call effectively received, defaults applied, so a default the assistant changes is visible rather than missing');
  const fourth = seen[3];
  assert.ok(!isProblem(fourth));
  assert.deepEqual(fourth.outcome.value, { t: 'error', v: { name: 'TypeError', message: 'no name' } });
  assert.equal(fourth.test, 'tests/test_greeter.py::test_refuses');
});

/** A target the Python recorder cannot attach to says which, and says it once. */
test('the Python recorder reports a target it could not attach to', () => {
  const interpreter = pytestAvailable();
  if (!interpreter) {
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-pytest-miss-'));
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg', '__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'pkg', 'greeter.py'), 'class Greeter:\n    @staticmethod\n    def shout(name):\n        return name.upper()\n');
  fs.writeFileSync(path.join(dir, 'tests', 'test_greeter.py'), 'from pkg.greeter import Greeter\n\n\ndef test_shouts():\n    assert Greeter.shout("a") == "A"\n');
  const hooks = copyHooks(path.join(dir, '.untangleit', 'hooks'), path.join(__dirname, '..', 'hooks'));

  const run = (target: Record<string, unknown>, into: string): BoundaryRecord[] => {
    fs.mkdirSync(into, { recursive: true });
    execFileSync(interpreter, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-p', 'witness_boundary', 'tests'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: `${dir}${path.delimiter}${hooks}`, [ENV.boundaryDir]: into, WITNESS_BOUNDARY_TARGET: JSON.stringify(target) },
    });
    return readBoundaryRecords(into);
  };

  assert.deepEqual(run({ module: 'pkg.greeter', name: 'missing' }, path.join(dir, 'r1')), [{ problem: 'target-not-found', target: 'missing' }]);
  // No container given, which is all the editor knows for a Python method.
  assert.deepEqual(run({ module: 'pkg.greeter', name: 'shout' }, path.join(dir, 'r4')), [{ problem: 'unsupported-target', target: 'Greeter.shout' }], 'the class holding the name is found without being told, and the method is still refused for the right reason');
  assert.deepEqual(run({ module: 'pkg.nothing', name: 'greet' }, path.join(dir, 'r2')), [{ problem: 'target-not-found', target: 'greet' }], 'a module that does not import is not a method the tests failed to reach');
  assert.deepEqual(
    run({ module: 'pkg.greeter', name: 'shout', container: 'Greeter' }, path.join(dir, 'r3')),
    [{ problem: 'unsupported-target', target: 'Greeter.shout' }],
    'a descriptor needs its own rewrapping, and a recorder that guessed at one would be changing what it measures',
  );
  // Four pytest processes, one per case, so this is the slowest test in the
  // suite and on a Windows machine it runs past Vitest's five-second default.
  // The time is the runs themselves; nothing here waits on anything.
}, 15_000);

/**
 * A recorded run through Jest. Jest's transform contract is synchronous and
 * the instrumenter is not, so this path pre-instruments and the transformer
 * substitutes the text. A recorded run writes exactly one file there, which
 * is the whole difference from a measured run: one function watched, every
 * other file transformed by the project's own transformer as always.
 */
test('a recorded run through Jest substitutes one pre-instrumented file and records it', async () => {
  const jestDir = path.resolve('..', 'DeepTest', 'node_modules', 'jest');
  if (!fs.existsSync(jestDir)) {
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-jest-rec-'));
  const hooks = hooksFolder(dir);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.symlinkSync(path.resolve('..', 'DeepTest', 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","private":true}\n');
  fs.writeFileSync(path.join(src, 'greeter.js'), ['class Greeter {', '  greet(name, loud) {', '    if (!name) {', '      throw new TypeError("no name");', '    }', '    return loud ? name.toUpperCase() : name;', '  }', '}', 'function untouched(n) {', '  return n + 1;', '}', 'module.exports = { Greeter, untouched };', ''].join('\n'));
  fs.writeFileSync(
    path.join(dir, 'test', 'greeter.test.js'),
    ['const { Greeter, untouched } = require("../src/greeter");', 'test("greets", () => {', '  expect(new Greeter().greet("Jeff", false)).toBe("Jeff");', '});', 'test("refuses", () => {', '  expect(() => new Greeter().greet("", false)).toThrow(TypeError);', '  expect(untouched(1)).toBe(2);', '});', ''].join('\n'),
  );

  const workDir = path.join(dir, '.untangleit');
  const boundaryDir = path.join(workDir, 'boundary');
  const instrumentedDir = path.join(workDir, 'instrumented');
  fs.mkdirSync(boundaryDir, { recursive: true });

  // Exactly one file is pre-instrumented: the one holding the watched method.
  const target = path.join(src, 'greeter.js');
  const instrumenter = await createInstrumenter(wasmDir);
  const rewritten = instrumenter.instrumentBoundary(target.split(path.sep).join('/'), fs.readFileSync(target, 'utf8'), { name: 'greet', container: 'Greeter' });
  assert.ok(rewritten.ok);
  writeInstrumented(instrumentedDir, src, target, rewritten.code);

  const bin = path.join(jestDir, 'bin', 'jest.js');
  const shown = execFileSync(process.execPath, [bin, '--showConfig'], { cwd: dir, encoding: 'utf8' });
  const resolved = (JSON.parse(shown) as { configs?: JestResolvedConfig[] }).configs?.[0];
  const transform = witnessTransform(resolved?.transform, path.join(hooks, 'witness-jest-transform.cjs'));
  assert.ok(transform, "the project's own transformer is what gets wrapped, so a project that transforms differently keeps doing that");

  execFileSync(process.execPath, [bin, '--ci', '--transform', JSON.stringify(transform), '--setupFiles', path.join(hooks, 'witness-jest-runtime.cjs'), '--setupFilesAfterEnv', path.join(hooks, 'witness-jest.cjs')], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      [ENV.hooksDir]: hooks,
      [ENV.wasmDir]: wasmDir,
      [ENV.sourceRoot]: src,
      [ENV.instrumentedDir]: instrumentedDir,
      [ENV.boundaryDir]: boundaryDir,
      WITNESS_BOUNDARY_TARGET: JSON.stringify({ file: target.split(path.sep).join('/'), name: 'greet', container: 'Greeter' }),
      CI: 'true',
      NO_COLOR: '1',
    },
  });

  const seen = readBoundaryRecords(boundaryDir);
  assert.deepEqual(seen.map((r) => (isProblem(r) ? r.problem : `${r.target}:${r.outcome.kind}`)), ['Greeter.greet:return', 'Greeter.greet:throw']);
  const first = seen[0];
  assert.ok(!isProblem(first));
  assert.equal(first.test, 'test/greeter.test.js::greets');
  assert.deepEqual(first.args, { t: 'array', v: [{ t: 'str', v: 'Jeff' }, { t: 'bool', v: false }] });
}, 15_000);

/**
 * The boundary runtime in a browser page, where there is no disk.
 *
 * Angular's Karma runner and Playwright's component tests both run the code
 * under test in a browser, so the recorder has to work there or the gate
 * silently does nothing on two runners Polyglot already supports. It is
 * evaluated here with no Node modules available at all, which is what a
 * page is, so the failure mode is a failing test rather than a browser
 * console nobody reads.
 */
test('the boundary runtime works with no filesystem, and hands its records to whatever can carry them out', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'witness-boundary.cjs'), 'utf8');
  const page: Record<string, unknown> = {};
  const context = vm.createContext({
    globalThis: page,
    require: () => {
      throw new Error('there is no require in a browser');
    },
    JSON,
    Set,
    Map,
    Array,
    Object,
    Date,
    RegExp,
    Error,
    String,
    Number,
    Boolean,
  });
  (context as { globalThis: Record<string, unknown> }).globalThis = context as unknown as Record<string, unknown>;
  vm.runInContext(source, context);

  const runtime = (context as unknown as { __witnessBoundary__: { enter(t: string, a: unknown[] | null, async: boolean): { returned<T>(v: T): T; threw(e: unknown): void; fellThrough(): void }; drain(): BoundaryRecord[]; recording: boolean } }).__witnessBoundary__;
  assert.ok(runtime, 'it loads at all, which it did not while it required node:fs at the top');
  assert.equal(runtime.recording, true, 'a page with no disk is still recording, or a fixture would report nothing was configured');

  runtime.enter('Greeter.greet', ['Jeff', false], false).returned('Jeff');
  runtime.enter('Greeter.greet', [''], false).threw(new TypeError('no name'));

  // Through JSON, because that is how a page hands records back: Karma's
  // `__karma__.info` and Playwright's fixture both serialise them.
  const carried = JSON.parse(JSON.stringify(runtime.drain())) as BoundaryRecord[];
  assert.deepEqual(
    carried.map((r) => (isProblem(r) ? r.problem : `${r.target}:${r.outcome.kind}`)),
    ['Greeter.greet:return', 'Greeter.greet:throw'],
    'the same records a Node run writes, in the same shape, because one reader understands them all',
  );
  const first = carried[0];
  assert.ok(!isProblem(first));
  assert.deepEqual(first.args, { t: 'array', v: [{ t: 'str', v: 'Jeff' }, { t: 'bool', v: false }] });
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.drain())), [], 'drained means drained, or a client that polls would ship every record twice');
});

/**
 * The Karma wire, without a browser.
 *
 * Angular's Karma runner is the one place a wrong answer is hardest to
 * notice: the records are made in a page, shipped over `__karma__.info`,
 * and written on the Node side, and if any link is missing the run still
 * passes and the gate reports a method the tests never reached. So the
 * reporter half is driven directly here, with the message shape the client
 * sends, and the framework half is asked what it puts in front of the specs.
 */
test('the Karma plugin serves the boundary runtime and writes what the page sends back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-karma-'));
  const boundaryDir = path.join(dir, 'boundary');
  const before = { target: process.env.WITNESS_BOUNDARY_TARGET, dir: process.env.WITNESS_BOUNDARY_DIR };
  process.env.WITNESS_BOUNDARY_TARGET = JSON.stringify({ file: '/p/src/greeter.ts', name: 'greet', container: 'Greeter' });
  process.env.WITNESS_BOUNDARY_DIR = boundaryDir;
  try {
    // A fresh require: the plugin reads the environment once, at load.
    const pluginPath = require.resolve(path.join(__dirname, '..', 'hooks', 'witness-karma.cjs'));
    delete require.cache[pluginPath];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const plugin = require(pluginPath) as Record<string, [string, (...args: never[]) => void]>;

    const served: Array<{ pattern: string }> = [];
    (plugin['framework:witness'][1] as unknown as (files: Array<{ pattern: string }>) => void)(served);
    const names = served.map((f) => path.basename(f.pattern));
    assert.deepEqual(names, ['witness.cjs', 'witness-boundary.cjs', 'witness-karma-client.js'], 'the runtime, then the boundary runtime, then the client: a page loads them in the order they are listed, and the rewritten function calls the boundary runtime the moment it is entered');

    const handlers: Record<string, (browser: unknown, info: unknown) => void> = {};
    (plugin['reporter:witness'][1] as unknown as (emitter: { on(event: string, fn: (b: unknown, i: unknown) => void): void }) => void)({
      on: (event, fn) => {
        handlers[event] = fn;
      },
    });
    assert.ok(handlers.browser_info, 'the reporter listens, or nothing the page sends is ever written');

    handlers.browser_info(undefined, {
      witness: {
        boundary: [
          { target: 'Greeter.greet', test: 'src/app.spec.ts::greets', index: 0, depth: 0, args: { t: 'array', v: [{ t: 'str', v: 'Jeff' }] }, outcome: { kind: 'return', value: { t: 'str', v: 'Jeff' } } },
          { problem: 'target-not-found', target: 'Greeter.gone' },
        ],
      },
    });
    handlers.browser_info(undefined, { witness: { boundary: [] } });

    const seen = readBoundaryRecords(boundaryDir);
    assert.deepEqual(seen.map((r) => (isProblem(r) ? r.problem : `${r.target}:${r.outcome.kind}`)), ['Greeter.greet:return', 'target-not-found'], 'written through untouched, in the same shape every other runner writes');
  } finally {
    process.env.WITNESS_BOUNDARY_TARGET = before.target;
    process.env.WITNESS_BOUNDARY_DIR = before.dir;
    if (before.target === undefined) {
      delete process.env.WITNESS_BOUNDARY_TARGET;
    }
    if (before.dir === undefined) {
      delete process.env.WITNESS_BOUNDARY_DIR;
    }
  }
});

/**
 * A page with no per-test hook records no identity, and says so.
 *
 * Karma has a hook, through its Jasmine client, so its records carry the
 * test the counter runtime was on. A component-testing page has none: the
 * runner navigates it while its own fixtures are setting up, so anything
 * added from a fixture arrives too late. The runtime records null rather
 * than inventing one, and whatever carries the records out of the page
 * stamps the identity on the way past, which is the moment it is certain.
 */
test('the boundary runtime records no identity when the page has no test boundary, rather than inventing one', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'witness-boundary.cjs'), 'utf8');
  const load = (globals: Record<string, unknown>): { enter(t: string, a: unknown[] | null, async: boolean): { returned<T>(v: T): T }; drain(): BoundaryRecord[] } => {
    const context = vm.createContext({
      require: () => {
        throw new Error('there is no require in a browser');
      },
      JSON,
      Set,
      Map,
      Array,
      Object,
      Date,
      RegExp,
      Error,
      String,
      Number,
      Boolean,
      ...globals,
    });
    (context as { globalThis?: unknown }).globalThis = context;
    vm.runInContext(source, context);
    return (context as unknown as { __witnessBoundary__: { enter(t: string, a: unknown[] | null, async: boolean): { returned<T>(v: T): T }; drain(): BoundaryRecord[] } }).__witnessBoundary__;
  };

  const withRunner = load({ __witness__: { current: 'src/app.spec.ts::the real one' } });
  withRunner.enter('Greeter.greet', ['Jeff'], false).returned('Jeff');
  const fromRunner = JSON.parse(JSON.stringify(withRunner.drain()))[0] as BoundaryRecord;
  assert.ok(!isProblem(fromRunner));
  assert.equal(fromRunner.test, 'src/app.spec.ts::the real one', 'a runner with a test boundary supplies it, and Karma is one');

  const bare = load({});
  bare.enter('Greeter.greet', ['Jeff'], false).returned('Jeff');
  const anonymous = JSON.parse(JSON.stringify(bare.drain()))[0] as BoundaryRecord;
  assert.ok(!isProblem(anonymous));
  assert.equal(anonymous.test, null, 'and with none it records null, which the carrier stamps and the gate would otherwise read as evidence it cannot pair');
});

/**
 * Finding the method by line, which is what the run before the hand-off
 * does and what gives the run afterwards a container to search by.
 *
 * A name alone is not enough after the gap. The assistant moved the method
 * and nothing here knows where, so the second run searches by name inside
 * its container; without the container, any file holding a `greet` on a
 * class and a `greet` beside it resolves to two functions and the gate
 * compares nothing.
 */
test('the boundary locator names the method on a line and the class it belongs to', async () => {
  const instrumenter = await createInstrumenter(wasmDir);
  const source = ['export class Greeter {', '  greet(name: string) {', '    return name;', '  }', '}', 'export function greet(name: string) {', '  return name;', '}', 'const shout = (name: string) => name.toUpperCase();', ''].join('\n');

  assert.deepEqual(instrumenter.locateBoundary('/p/g.ts', source, 2), { name: 'greet', container: 'Greeter', line: 2, endLine: 4, async: false });
  assert.deepEqual(instrumenter.locateBoundary('/p/g.ts', source, 6), { name: 'greet', line: 6, endLine: 8, async: false }, 'the one beside the class has no container, and that is what tells the two apart');
  assert.deepEqual(instrumenter.locateBoundary('/p/g.ts', source, 9), { name: 'shout', line: 9, endLine: 9, async: false }, 'an arrow takes its name from what it is assigned to');
  assert.equal(instrumenter.locateBoundary('/p/g.ts', source, 3), undefined, 'a line inside a method starts no function');

  // And the two together: located by line, then instrumented by what the
  // locator said, which is the exact hand-off the loop makes.
  const found = instrumenter.locateBoundary('/p/g.ts', source, 2)!;
  const out = instrumenter.instrumentBoundary('/p/g.ts', source, { name: found.name, container: found.container });
  assert.ok(out.ok, 'a name plus its container resolves to exactly one function where the name alone resolves to two');
  assert.equal(instrumenter.instrumentBoundary('/p/g.ts', source, { name: 'greet' }).ok, false, 'and the name alone is refused, rather than guessed at');

  const asyncSource = 'export class Q {\n  async run() {\n    return 1;\n  }\n}\n';
  assert.equal(instrumenter.locateBoundary('/p/q.ts', asyncSource, 2)?.async, true);
});

/**
 * Every config this layer generates has to stay valid JavaScript when the
 * project sits in a folder whose name contains an apostrophe, a quote, or a
 * space. "C:\workspace\MikeVan's AI Development Toolkit" is a real path and
 * it is where all of this is built.
 *
 * Nothing here has ever been written by pasting a path between quotes, and
 * this test exists to keep it that way: a path goes into generated code
 * through JSON.stringify or it does not go in. The 1.0.19 browser
 * qualification spent a day on two upstream bugs of exactly this shape, one
 * in Angular's polyfills module and one in Playwright's component index, so
 * the cost of getting it wrong is no longer theoretical.
 */
test('generated configs stay valid JavaScript when the path holds an apostrophe, a quote, or a space', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-quotes-'));
  const check = (name: string, code: string): void => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, code, 'utf8');
    // node --check parses without running, which is the question being asked.
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  };

  // Every character a Windows path may legally hold that could end a string
  // literal, plus a backslash, which is what a naive writer forgets second.
  const nasty = path.join(dir, "MikeVan's \u0022AI\u0022 Toolkit", 'a b');
  // The hooks folder carries one too, because the Vitest wrapper imports the
  // plugin by a path relative to the work directory: an apostrophe only in
  // the absolute part would leave that import looking safe when it is not.
  const hooks = path.join(nasty, "hook's");

  check('vitest.config.mjs', vitestWrapperConfig({ tool: "MikeVan's tool", workDir: nasty, hookDir: hooks, wasmDir: nasty, sourceRoot: path.join(nasty, 'src'), workspaceRoot: nasty }));
  check('vitest.user.config.mjs', vitestWrapperConfig({ tool: 'UntangleIt', workDir: nasty, hookDir: hooks, wasmDir: nasty, sourceRoot: path.join(nasty, 'src'), workspaceRoot: nasty, userConfig: "vite's.config.ts" }));
  check('karma.conf.cjs', angularKarmaConfig({ tool: 'UntangleIt', workspaceRoot: nasty, hookDir: hooks }));
  check('karma.user.conf.cjs', angularKarmaConfig({ tool: 'UntangleIt', workspaceRoot: nasty, hookDir: hooks, userConfig: "karma's.conf.js" }));
  check('playwright-ct.config.mjs', playwrightWrapperConfig({ tool: 'UntangleIt', workspaceRoot: nasty, configFile: "playwright's-ct.config.ts" }));

  // And the path survives the round trip rather than merely parsing: a
  // generator that dropped or mangled a character would still parse.
  const karma = angularKarmaConfig({ tool: 'UntangleIt', workspaceRoot: nasty, hookDir: hooks });
  const quoted = /createRequire\((".*?")\)/.exec(karma);
  assert.ok(quoted, 'the workspace root is embedded as a string literal');
  assert.equal(JSON.parse(quoted[1]), `${posixPath(nasty)}/`, 'and it comes back out exactly as it went in');

  // The shadow tsconfig is JSON rather than JavaScript, and has the same duty.
  const work = path.join(dir, "work's");
  const project = path.join(dir, "tsconfig's.json");
  fs.writeFileSync(project, JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { "@app/*": ['src/*'] } } }), 'utf8');
  const generated = writeShadowTsConfig(work, project, dir, path.join(dir, "mirror's"));
  const parsed = JSON.parse(fs.readFileSync(generated, 'utf8')) as { include: string[]; extends?: string };
  assert.ok(parsed.include.every((i) => i.includes("mirror's")), 'the mirror path round-trips through the generated tsconfig');
});
