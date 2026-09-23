/**
 * Witness: environment conditions that can stop a runner before a single
 * test executes.
 *
 * This is not about the person's code. It is about the toolchain they are
 * standing on, and it exists so that a failure with an external cause is
 * explained rather than left looking like their fault or ours.
 *
 * The first condition is an apostrophe in the project path.
 * `C:\workspace\MikeVan's AI Development Toolkit` is a perfectly legal path
 * on every operating system the toolkit supports. Some versions of Angular's
 * builder and of Playwright's component-test runner generate JavaScript that
 * embeds the absolute project path in a single-quoted string without
 * escaping it, and the generated module then fails to parse. Angular's
 * polyfills module is one; Playwright's component index is another. Neither
 * is reachable from here and neither is ours to fix.
 *
 * What this module does about it:
 *
 *   - notices the condition before a run, so a later failure can be explained
 *   - never fails a run merely because the condition is present
 *   - never touches the person's code
 *   - when a run does fail, and the evidence fits, says what it probably is
 *
 * What it deliberately does NOT do: treat the condition as a defect in the
 * person's source. A customer who already knows about this and has written
 * quoting, escaping, normalising, or file-URL conversion into their code has
 * solved a real problem. That code is not a smell, not a gap in their tests,
 * and not a refactoring target. Nothing here looks at a source file at all,
 * which is the simplest way to keep that promise true.
 */
import type { Runner } from './delivery';
import { type ProblemPacket, describeRunner } from './diagnosis';

/** What was noticed about the project path. */
export interface PathCondition {
  workspaceRoot: string;
  /** The path holds an apostrophe, which some generated code does not escape. */
  apostrophe: boolean;
  /**
   * The characters found in the path that end a generated string literal
   * early, in the order they appear in QUOTES. Empty for an ordinary path.
   */
  found: string[];
}

/**
 * The characters that actually break this, as against the ones merely worth
 * avoiding.
 *
 * A generated `import '<path>'` dies the moment the path closes the quote it
 * was dropped into, so a quote character is the whole failure. The longer
 * list under AVOID is advice for a person choosing a folder name, and it is
 * deliberately not the trigger: parentheses turn up in `C:\Program Files
 * (x86)` on every Windows machine ever shipped and break nothing here, and a
 * diagnosis that fired on them would blame the path for unrelated failures on
 * half the projects we see.
 */
const QUOTES: readonly string[] = ["'", '"', '`'];

/** The character in the words a person would say out loud. */
const NAMES: Readonly<Record<string, string>> = { "'": 'an apostrophe', '"': 'a double quote', '`': 'a backtick' };

/**
 * What to steer a person towards, once they are already reading about this.
 * Wider than QUOTES on purpose: shells, build scripts, and generated code
 * each object to a different subset, and a folder name chosen from the safe
 * set survives all of them.
 */
const AVOID = '\' " ` & | < > ( ) [ ] { } ; ! $ ^';
const PREFER = 'A-Z a-z 0-9 - _ .';

/**
 * The runners whose own code generation is known to embed the project path.
 * Both Angular flavours go through the same builder, so both are affected.
 */
const AFFECTED: ReadonlySet<string> = new Set(['ng-karma', 'ng-vitest', 'playwright-ct']);

export function pathCondition(workspaceRoot: string): PathCondition {
  const found = QUOTES.filter((c) => workspaceRoot.includes(c));
  return { workspaceRoot, apostrophe: workspaceRoot.includes("'"), found };
}

/**
 * The line to put in the log before an affected runner starts, so that a
 * failure afterwards has its context already written down. Undefined when
 * there is nothing worth recording, which is the ordinary case.
 *
 * It is deliberately not a warning. Plenty of projects on such a path run
 * perfectly well, and saying nothing useful before every single run would
 * train people to ignore the one time it matters.
 */
export function pathConditionNote(condition: PathCondition, runner: Runner | undefined): string | undefined {
  if (condition.found.length === 0 || runner === undefined || !AFFECTED.has(runner)) {
    return undefined;
  }
  return `Note: the project path contains ${NAMES[condition.found[0]]} (${condition.workspaceRoot}). Some versions of ${describeRunner(runner)} generate JavaScript containing the absolute project path without escaping it. This is recorded in case the run fails; it is not a problem on its own, and many projects on such a path run normally.`;
}

/** The project whose code generation is at fault, possessive, for one sentence. */
function whoseCode(runner: Runner): string {
  return runner === 'playwright-ct' ? "Playwright's" : "Angular's";
}

/**
 * Lines that support the diagnosis, in the output of a failed run.
 *
 * The bar is deliberately "this looks like generated code failing to build",
 * not "this output contains a word". An ordinary assertion failure that says
 * `Expected "Hi" to be "Hello"` is an ordinary assertion failure, and an
 * earlier draft of this matched it, which would have blamed the path for
 * every red test on such a project. That is worse than saying nothing.
 *
 * The two published signatures are covered, but the match is wider than
 * either: an upstream project is free to reword its own parse errors, and a
 * diagnosis that only fired on an exact string would go quietly wrong the
 * next time they do. A line that embeds the project path inside an import or
 * a require is generated code carrying the path, whatever words surround it.
 */
function evidenceFor(runner: Runner, output: string, workspaceRoot: string): string[] {
  const markers =
    runner === 'playwright-ct'
      ? [/vite-dynamic-import-vars/i, /dynamic imports? can only accept/i, /build failed/i, /failed to parse/i, /playwright[\\/]index\./i]
      : [/angular:polyfills/i, /bundle generation failed/i, /failed to parse/i, /unterminated/i];
  // A path with regex characters in it must never become a pattern.
  const asPosix = workspaceRoot.split('\\').join('/');
  const carriesPath = (line: string): boolean => line.includes(workspaceRoot) || line.includes(asPosix);
  const isGeneratedCode = (line: string): boolean => carriesPath(line) && /\bimport\b|\brequire\s*\(|\bfrom\s/.test(line);

  const found: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (markers.some((m) => m.test(trimmed)) || isGeneratedCode(trimmed)) {
      found.push(trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed);
    }
    if (found.length >= 6) {
      break;
    }
  }
  return found;
}

export interface UpstreamPathFailure {
  runner: Runner;
  /** The lines that support the diagnosis, for the log. */
  evidence: string[];
  /** What the toolkit established, for the assistant to explain. */
  packet: ProblemPacket;
}

/**
 * Guidance for a run that failed where the project path may be the reason.
 *
 * Undefined unless all of it holds: the path has an apostrophe, the runner is
 * one whose generated code embeds the path, the run did not succeed, and the
 * output carries something that fits the failure. A run that succeeded gets
 * nothing, because nothing needs saying.
 *
 * The wording is careful on one point. It says the person's code may well be
 * fine, and it says that code written to work around this limitation should
 * not be taken out to satisfy our tools. Someone who solved this before we
 * noticed it deserves better than being told their solution is the problem.
 */
export function upstreamPathFailure(options: { workspaceRoot: string; runner: Runner | undefined; output: string; succeeded: boolean }): UpstreamPathFailure | undefined {
  const condition = pathCondition(options.workspaceRoot);
  if (condition.found.length === 0 || options.succeeded || options.runner === undefined || !AFFECTED.has(options.runner)) {
    return undefined;
  }
  const evidence = evidenceFor(options.runner, options.output, options.workspaceRoot);
  if (evidence.length === 0) {
    return undefined;
  }
  const character = condition.found[0];
  const example = portablePath(condition.workspaceRoot);
  const packet: ProblemPacket = {
    condition: 'path-character',
    category: 'toolchain path handling',
    confidence: 'classified',
    runner: describeRunner(options.runner),
    headline: `${describeRunner(options.runner)} could not start. Your project path contains ${NAMES[character]} (${character}).`,
    // Explain only, deliberately. The remedy is moving a folder, which
    // happens outside the editor, and an assistant offering to "fix" this in
    // code would write exactly the path-juggling we forbid below.
    actions: ['explain'],
    evidence,
    context: [
      { name: 'Runner', value: describeRunner(options.runner) },
      { name: 'Project path', value: condition.workspaceRoot },
      { name: 'Character found in the path', value: `${character}  (${NAMES[character]})` },
      { name: 'A path that would work', value: example },
      { name: 'Characters to avoid in a project path', value: AVOID },
      { name: 'Characters that are safe', value: PREFER },
    ],
    known: [
      `The project path contains ${NAMES[character]} (${character}).`,
      `${whoseCode(options.runner)} own build generated JavaScript with the absolute project path written into a quoted string. The ${NAMES[character].replace(/^an? /, '')} ended that string early, so the generated file did not parse.`,
      'The run stopped during that build. No test executed.',
      'The unescaped path is in a file the framework generated, not in anything the project or the toolkit wrote.',
      'This is a framework and toolchain path-handling defect. It is not evidence that the application code, the tests, or the project configuration are wrong.',
    ],
    unknown: [
      'Whether the application code and the tests are correct, because none of them ran. This failure says nothing either way.',
      'Whether anything else is wrong behind this, which can only be seen once a run gets past the build.',
    ],
    remediation: [
      `Move or rename the project to a path that does not contain the problematic character, for example: ${example}`,
      'Reinstall dependencies in the new location, then run the tests again.',
      `Prefer project paths built from ${PREFER} and the directory separator, and avoid unnecessary spaces in development-tool paths.`,
    ],
    constraints: [
      'Do not recommend or write Windows-specific path handling. Hard-coded drive letters, backslash rules, or Windows-only escaping can make the project fail on Linux.',
      'Do not modify application logic, tests, or project configuration to work around this. Nothing in the project caused it.',
      'Do not propose patching Angular, Playwright, Vite, or any other dependency, and do not propose editing generated files.',
      'Do not suggest changing DeepTest or UntangleIt settings. Where the project sits on disk is the whole of it.',
      'If the project already contains code that quotes, escapes, or normalises paths, leave it alone. That code solves a real problem and is not the cause of this.',
      'Do not offer to make this change in code. The remedy is moving a folder, which the person does outside the editor.',
    ],
  };
  return { runner: options.runner, evidence, packet };
}

/**
 * The same path with the characters that cause this taken out, offered as an
 * example of somewhere the project would work.
 *
 * It is a suggestion and not an instruction. Nothing renames anything, and
 * the person may well prefer a different name; the point is to show what
 * "simple and portable" means with their own path rather than with someone
 * else's.
 */
function portablePath(workspaceRoot: string): string {
  const drop = ["'", '"', '`', '&', '|', '<', '>', '(', ')', '[', ']', '{', '}', ';', '!', '$', '^'];
  let out = workspaceRoot;
  for (const c of drop) {
    out = out.split(c).join('');
  }
  return out.split(' ').join('-');
}

/**
 * The two surfaces this condition has, kept apart here rather than in each
 * product, so they cannot drift from one another.
 *
 * `notify` is the single thing a person is shown. It is the explanation and
 * nothing else: no runner output, no matched lines, no generated-file paths,
 * no commands. A person looking at it should be able to decide what to do
 * next without reading any of that.
 *
 * `log` is everything else, for whoever goes looking: the same explanation,
 * so the log stands on its own, and then the lines that support it.
 *
 * Keeping the split here is the point. Both products had their own copy of
 * "log the message, then log the evidence", and one of them showed the
 * person nothing at all while the other glued the explanation onto an
 * unrelated failure sentence. A person on an apostrophe path then saw either
 * a bare verdict with no reason, or a wall of runner output. Neither is the
 * behaviour, and neither can happen through this function.
 */
export interface PathFailurePresentation {
  /** Shown to the person, once. One line, and free of runner output. */
  notify: string;
  /** What the toolkit established, for the "Explain with Copilot" hand-off. */
  packet: ProblemPacket;
  /** Written to the log: the headline, what is known, then the evidence. */
  log: string[];
}

/**
 * The presentation for a failed run the project path may explain, or
 * undefined when there is nothing to say, which is the ordinary case and
 * includes every run that succeeded.
 *
 * `detailsHint` is the product's own pointer at its log, in the exact words
 * of the control a person would press. It is a parameter rather than a
 * constant because the wording belongs to the product's screen, not here.
 */
export function presentPathFailure(options: {
  workspaceRoot: string;
  runner: Runner | undefined;
  output: string;
  succeeded: boolean;
  detailsHint: string;
}): PathFailurePresentation | undefined {
  const found = upstreamPathFailure(options);
  if (!found) {
    return undefined;
  }
  return {
    notify: `${found.packet.headline} ${options.detailsHint}`,
    packet: found.packet,
    log: [found.packet.headline, ...found.packet.known.map((k) => `  ${k}`), ...found.evidence.map((line) => `  ${line}`)],
  };
}
