/**
 * Witness: the boundary recorder's instrumenter.
 *
 * A separate entry point from the counter instrumenter on purpose. That one
 * rewrites every file in a source root and produces an executable-line
 * universe; this one rewrites exactly one function in one file and produces
 * no maps at all. The lifecycles and the record shapes have nothing in
 * common, and putting a flag on the common path would make every ordinary
 * run carry an option it never uses.
 *
 * What it emits, on the function's own lines, so nothing moves:
 *
 *   function f(a, b) {const H = W.enter("<id>", arguments, false);try {
 *     ...
 *     return H.returned(x);
 *     ...
 *   H.fellThrough();} catch (e) {H.threw(e);throw e;}}
 *
 * Three decisions in that shape are worth stating.
 *
 * The body is wrapped in try/catch rather than in a function, so `this`,
 * `arguments`, `super`, `yield`, and every control-flow statement keep
 * working. A wrapper function would have broken all of them.
 *
 * Every `return` is rewritten to pass its value through the handle, and a
 * `fellThrough()` is appended after the last statement for the path that
 * walks off the end. When the body already ended in a return, that call is
 * unreachable and costs nothing.
 *
 * For an `async` function the try/catch sits inside the async boundary,
 * where a return and a throw are exactly what the promise will settle to.
 * Nothing is ever attached to the caller-visible promise. Attaching a
 * rejection handler to it would add a handler that was not there and change
 * unhandled-rejection behaviour, which would mean the recorder changing the
 * thing it is supposed to measure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Node, Parser, Tree } from 'web-tree-sitter';

/** What the caller asked to watch: a function by name, inside a container when one is named. */
export interface BoundaryTarget {
  /** The function or method name. */
  name: string;
  /** The class or object it belongs to, when it has one. */
  container?: string;
}

/** The function that was matched, so a caller can confirm it got what it meant. */
export interface BoundaryMatch {
  name: string;
  container?: string;
  line: number;
  endLine: number;
  async: boolean;
}

export type BoundaryInstrumented =
  | { ok: true; code: string; handle: string; target: BoundaryMatch }
  | { ok: false; reason: 'not-found' | 'ambiguous'; found: number };

const FUNCTION_TYPES = new Set(['function_declaration', 'function_expression', 'function', 'generator_function', 'generator_function_declaration', 'arrow_function', 'method_definition']);

/**
 * The type the handle carries in a TypeScript file. `returned` hands the
 * value straight back, so an untyped handle would make every instrumented
 * return `any` and erase the type of whatever it wrapped. Angular's compiler
 * found that in the counter instrumenter the hard way in 1.0.17; it is not
 * being found twice.
 */
const HANDLE_TYPE = '{ returned<T>(value: T): T; threw(error: unknown): void; fellThrough(): void }';

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** The name a function goes by, however it was written. */
function nameOf(node: Node): string | undefined {
  const named = node.childForFieldName('name');
  if (named) {
    return named.text;
  }
  // `const f = () => {}` and `f: function () {}` take their name from what they are assigned to.
  const parent = node.parent;
  if (parent?.type === 'variable_declarator' || parent?.type === 'pair' || parent?.type === 'public_field_definition' || parent?.type === 'field_definition') {
    return parent.childForFieldName('name')?.text ?? parent.childForFieldName('key')?.text;
  }
  if (parent?.type === 'assignment_expression') {
    const left = parent.childForFieldName('left');
    return left?.type === 'member_expression' ? left.childForFieldName('property')?.text : left?.text;
  }
  return undefined;
}

/** The class or object a function sits inside, when it sits in one. */
function containerOf(node: Node): string | undefined {
  for (let at: Node | null = node.parent; at; at = at.parent) {
    if (at.type === 'class_declaration' || at.type === 'class') {
      return at.childForFieldName('name')?.text;
    }
    if (FUNCTION_TYPES.has(at.type)) {
      // A function inside a function belongs to that function, not to the class around it.
      return nameOf(at);
    }
  }
  return undefined;
}

function isAsync(node: Node): boolean {
  for (let i = 0; i < node.childCount; i += 1) {
    if (node.child(i)?.type === 'async') {
      return true;
    }
  }
  return false;
}

/**
 * The expression the instrumented code passes as the arguments.
 *
 * A non-arrow function has `arguments`, which is exactly what the caller
 * passed and costs nothing: adding a rest parameter would change the
 * function's arity, which is observable.
 *
 * An arrow function has no `arguments`, so the parameters are listed by
 * name. A parameter that is destructured or a rest element has no single
 * name to list, and the whole observation's arguments are then recorded as
 * uncomparable rather than guessed at: `null` tells the runtime that.
 */
function argumentsExpression(node: Node): string {
  if (node.type !== 'arrow_function') {
    return 'arguments';
  }
  const params = node.childForFieldName('parameters');
  if (!params) {
    // `x => x`, a single unparenthesised parameter.
    const only = node.child(0);
    return only?.type === 'identifier' ? `[${only.text}]` : 'null';
  }
  const names: string[] = [];
  for (let i = 0; i < params.namedChildCount; i += 1) {
    const p = params.namedChild(i)!;
    if (p.type === 'identifier') {
      names.push(p.text);
      continue;
    }
    // A default keeps a plain binding, and its value at entry is the argument
    // that was effectively received, which is what we want to record.
    const inner = p.type === 'required_parameter' || p.type === 'optional_parameter' ? p.childForFieldName('pattern') : p.type === 'assignment_pattern' ? p.childForFieldName('left') : undefined;
    if (inner?.type === 'identifier') {
      names.push(inner.text);
      continue;
    }
    return 'null';
  }
  return `[${names.join(', ')}]`;
}

interface Edit {
  at: number;
  text: string;
  order: number;
}

/**
 * Rewrites one function so that its entries, returns, and throws are
 * recorded. Everything else in the file is left byte for byte as it was.
 */
export class BoundaryInstrumenter {
  constructor(private readonly parser: Parser) {}

  instrument(filePath: string, source: string, target: BoundaryTarget): BoundaryInstrumented {
    const tree: Tree | null = this.parser.parse(source);
    if (!tree) {
      return { ok: false, reason: 'not-found', found: 0 };
    }
    const matches: Node[] = [];
    const visit = (node: Node): void => {
      if (FUNCTION_TYPES.has(node.type) && nameOf(node) === target.name) {
        const container = containerOf(node);
        if (target.container === undefined || container === target.container) {
          matches.push(node);
        }
      }
      for (let i = 0; i < node.namedChildCount; i += 1) {
        visit(node.namedChild(i)!);
      }
    };
    visit(tree.rootNode);
    if (matches.length !== 1) {
      // Never guess. A name that resolves to two functions is a question the
      // caller has to answer, and the gate reports insufficient evidence.
      return { ok: false, reason: matches.length === 0 ? 'not-found' : 'ambiguous', found: matches.length };
    }

    const fn = matches[0];
    const body = fn.childForFieldName('body');
    if (!body) {
      return { ok: false, reason: 'not-found', found: 0 };
    }
    const handle = `__wb_${hash(`${filePath}:${target.container ?? ''}:${target.name}`)}`;
    const typescript = /\.[cm]?tsx?$/i.test(filePath);
    const declaration = typescript ? `const ${handle}: ${HANDLE_TYPE} = (globalThis as any)` : `const ${handle} = globalThis`;
    const id = `${target.container ? `${target.container}.` : ''}${target.name}`;
    const enter = `${declaration}.__witnessBoundary__.enter(${JSON.stringify(id)}, ${argumentsExpression(fn)}, ${isAsync(fn)});try {`;
    const close = `} catch (${handle}_e) {${handle}.threw(${handle}_e);throw ${handle}_e;}`;

    const edits: Edit[] = [];
    if (body.type === 'statement_block') {
      edits.push({ at: body.startIndex + 1, text: enter, order: 1 });
      edits.push({ at: body.endIndex - 1, text: `${handle}.fellThrough();${close}`, order: 9 });
      this.rewriteReturns(body, fn, handle, edits);
    } else {
      // An expression-bodied arrow: `(a) => a + 1`. Braces go around it, and
      // the expression becomes the returned value. Line count is untouched
      // because text is only added at each end.
      edits.push({ at: body.startIndex, text: `{${enter}return ${handle}.returned(`, order: 1 });
      edits.push({ at: body.endIndex, text: `);${close}}`, order: 9 });
    }

    edits.sort((a, b) => a.at - b.at || a.order - b.order);
    let out = '';
    let at = 0;
    for (const edit of edits) {
      out += source.slice(at, edit.at) + edit.text;
      at = edit.at;
    }
    out += source.slice(at);

    return {
      ok: true,
      code: out,
      handle,
      target: {
        name: target.name,
        container: containerOf(fn),
        line: fn.startPosition.row + 1,
        endLine: fn.endPosition.row + 1,
        async: isAsync(fn),
      },
    };
  }

  /**
   * The function starting on a given line, by name and by the container it
   * sits in.
   *
   * The caller that knows a line is the one recording before the hand-off,
   * where the method has not moved yet. It needs the container because the
   * run afterwards has only a name to search by: the assistant moved the
   * method and nothing here knows where. A name alone would resolve to two
   * functions in any file with a `greet` on a class and a `greet` beside it,
   * and the gate would then compare nothing.
   */
  locate(filePath: string, source: string, line: number): BoundaryMatch | undefined {
    const tree: Tree | null = this.parser.parse(source);
    if (!tree) {
      return undefined;
    }
    let found: Node | undefined;
    const visit = (node: Node): void => {
      if (FUNCTION_TYPES.has(node.type) && node.startPosition.row + 1 === line && nameOf(node) !== undefined) {
        // The innermost function starting on that line, so a one-line
        // wrapper around an arrow names the arrow rather than the wrapper.
        found = node;
      }
      for (let i = 0; i < node.namedChildCount; i += 1) {
        visit(node.namedChild(i)!);
      }
    };
    visit(tree.rootNode);
    if (!found) {
      return undefined;
    }
    const container = containerOf(found);
    return { name: nameOf(found)!, ...(container ? { container } : {}), line, endLine: found.endPosition.row + 1, async: isAsync(found) };
  }

  /**
   * Every `return` that belongs to this function, and none that belong to a
   * function nested inside it, since those return somewhere else.
   */
  private rewriteReturns(node: Node, owner: Node, handle: string, edits: Edit[]): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i)!;
      if (FUNCTION_TYPES.has(child.type)) {
        continue;
      }
      if (child.type === 'return_statement') {
        const value = child.namedChild(0);
        if (value) {
          edits.push({ at: value.startIndex, text: `${handle}.returned(`, order: 4 });
          edits.push({ at: value.endIndex, text: ')', order: 5 });
        } else {
          // `return;` records the undefined it hands back, so a path that
          // returns nothing is still an observation rather than a silence.
          edits.push({ at: child.startIndex + 'return'.length, text: ` ${handle}.returned(undefined)`, order: 4 });
        }
      }
      this.rewriteReturns(child, owner, handle, edits);
    }
  }
}

/**
 * The record schema both recorders write.
 *
 * It lives here because Witness owns the recorders: the JavaScript one in
 * witness-boundary.cjs and the Python one in witness_boundary.py. Anything
 * that reads these records, including UntangleIt's comparator, reads one
 * schema and never learns which language produced a line. That is what
 * makes one meaning of equivalent possible across two languages.
 */

/** A value in the tagged, language-neutral form both recorders write. */
export type Captured =
  | { t: 'null' }
  | { t: 'undefined' }
  | { t: 'num'; v: string }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'date'; v: number }
  | { t: 'regex'; v: { source: string; flags: string } }
  | { t: 'error'; v: { name: string; message: string } }
  | { t: 'array'; v: Captured[] }
  | { t: 'object'; v: Record<string, Captured> }
  | { t: 'uncomparable'; why: string };

/** How a call ended. `resolve` and `reject` are an async boundary's own settle. */
export type OutcomeKind = 'return' | 'throw' | 'resolve' | 'reject';

/** One entry to the boundary, and how it ended. */
export interface Observation {
  target: string;
  test: string | null;
  index: number;
  depth: number;
  args: Captured;
  outcome: { kind: OutcomeKind; value: Captured };
}

/** A recorder saying it could not attach at all, so there is nothing to compare. */
export interface Problem {
  problem: 'target-not-found' | 'unsupported-target';
  target: string;
}

export type BoundaryRecord = Observation | Problem;

export function isProblem(record: BoundaryRecord): record is Problem {
  return (record as Problem).problem !== undefined;
}

/** Every record a recorded run wrote, from every process and worker it used. */
export function readBoundaryRecords(dir: string): BoundaryRecord[] {
  const out: BoundaryRecord[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!name.startsWith('boundary-') || !name.endsWith('.jsonl')) {
      continue;
    }
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        out.push(JSON.parse(line) as BoundaryRecord);
      } catch {
        // A half-written line from a process that was killed. The run is
        // already suspect; one unreadable line is not worth failing over,
        // and the gate reports insufficient evidence if it mattered.
      }
    }
  }
  return out;
}
