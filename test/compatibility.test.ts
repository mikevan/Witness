/**
 * The path-character compatibility condition, and the packet it produces.
 *
 * `C:\workspace\MikeVan's AI Development Toolkit` is a legal path, and some
 * versions of Angular's builder and Playwright's component-test runner
 * generate JavaScript that embeds the absolute project path in a quoted
 * string without escaping it. The quote character in the path ends that
 * string early, the generated module fails to parse, and the run dies before
 * a test executes.
 *
 * Both were proved to be upstream: a plain `npx playwright test` from such a
 * path fails identically with none of this toolkit involved, and the
 * unescaped `import '...'` is a line in Angular's own
 * `application-code-bundle.js`. Neither is ours to fix, so what the toolkit
 * owes the person is an explanation rather than a repair.
 *
 * What these tests hold in place is no longer a set of sentences. The
 * toolkit produces facts, boundaries, and evidence; the sentences are the
 * assistant's job. So what is pinned here is that the facts are right, that
 * the things we must never recommend are stated as constraints, and that the
 * condition is about the environment and never about the person's code.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { pathCondition, pathConditionNote, upstreamPathFailure, presentPathFailure } from '../src/index';

const NASTY = "C:\\workspace\\MikeVan's AI Development Toolkit\\DeepTest\\test\\fixtures\\helloworld-angular-karma";
const CLEAN = 'C:\\workspace\\Toolkit\\DeepTest\\test\\fixtures\\helloworld-angular-karma';
const HINT = 'Press "Show the log" to see the runner\'s own output.';

/** The Angular failure as it actually came off the Windows run. */
const ANGULAR_OUTPUT = [
  'Application bundle generation failed. [2.378 seconds]',
  '✘ [ERROR] Expected ";" but found "s"',
  '    angular:polyfills:angular:polyfills:1:29:',
  "      1 │ import 'C:/workspace/MikeVan's AI Development Toolkit/DeepTest/test...",
  '',
].join('\n');

/** The Playwright failure as it actually came off the Windows run. */
const PLAYWRIGHT_OUTPUT = [
  'Running 10 tests using 4 workers',
  '✗ Build failed in 65ms',
  '[builtin:vite-dynamic-import-vars] plugin threw an error',
  `    Failed to parse code in 'C:/workspace/MikeVan's AI Development Toolkit/DeepTest/test/fixtures/helloworld-react-playwright-ct/playwright/index.ts': "Dynamic imports can only accept a module specifier and an optional set of attributes as arguments"`,
  '  10 did not run',
  '',
].join('\n');

test('the condition is noticed before a run, and noticing it is not a warning', () => {
  assert.equal(pathCondition(NASTY).apostrophe, true);
  assert.equal(pathCondition(CLEAN).apostrophe, false);

  const note = pathConditionNote(pathCondition(NASTY), 'ng-karma');
  assert.ok(note, 'an affected runner on such a path has the condition written down before it starts');
  assert.match(note, /apostrophe/);
  assert.match(note, /not a problem on its own/, 'because plenty of projects on such a path run perfectly well');
  assert.doesNotMatch(note, /\b(error|invalid|fix your|rename)\b/i, 'it records a condition, it does not scold anyone');

  assert.equal(pathConditionNote(pathCondition(CLEAN), 'ng-karma'), undefined, 'an ordinary path has nothing to record');
  assert.equal(pathConditionNote(pathCondition(NASTY), 'vitest'), undefined, 'and a runner that does not embed the path is not affected');
});

test('an apostrophe path whose runner succeeded gets no packet at all', () => {
  // The condition being present is not a failure and must never read as one.
  for (const runner of ['ng-karma', 'ng-vitest', 'playwright-ct'] as const) {
    assert.equal(
      upstreamPathFailure({ workspaceRoot: NASTY, runner, output: 'Executed 4 of 4 SUCCESS\n', succeeded: true }),
      undefined,
      `${runner} succeeded, so there is nothing to explain`,
    );
  }
  assert.equal(upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: true }), undefined);
});

test('the packet carries the facts, and names the character it actually found', () => {
  const found = upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: false });
  assert.ok(found, 'the failure fits and the path explains it');
  const p = found.packet;

  assert.equal(p.condition, 'path-character');
  assert.equal(p.confidence, 'classified', 'this rests on deterministic evidence, so the assistant must not re-diagnose it');
  assert.equal(p.runner, "Angular's unit-test builder with Karma", 'the runner, in words a person would recognise');
  assert.match(p.headline, /could not start/);
  assert.match(p.headline, /contains an apostrophe \('\)/, 'the exact character, in one line');

  const known = p.known.join('\n');
  assert.match(known, /contains an apostrophe \('\)/, 'the offending character');
  assert.match(known, /generated JavaScript with the absolute project path/, 'what the framework did with it');
  assert.match(known, /ended that string early, so the generated file did not parse/, 'why that stops the run');
  assert.match(known, /No test executed/);
  assert.match(known, /not evidence that the application code, the tests, or the project configuration are wrong/, 'and it is nobody in the project\'s fault');
  assert.match(known, /in a file the framework generated, not in anything the project or the toolkit wrote/, 'which is the fact that settles whose defect it is');

  assert.ok(
    p.unknown.some((u) => /none of them ran/.test(u)),
    'the run proves nothing about the code, and the packet says so rather than letting anyone imply otherwise',
  );

  assert.ok(
    p.evidence.some((l) => l.includes('angular:polyfills') || l.includes('Expected ";"')),
    'the lines that support it travel with it, verbatim',
  );
});

test('the packet forbids every workaround we do not want recommended', () => {
  const p = upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: false })!.packet;
  const constraints = p.constraints.join('\n');

  assert.match(constraints, /Do not recommend or write Windows-specific path handling/, 'a fix that breaks Linux is not a fix');
  assert.match(constraints, /can make the project fail on Linux/, 'with the reason, so the assistant can explain it rather than parrot it');
  assert.match(constraints, /Do not modify application logic, tests, or project configuration/);
  assert.match(constraints, /Do not propose patching Angular, Playwright, Vite/);
  assert.match(constraints, /leave it alone/, 'a customer who already solved this is not told to undo it');
  assert.match(constraints, /Do not offer to make this change in code/);

  // Explain only. The remedy is moving a folder, and an assistant offering
  // to fix it in code would write the very path-juggling forbidden above.
  assert.deepEqual(p.actions, ['explain'], 'there is no code change to offer, so none is offered');
});

test('the remediation is the toolkit\'s, and the example path is the person\'s own, made safe', () => {
  const p = upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: false })!.packet;
  const remediation = p.remediation.join('\n');
  assert.match(remediation, /Move or rename the project/);
  assert.match(remediation, /Reinstall dependencies in the new location/, 'the step people forget');

  const example = p.context.find((c) => c.name === 'A path that would work')!.value;
  assert.ok(example.includes('MikeVans-AI-Development-Toolkit'), 'their folder, made simple');
  for (const c of ["'", '"', '`', '&', '|', '<', '>', '(', ')', '[', ']', '{', '}', ';', '!', '$', '^', ' ']) {
    assert.ok(!example.includes(c), `the example we hand them must not itself contain ${c}`);
  }
  assert.ok(p.remediation.some((r) => r.includes(example)), 'and the remediation names it');
});

test('the packet names the framework that actually failed', () => {
  const p = upstreamPathFailure({ workspaceRoot: NASTY, runner: 'playwright-ct', output: PLAYWRIGHT_OUTPUT, succeeded: false })!.packet;
  assert.equal(p.runner, 'Playwright component tests');
  assert.match(p.known.join('\n'), /Playwright's own build/, 'Playwright failed, so Playwright is named');
  assert.ok(
    p.evidence.some((l) => /dynamic import/i.test(l) || l.includes('index.ts')),
    'the generated component index is the evidence',
  );
});

/**
 * The published signatures are evidence, not the definition. An upstream
 * project is free to reword its own parse errors, and a diagnosis that only
 * fired on an exact string would go quietly wrong the next time they do.
 */
test('the diagnosis does not depend on the exact upstream wording', () => {
  const reworded = [
    'Bundle generation failed.',
    `  [problem] could not read 'C:/workspace/MikeVan's AI Development Toolkit/app/polyfills.js': unterminated string`,
    '',
  ].join('\n');
  const found = upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-vitest', output: reworded, succeeded: false });
  assert.ok(found, 'a failure carrying the project path is enough, even with none of the published strings');
  assert.equal(found.packet.runner, "Angular's unit-test builder with Vitest");
});

test('a path without a quote character never receives this diagnosis', () => {
  const clean = ANGULAR_OUTPUT.split("MikeVan's AI Development Toolkit").join('Toolkit');
  assert.equal(upstreamPathFailure({ workspaceRoot: CLEAN, runner: 'ng-karma', output: clean, succeeded: false }), undefined);
  assert.equal(upstreamPathFailure({ workspaceRoot: CLEAN, runner: 'playwright-ct', output: PLAYWRIGHT_OUTPUT, succeeded: false }), undefined);
});

test('a failure with nothing to connect it to the path is left alone', () => {
  // An ordinary test failure on such a path is an ordinary test failure.
  // Blaming the path for everything would be worse than silence.
  const ordinary = 'Executed 4 of 4 (1 FAILED)\n  Greeter greets: Expected "Hi" to be "Hello".\n';
  assert.equal(upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: ordinary, succeeded: false }), undefined);
});

/**
 * Which characters set this off, as against which ones we advise against.
 *
 * The failure is a generated string literal ending early, so a quote
 * character is the whole cause and nothing else is. The wider list in the
 * packet's context is advice for choosing a folder name. Keeping the two
 * apart matters: `C:\Program Files (x86)` is on every Windows machine ever
 * shipped, and a diagnosis that fired on its parentheses would blame the
 * path for unrelated failures on half the projects we ever see.
 */
test('only a quote character sets this off, whatever else the path holds', () => {
  const parens = 'C:\\Program Files (x86)\\Acme [build]\\app';
  assert.deepEqual(pathCondition(parens).found, [], 'brackets and parentheses break nothing here');
  assert.equal(upstreamPathFailure({ workspaceRoot: parens, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: false }), undefined, 'so the path is never blamed for a failure it did not cause');

  assert.deepEqual(pathCondition("C:\\dev\\O'Brien\\app").found, ["'"]);
  assert.deepEqual(pathCondition('C:\\dev\\say "hi"\\app').found, ['"']);
  assert.deepEqual(pathCondition('C:\\dev\\a`b\\app').found, ['`']);
});

test('a double quote in the path is named as a double quote, not as an apostrophe', () => {
  const quoted = 'C:\\dev\\say "hi"\\app';
  const output = ['Application bundle generation failed.', `  1 │ import 'C:/dev/say "hi"/app/polyfills.js';`].join('\n');
  const found = upstreamPathFailure({ workspaceRoot: quoted, runner: 'ng-karma', output, succeeded: false });
  assert.ok(found, 'a quote of any kind ends the generated literal early');
  assert.match(found.packet.headline, /contains a double quote \("\)/, 'the person is told which character we actually found');
  assert.doesNotMatch(found.packet.known.join('\n'), /apostrophe/, 'not the one we happened to write the feature for');
});

/**
 * What a person sees, as against what is written down for them.
 *
 * The qualification harness is allowed to print the whole runner tail. The
 * product is not. One line, then the offer to have it explained.
 */
test('the person is shown one line, and none of the runner output', () => {
  const shown = presentPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: false, detailsHint: HINT });
  assert.ok(shown);
  assert.equal(shown.notify, `${shown.packet.headline} ${HINT}`, 'the headline and the way to the details, and nothing else');
  assert.doesNotMatch(shown.notify, /\n/, 'one line');
  assert.doesNotMatch(shown.notify, /angular:polyfills|Expected ";"|bundle generation failed/i, 'no runner output in front of anybody');
  for (const line of shown.packet.evidence) {
    assert.ok(!shown.notify.includes(line), `the evidence stays out of what the person is shown: ${line}`);
  }
});

test('the evidence and what we know are kept, in the log, where they can be gone and looked at', () => {
  const shown = presentPathFailure({ workspaceRoot: NASTY, runner: 'playwright-ct', output: PLAYWRIGHT_OUTPUT, succeeded: false, detailsHint: HINT })!;
  const log = shown.log.join('\n');
  assert.match(log, /Playwright component tests could not start/, 'the log stands on its own');
  assert.match(log, /No test executed/, 'with what the toolkit established');
  assert.ok(
    shown.log.some((l) => /dynamic import/i.test(l) || l.includes('index.ts')),
    'and the lines that support it',
  );
  assert.ok(shown.log.slice(1).every((l) => l.startsWith('  ')), 'everything sits under the headline rather than beside it');
});

test('a run that succeeded, or that the path does not explain, shows the person nothing', () => {
  assert.equal(presentPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: true, detailsHint: HINT }), undefined);
  assert.equal(presentPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: 'Executed 4 of 4 (1 FAILED)\n  Expected "Hi" to be "Hello".\n', succeeded: false, detailsHint: HINT }), undefined);
  assert.equal(presentPathFailure({ workspaceRoot: CLEAN, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: false, detailsHint: HINT }), undefined);
});

/**
 * The condition is about the environment and nothing else.
 *
 * A customer may have written quoting, escaping, normalising, or file-URL
 * conversion into their own code precisely because they hit this. That code
 * is a solution, not a symptom. The simplest way to guarantee the toolkit
 * never treats it as one is that none of this looks at source at all, and
 * that is what this asserts: the whole decision is a path and a runner's
 * output, so there is no code-level rule that could fire.
 */
test('nothing here inspects source, so workaround code cannot be flagged by it', () => {
  const workaround = [
    'export function safeSpecifier(absolute: string): string {',
    '  return JSON.stringify(absolute.split("\\\\").join("/"));',
    '}',
    'export function toFileUrl(p: string): string {',
    "  return new URL(`file://${encodeURI(p)}`).href;",
    '}',
  ].join('\n');

  assert.equal(upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: workaround, succeeded: true }), undefined);
  assert.equal(upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: workaround, succeeded: false }), undefined, 'quoting and escaping code is not evidence of anything');

  const condition = pathCondition(NASTY);
  assert.deepEqual(Object.keys(condition).sort(), ['apostrophe', 'found', 'workspaceRoot'], 'a path and the characters in it, and no opinion about code');
});
