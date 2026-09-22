/**
 * Witness: the instrumenter.
 *
 * Rewrites a JavaScript or TypeScript source so that every statement,
 * function, and decision reports to the Witness runtime as it runs. The
 * rewrite is textual: counters are inserted into the source on the same
 * line as the thing they count, and nothing is regenerated, so every line
 * number in the instrumented file is the line number in the editor and no
 * source map is needed to get back. The parse tree comes from the same
 * tree-sitter grammars DeepTest uses for routes and depth, so what the
 * analysis calls a decision and what the runtime counts at run time are
 * decided by one tree.
 *
 * The maps it produces are Istanbul's shape (statementMap, fnMap,
 * branchMap, with the same node choices istanbul-lib-instrument makes), so
 * any Istanbul reporter and every existing DeepTest reader can consume the
 * counters unchanged. Where the two differ is deliberate and documented in
 * docs/witness.md; the differential test in test/witness.test.ts pins the
 * agreement on every fixture.
 *
 * Counters, on the per-file object W the runtime hands out:
 *   W.s(id)             a statement ran
 *   W.v(id, name, expr) a statement whose value is an expression (a
 *                       declarator or class field initialiser); returns
 *                       the value, and gives an anonymous function the
 *                       name it would have had, which a plain sequence
 *                       expression would take away
 *   W.f(id)             a function was entered
 *   W.c(id, i)          the i-th way through a decision was taken: an arm of
 *                       an if or a ternary, an operand of a boolean run, a
 *                       default parameter value, a case of a switch
 *
 * Only W.v returns anything, and that is the one place a counter has to sit
 * around a value. Everywhere else the counter sits BESIDE the value, in the
 * arm that ran or as the first operand of a comma expression, and never
 * around the condition that chose it. That is not a style: a condition
 * wrapped in a call stops narrowing, so `if (W.b(0, p))` leaves `p` possibly
 * undefined in the body and strict TypeScript refuses the file. Istanbul
 * places its branch counters the same way, for what is probably the same
 * reason.
 */
import type { Node, Parser, Tree } from 'web-tree-sitter';

export interface Position {
  line: number;
  column: number;
}
export interface Location {
  start: Position;
  end: Position;
}
export interface FunctionMapEntry {
  name: string;
  decl: Location;
  loc: Location;
  line: number;
}
export interface BranchMapEntry {
  type: string;
  line: number;
  loc: Location;
  locations: Location[];
}
export interface WitnessMaps {
  path: string;
  statementMap: Record<string, Location>;
  fnMap: Record<string, FunctionMapEntry>;
  branchMap: Record<string, BranchMapEntry>;
  /** Decisions left uncounted, with the line and the reason; never silent. */
  skipped: Array<{ line: number; reason: string }>;
}

export interface Instrumented {
  code: string;
  maps: WitnessMaps;
  /** The identifier the instrumented code uses for its per-file runtime object. */
  handle: string;
}

const STATEMENT_TYPES = new Set([
  'expression_statement',
  'break_statement',
  'continue_statement',
  'debugger_statement',
  'return_statement',
  'throw_statement',
  'try_statement',
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'with_statement',
  'labeled_statement',
]);
const FUNCTION_TYPES = new Set(['function_declaration', 'function_expression', 'function', 'generator_function', 'generator_function_declaration', 'arrow_function', 'method_definition']);
const LOGICAL = new Set(['&&', '||', '??']);
export const MISPARSE = 'the grammar reads a non-null assertion (x!) after a logical operator as covering the whole run, so the operands cannot be told apart; the statement is counted, the decision is not';

/**
 * A decorated class's field initialiser is left exactly as written, because a
 * compiler may pattern-match it. Angular is the case that proved it: `input()`,
 * `input.required()` and `computed()` must appear syntactically as the
 * initialiser of a class member, and wrapping one is rejected outright with
 * "NG8110: Unsupported call ... This function can only be called in the
 * initializer of a class member." Measured against @angular/compiler-cli 22: a
 * call wrapper is refused, and so is a bare sequence expression, so there is no
 * wrapping form that survives. The initialiser's own function bodies are still
 * instrumented, which is where the logic lives; only the outer value counter is
 * given up, and it is recorded here rather than dropped silently.
 */
export const DECORATED_FIELD = 'this class carries a decorator, and a decorating compiler may require a field initialiser to appear exactly as written (Angular rejects any wrapper with NG8110), so the initialiser is not counted; code inside it still is';

/**
 * The type the handle is declared with in a TypeScript file, and the reason
 * the wrappers are generic.
 *
 * `globalThis.__witness__` is declared nowhere, so the prologue has to cast
 * on the way in, and the obvious cast leaves the handle `any`. That is not
 * free: `v` returns the value it was given, so a handle typed `any` makes
 * every instrumented declarator `any` too, and the erasure spreads. `let name = w.v(0, "name", raw.trim())` stops being a string, and
 * a callback further down the chain then has no contextual type, which under
 * noImplicitAny is TS7006 and stops the build. Measured on the angular-vitest
 * and angular-karma ports, both runners, at the same two lines of the same
 * file. Most paths never type-check the instrumented text and would never
 * have noticed; Angular's compiler does, which is what makes it the runner
 * that keeps this honest.
 *
 * Written out inline rather than emitted as a named type or a .d.ts, because
 * the rewrite must stay one line longer than nothing and the file must stay
 * self-contained: a generated type would have to be reachable from whichever
 * tsconfig the project happens to compile with.
 *
 * No signature can recover narrowing, which is why no counter wraps a
 * condition any more; see the counter list at the top of this file.
 */
const HANDLE_TYPE =
  '{ s(id: number): void; f(id: number): void; c(id: number, index: number): void; v<T>(id: number, name: string, value: T): T }';

// Logical assignment (a ??= b) is a decision to the structure analysis but not
// a branch to istanbul-lib-instrument 6, so the Istanbul view leaves it out too.
const WRAPPING_BODIES: Array<[string, string[]]> = [
  ['if_statement', ['consequence']],
  ['for_statement', ['body']],
  ['for_in_statement', ['body']],
  ['while_statement', ['body']],
  ['do_statement', ['body']],
  ['with_statement', ['body']],
];

interface Edit {
  at: number;
  text: string;
  /** Lower goes first at the same offset. */
  order: number;
  /** Insertion sequence; openers keep it, closers reverse it, so nested wrappers close inside out. */
  seq: number;
  closer: boolean;
}

function loc(node: Node): Location {
  return {
    start: { line: node.startPosition.row + 1, column: node.startPosition.column },
    end: { line: node.endPosition.row + 1, column: node.endPosition.column },
  };
}

function emptyLoc(node: Node): Location {
  const p = { line: node.startPosition.row + 1, column: node.startPosition.column };
  return { start: p, end: p };
}

/** A string-literal statement in the directive prologue of a program or function body. */
function isDirective(node: Node): boolean {
  if (node.type !== 'expression_statement' || node.namedChildCount !== 1 || node.namedChild(0)!.type !== 'string') {
    return false;
  }
  const parent = node.parent;
  if (!parent || (parent.type !== 'program' && parent.type !== 'statement_block')) {
    return false;
  }
  if (parent.type === 'statement_block' && !(parent.parent && FUNCTION_TYPES.has(parent.parent.type))) {
    return false;
  }
  for (let i = 0; i < parent.namedChildCount; i += 1) {
    const sibling = parent.namedChild(i)!;
    if (sibling.id === node.id) {
      return true;
    }
    if (sibling.type === 'comment') {
      continue;
    }
    if (sibling.type !== 'expression_statement' || sibling.namedChildCount !== 1 || sibling.namedChild(0)!.type !== 'string') {
      return false;
    }
  }
  return false;
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Whether this field belongs to a class carrying a decorator. The rule is
 * syntactic and names no framework: a decorated class is one whose compiler
 * reads the class body as data, so its field initialisers are left alone. That
 * covers Angular, and anything else that does the same, without this file
 * knowing what Angular is.
 */
function inDecoratedClass(field: Node): boolean {
  const body = field.parent;
  const declaration = body?.parent;
  if (!declaration) {
    return false;
  }
  for (let i = 0; i < declaration.childCount; i += 1) {
    if (declaration.child(i)?.type === 'decorator') {
      return true;
    }
  }
  // `@Component(...) export class X {}` puts the decorator on the export
  // statement rather than on the class declaration.
  const parent = declaration.parent;
  for (let i = 0; i < (parent?.childCount ?? 0); i += 1) {
    if (parent?.child(i)?.type === 'decorator') {
      return true;
    }
  }
  return false;
}

export class Instrumenter {
  private edits: Edit[] = [];
  private statements: Location[] = [];
  private functions: FunctionMapEntry[] = [];
  private branches: BranchMapEntry[] = [];
  private skipped: Array<{ line: number; reason: string }> = [];
  private handle = '';

  private typescript = false;

  constructor(private readonly parser: Parser) {}

  /**
   * Instruments `source` for the file at `filePath` (absolute, forward
   * slashes). With `embedMaps`, the file's prologue carries its own maps,
   * for a runtime that cannot be told about the file any other way (a
   * browser page); without it the loader registers the maps in-thread.
   */
  instrument(filePath: string, source: string, embedMaps = false): Instrumented {
    // TypeScript under `noImplicitAny` refuses `globalThis.__witness__` with
    // TS7017, because the global is not declared anywhere. Most paths never
    // type-check the instrumented text, but Angular's compiler does, so the
    // prologue casts on the way in. The cast is TypeScript-only syntax and
    // would be a syntax error in a .js file, so the extension decides. A
    // generated .d.ts would also work and is not used: it would have to be
    // reachable from whichever tsconfig the project happens to compile with,
    // and this keeps the instrumented file self-contained.
    this.typescript = /\.[cm]?tsx?$/i.test(filePath);
    this.edits = [];
    this.statements = [];
    this.functions = [];
    this.branches = [];
    this.skipped = [];
    this.handle = `__witness_${hash(filePath)}`;
    // Pass one finds TypeScript's non-null assertions and blanks them; they
    // mean nothing at run time, and the grammar reads `a && b!.c` as
    // `(a && b)!.c` (tree-sitter/tree-sitter-typescript issue 299), which
    // would put operand counters in the wrong places. Pass two parses the
    // blanked text, which is the same program with the right tree.
    const blanked = this.blankNonNull(source);
    const tree: Tree | null = this.parser.parse(blanked);
    if (!tree) {
      throw new Error(`Witness could not parse ${filePath}`);
    }
    const maps: WitnessMaps = { path: filePath, statementMap: {}, fnMap: {}, branchMap: {}, skipped: this.skipped };
    try {
      this.visit(tree.rootNode);
      this.statements.forEach((s, i) => (maps.statementMap[String(i)] = s));
      this.functions.forEach((f, i) => (maps.fnMap[String(i)] = f));
      this.branches.forEach((b, i) => (maps.branchMap[String(i)] = b));
      this.prologue(tree.rootNode, blanked, embedMaps ? maps : undefined);
    } finally {
      tree.delete();
    }
    const code = this.apply(blanked);
    return { code, maps, handle: this.handle };
  }

  private blankNonNull(source: string): string {
    const tree: Tree | null = this.parser.parse(source);
    if (!tree) {
      return source;
    }
    const bangs: number[] = [];
    const walk = (n: Node): void => {
      if (n.type === 'non_null_expression') {
        const last = n.child(n.childCount - 1);
        if (last && last.type === '!') {
          bangs.push(last.startIndex);
        }
      }
      for (let i = 0; i < n.namedChildCount; i += 1) {
        const c = n.namedChild(i);
        if (c) {
          walk(c);
        }
      }
    };
    try {
      walk(tree.rootNode);
    } finally {
      tree.delete();
    }
    if (bangs.length === 0) {
      return source;
    }
    const chars = source.split('');
    for (const at of bangs) {
      chars[at] = ' ';
    }
    return chars.join('');
  }

  /** The maps alone, for a file no test will load: same rules, no rewrite kept. */
  mapsOnly(filePath: string, source: string): WitnessMaps {
    return this.instrument(filePath, source).maps;
  }

  // ---- edits ----

  private insert(at: number, text: string, order = 5, closer = false): void {
    this.edits.push({ at, text, order, seq: this.edits.length, closer });
  }

  private apply(source: string): string {
    const edits = [...this.edits].sort((a, b) => a.at - b.at || a.order - b.order || (a.closer && b.closer ? b.seq - a.seq : a.seq - b.seq));
    let out = '';
    let cursor = 0;
    for (const e of edits) {
      out += source.slice(cursor, e.at) + e.text;
      cursor = e.at;
    }
    return out + source.slice(cursor);
  }

  /** `const W = globalThis.__witness__.file("<id>"[, maps]);` after any shebang and directive prologue. TypeScript gets a cast; see instrument(). */
  private prologue(root: Node, source: string, maps?: WitnessMaps): void {
    let at = 0;
    if (source.startsWith('#!')) {
      at = source.indexOf('\n') + 1;
    }
    for (let i = 0; i < root.namedChildCount; i += 1) {
      const child = root.namedChild(i)!;
      if (child.type === 'comment') {
        continue;
      }
      if (!isDirective(child)) {
        break;
      }
      at = child.endIndex;
    }
    // `skipped` rides along with the rest. It is easy to read the embedded
    // maps as only what the counters need and leave it out, and that loses it
    // exactly where it matters most: the decorated-field skip exists because
    // of Angular, and Angular in a browser is the embedding path. Without it
    // the driver would show three uncounted lines in a component and have
    // nothing to say about why.
    const embedded = maps
      ? `, ${JSON.stringify({ path: maps.path, statementMap: maps.statementMap, fnMap: maps.fnMap, branchMap: maps.branchMap, skipped: maps.skipped })}`
      : '';
    const declaration = this.typescript ? `const ${this.handle}: ${HANDLE_TYPE} = (globalThis as any)` : `const ${this.handle} = globalThis`;
    this.insert(at, `${declaration}.__witness__.file(${JSON.stringify(this.handle)}${embedded});`, 0);
  }

  // ---- counters ----

  private statement(node: Node): number {
    const id = this.statements.length;
    this.statements.push(loc(node));
    return id;
  }

  private coverStatement(node: Node): void {
    const id = this.statement(node);
    this.insert(node.startIndex, `${this.handle}.s(${id});`, 3);
  }

  /** A statement whose worth is an expression: the initialiser of a declarator or a class field. */
  private coverValue(value: Node, name: string): void {
    const id = this.statement(value);
    this.insert(value.startIndex, `${this.handle}.v(${id}, ${JSON.stringify(name)}, `, 4);
    this.insert(value.endIndex, ')', 1, true);
  }

  private coverFunction(node: Node): void {
    const body = node.childForFieldName('body');
    if (!body) {
      return; // an overload signature or an abstract method
    }
    const nameNode = node.childForFieldName('name');
    let name = nameNode?.text ?? '';
    if (!name) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator' || parent?.type === 'public_field_definition' || parent?.type === 'pair' || parent?.type === 'assignment_expression') {
        name = (parent.childForFieldName('name') ?? parent.childForFieldName('key') ?? parent.childForFieldName('left'))?.text ?? '';
      }
    }
    const id = this.functions.length;
    this.functions.push({
      name: name || '(anonymous_' + id + ')',
      decl: { start: loc(node).start, end: loc(body).start },
      loc: loc(body),
      line: node.startPosition.row + 1,
    });
    if (body.type === 'statement_block') {
      this.insert(body.startIndex + 1, `${this.handle}.f(${id});`, 2);
    } else {
      // An arrow with an expression body: istanbul turns it into a block
      // with a return and counts that return as a statement. Same here.
      const sid = this.statement(body);
      this.insert(body.startIndex, `(${this.handle}.f(${id}), ${this.handle}.s(${sid}), `, 4);
      this.insert(body.endIndex, ')', 1, true);
    }
  }

  private branch(type: string, node: Node, locations: Location[]): number {
    const id = this.branches.length;
    this.branches.push({ type, line: node.startPosition.row + 1, loc: loc(node), locations });
    return id;
  }

  /**
   * An `else if` has nowhere to put its statement counter, so it rides in
   * front of the condition as the first operand of a comma expression. A
   * comma keeps narrowing: `if ((W.s(2), p))` still narrows `p` in the body,
   * where `if (W.b(0, p))` did not.
   */
  private prefixCondition(condition: Node, statementId: number): void {
    // `if (x)` keeps its parentheses: the counter goes inside them.
    const target = condition.type === 'parenthesized_expression' && condition.namedChildCount === 1 ? condition.namedChild(0)! : condition;
    this.insert(target.startIndex, `(${this.handle}.s(${statementId}), `, 4);
    this.insert(target.endIndex, ')', 1, true);
  }

  /** `(W.c(id, index), expr)`: the outcome recorded beside the value, never around it. */
  private markOperand(id: number, index: number, node: Node): void {
    this.insert(node.startIndex, `(${this.handle}.c(${id}, ${index}), `, 4);
    this.insert(node.endIndex, ')', 1, true);
  }

  /**
   * The arm counters of an if, inside the arms, so the condition is left
   * exactly as the person wrote it and keeps narrowing the body.
   *
   * A missing else is given one, because the way not taken still has to be
   * recorded; istanbul-lib-instrument does the same. That `else` has to be
   * emitted as part of the consequent's own closing edit rather than as an
   * edit of its own: an enclosing block can end at the very same offset, and
   * two independent edits there sort by rules that cannot tell which brace
   * belongs to whom. `if (a) { if (b) { x } }` came out as
   * `}} else {...}` when they were separate, which is a syntax error and is
   * how this was found.
   */
  private coverIfArms(id: number, consequence: Node, elseBody: Node | null): void {
    const bare = consequence.type !== 'statement_block';
    this.insert(bare ? consequence.startIndex : consequence.startIndex + 1, `${bare ? '{' : ''}${this.handle}.c(${id}, 0);`, 1);
    const close = `${bare ? '}' : ''}${elseBody ? '' : ` else {${this.handle}.c(${id}, 1);}`}`;
    if (close) {
      this.insert(consequence.endIndex, close, 9, true);
    }
    if (elseBody) {
      // An `else if` is braced now, where it used to be left as written: the
      // arm counter has to go somewhere, and `else W.c(0, 1); if (...)` would
      // be a different program. The inner if is still a statement of its own
      // and keeps its own counters inside those braces.
      this.blockify(elseBody);
      this.markArm(id, 1, elseBody);
    }
  }

  /** `W.c(id, index);` as the first statement of an arm, after any brace blockify added. */
  private markArm(id: number, index: number, node: Node): void {
    const text = `${this.handle}.c(${id}, ${index});`;
    if (node.type === 'statement_block') {
      this.insert(node.startIndex + 1, text, 2);
    } else if (node.type === 'empty_statement') {
      // blockify leaves a bare `;` alone; it is still an arm that can run.
      this.insert(node.startIndex, `{${text}`, 1);
      this.insert(node.endIndex, '}', 9, true);
    } else {
      this.insert(node.startIndex, text, 2);
    }
  }

  /** Braces around a bare statement body. An `else if` keeps its shape; it is a statement of its own with its own counters. */
  private blockify(node: Node | null, elseBranch = false): void {
    if (!node || node.type === 'statement_block' || node.type === 'empty_statement' || (elseBranch && node.type === 'if_statement')) {
      return;
    }
    this.insert(node.startIndex, '{', 1);
    this.insert(node.endIndex, '}', 9, true);
  }

  // ---- the walk ----

  private visit(node: Node): void {
    const type = node.type;
    if (type === 'variable_declarator') {
      const value = node.childForFieldName('value');
      if (value) {
        this.coverValue(value, node.childForFieldName('name')?.text ?? '');
      }
    } else if (type === 'public_field_definition') {
      const value = node.childForFieldName('value');
      if (value) {
        if (inDecoratedClass(node)) {
          this.skipped.push({ line: value.startPosition.row + 1, reason: DECORATED_FIELD });
        } else {
          this.coverValue(value, node.childForFieldName('name')?.text ?? '');
        }
      }
    } else if (STATEMENT_TYPES.has(type)) {
      // A label must sit directly on its loop for `continue label` to
      // parse, so the loop under a label carries no counter of its own; the
      // labeled statement's counter is on the same line. A directive
      // ('use strict') is not a statement to Istanbul or to the engine, and
      // a counter in front of it would demote it to a plain string.
      // An `else if` is a statement to Istanbul but a counter in front of it
      // would split it from its `else` (`else W.s(2); if (...)` is a different
      // program), so its counter rides inside the condition instead.
      const elseIf = type === 'if_statement' && node.parent?.type === 'else_clause';
      if (node.parent?.type !== 'labeled_statement' && !isDirective(node) && !elseIf) {
        this.coverStatement(node);
      }
      this.coverControl(node, elseIf ? this.statement(node) : undefined);
    } else if (FUNCTION_TYPES.has(type)) {
      this.coverFunction(node);
    } else if (type === 'ternary_expression') {
      const condition = node.childForFieldName('condition')!;
      if (this.misparsed(condition)) {
        this.skipped.push({ line: node.startPosition.row + 1, reason: MISPARSE });
      } else {
        const consequence = node.childForFieldName('consequence')!;
        const alternative = node.childForFieldName('alternative')!;
        const id = this.branch('cond-expr', node, [loc(consequence), loc(alternative)]);
        this.markOperand(id, 0, consequence);
        this.markOperand(id, 1, alternative);
      }
    } else if (type === 'binary_expression' && LOGICAL.has(node.childForFieldName('operator')?.text ?? '')) {
      if (!this.isOperandOfSameRun(node)) {
        if (this.misparsed(node)) {
          this.skipped.push({ line: node.startPosition.row + 1, reason: MISPARSE });
        } else {
          const operands = this.flattenRun(node, node.childForFieldName('operator')!.text);
          const id = this.branch('binary-expr', node, operands.map(loc));
          operands.forEach((o, i) => this.markOperand(id, i, o));
        }
      }
    } else if ((type === 'required_parameter' || type === 'optional_parameter') && node.childForFieldName('value')) {
      const value = node.childForFieldName('value')!;
      const id = this.branch('default-arg', node, [loc(value)]);
      this.markOperand(id, 0, value);
    } else if (type === 'assignment_pattern' || type === 'object_assignment_pattern') {
      // A default anywhere a pattern can carry one: a parameter, a
      // destructured parameter, or a destructuring declaration in a body.
      // Istanbul counts them all as default-arg branches.
      const value = node.childForFieldName('right')!;
      const id = this.branch('default-arg', node, [loc(value)]);
      this.markOperand(id, 0, value);
    }
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      if (child) {
        this.visit(child);
      }
    }
  }

  private coverControl(node: Node, statementInCondition?: number): void {
    const type = node.type;
    if (type === 'if_statement') {
      const consequence = node.childForFieldName('consequence')!;
      const alternative = node.childForFieldName('alternative');
      const elseBody = alternative?.namedChild(0) ?? null;
      const id = this.branch('if', node, [loc(consequence), elseBody ? loc(elseBody) : emptyLoc(node)]);
      if (statementInCondition !== undefined) {
        this.prefixCondition(node.childForFieldName('condition')!, statementInCondition);
      }
      this.coverIfArms(id, consequence, elseBody);
    } else if (type === 'switch_statement') {
      const body = node.childForFieldName('body')!;
      const cases: Node[] = [];
      for (let i = 0; i < body.namedChildCount; i += 1) {
        const c = body.namedChild(i)!;
        if (c.type === 'switch_case' || c.type === 'switch_default') {
          cases.push(c);
        }
      }
      const id = this.branch('switch', node, cases.map(loc));
      cases.forEach((c, i) => {
        // After the colon that ends the case label.
        const colon = this.colonOf(c);
        this.insert(colon + 1, `${this.handle}.c(${id}, ${i});`, 2);
      });
    } else {
      for (const [t, fields] of WRAPPING_BODIES) {
        if (t === type) {
          for (const f of fields) {
            this.blockify(node.childForFieldName(f));
          }
        }
      }
    }
  }

  private colonOf(switchCase: Node): number {
    for (let i = switchCase.childCount - 1; i >= 0; i -= 1) {
      const c = switchCase.child(i)!;
      if (c.type === ':') {
        return c.startIndex;
      }
    }
    return switchCase.startIndex;
  }

  /**
   * Istanbul makes one branch of a whole run of logical operators, whatever
   * the operators and however the parentheses fall (`a || (b && c)` is one
   * branch with three operands), so a logical expression inside another
   * logical expression is not a branch of its own.
   */
  private isOperandOfSameRun(node: Node): boolean {
    let parent = node.parent;
    while (parent && parent.type === 'parenthesized_expression') {
      parent = parent.parent;
    }
    return Boolean(parent && parent.type === 'binary_expression' && LOGICAL.has(parent.childForFieldName('operator')?.text ?? ''));
  }

  /**
   * tree-sitter-typescript reads `a || b!.c === d` as `(a || b)!.c === d`:
   * a non-null assertion directly over a binary expression, which no real
   * program contains. Wrapping operands on that reading would record the
   * wrong outcome, so such a run is left uncounted and reported, never
   * guessed at. Statements around it are counted as usual.
   */
  private misparsed(node: Node): boolean {
    if (node.type === 'non_null_expression' && node.namedChildCount === 1 && node.namedChild(0)!.type === 'binary_expression') {
      return true;
    }
    let up = node.parent;
    while (up && up.type === 'parenthesized_expression') {
      up = up.parent;
    }
    if (node.type === 'binary_expression' && up?.type === 'non_null_expression') {
      return true;
    }
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i)!;
      if (FUNCTION_TYPES.has(child.type)) {
        continue;
      }
      if (this.misparsed(child)) {
        return true;
      }
    }
    return false;
  }

  private flattenRun(node: Node, _operator: string): Node[] {
    const out: Node[] = [];
    const walk = (n: Node): void => {
      const inner = n.type === 'parenthesized_expression' && n.namedChildCount === 1 ? n.namedChild(0)! : n;
      if (inner.type === 'binary_expression' && LOGICAL.has(inner.childForFieldName('operator')?.text ?? '')) {
        walk(inner.childForFieldName('left')!);
        walk(inner.childForFieldName('right')!);
      } else {
        out.push(n);
      }
    };
    walk(node);
    return out;
  }
}

