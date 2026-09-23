/**
 * The problem packet: what the toolkit knows about a failure, in a shape an
 * assistant can turn into guidance.
 *
 * The division of labour, ruled 2026-09-23. Polyglot owns detection,
 * evidence, and guardrails. Copilot owns the human explanation and the
 * guided remediation. Neither does the other's job.
 *
 * The reason for the split is what the old design cost. Every recognised
 * failure carried a hand-written paragraph, and that paragraph had to be
 * rewritten for every audience, every runner, and every wording change,
 * with a test pinning each sentence. Four rounds of that on one condition
 * was enough to see where it ends: an encyclopedia of prose inside a
 * measurement tool, maintained by hand, out of date the week it ships.
 *
 * So the toolkit stops writing prose. It writes down what it established,
 * what it could not establish, and what must not be recommended, and it
 * hands that over. A packet is facts and boundaries. The sentences are
 * somebody else's job.
 *
 * The two rules that keep this honest:
 *
 *   Copilot is never asked to diagnose from scratch. When the toolkit has
 *   deterministic evidence, the classification comes from the toolkit, and
 *   the assistant translates it. An assistant guessing at a cause we already
 *   know is how a person gets sent to the wrong place.
 *
 *   When the toolkit cannot classify a failure, it says so in the packet
 *   rather than inventing a category. The brief then tells the assistant to
 *   explain what the evidence shows and to stop there. "We do not know" is
 *   an answer; a confident wrong answer is not.
 */
import type { Runner } from './delivery';

/** What the toolkit established about a failure, and what it did not. */
export interface ProblemPacket {
  /**
   * The condition, by name, stable enough for a product or a test to refer
   * to it. `unclassified` when the toolkit could not place the failure.
   */
  condition: string;
  /** Broad kind of failure, for the assistant to frame its answer around. */
  category: string;
  /**
   * Whether the classification rests on deterministic evidence. An
   * unclassified packet carries evidence and nothing more; nothing
   * downstream may present it as a diagnosis.
   */
  confidence: 'classified' | 'unclassified';
  /** The runner that failed, in words a person would recognise. */
  runner: string;
  /** One line for a notification. Not an explanation, and never a wall. */
  headline: string;
  /**
   * What the person may be offered. `explain` is always available.
   * `fix` only where a code change is genuinely the remedy, which is why
   * the path condition does not carry it: the fix is moving a folder, and
   * an assistant writing code to compensate is the outcome we forbid.
   */
  actions: Array<'explain' | 'fix'>;
  /** Verbatim lines from the runner. Never paraphrased. */
  evidence: string[];
  /** Path and configuration facts the explanation needs. */
  context: Array<{ name: string; value: string }>;
  /** Statements the toolkit is prepared to stand behind. */
  known: string[];
  /** Questions this run cannot answer, so that nobody fills them in. */
  unknown: string[];
  /** Remediation the toolkit is confident in. Empty when unclassified. */
  remediation: string[];
  /** Binding limits on what may be recommended or changed. */
  constraints: string[];
}

/**
 * A packet for a failure the toolkit could not place.
 *
 * This exists so that "we do not know" travels in the same shape as
 * everything else. The alternative is a product that falls silent whenever
 * its rules miss, which leaves the person with a raw log and no help at all.
 */
export function unclassifiedPacket(options: { runner: string; evidence: string[]; context?: Array<{ name: string; value: string }>; headline?: string }): ProblemPacket {
  return {
    condition: 'unclassified',
    category: 'unknown',
    confidence: 'unclassified',
    runner: options.runner,
    headline: options.headline ?? `${options.runner} failed, and the toolkit could not work out why.`,
    actions: ['explain'],
    evidence: options.evidence,
    context: options.context ?? [],
    known: [`${options.runner} did not finish successfully.`],
    unknown: ['What caused the failure. The toolkit has no rule that matches this output, so the cause is genuinely not established.'],
    remediation: [],
    constraints: ['Do not state a cause the evidence does not support. Explaining what the evidence shows, and saying plainly what it does not establish, is the whole job here.'],
  };
}

/**
 * The brief handed to the assistant.
 *
 * Same shape of hand-off as the untangle brief: a markdown document stating
 * the job, the facts, and what done looks like. Written so a capable model
 * gets it right and a weak one cannot mistake it for an invitation to
 * speculate.
 */
export function buildFailureBrief(packet: ProblemPacket): string {
  const lines: string[] = [];
  const classified = packet.confidence === 'classified';

  lines.push(`# Explain a test run that failed before the tests started`);
  lines.push('');
  lines.push(
    classified
      ? 'This failure has already been diagnosed. The classification and the evidence below come from deterministic checks that have already run. Do not diagnose it again from scratch, and do not go looking for a different cause. Your job is to turn what is below into guidance a person can act on.'
      : 'This failure has NOT been diagnosed. The checks that ran did not match it, so the cause is not known. Explain what the evidence below shows and say plainly what it does not establish. Do not name a cause it does not support.',
  );
  lines.push('');
  lines.push('Answer these four questions, in this order, in plain language:');
  lines.push('');
  lines.push('1. What is wrong?');
  lines.push('2. Why did it happen?');
  lines.push(classified ? '3. How do I fix it?' : '3. What would narrow this down?');
  lines.push('4. What should I not change?');
  lines.push('');
  lines.push('## How to answer');
  lines.push('');
  lines.push('- Use only the facts in this brief. If something is not here, say it is not known rather than filling the gap.');
  lines.push('- Everything under "What is not known" is genuinely unknown. Do not guess at it, and do not present a guess as a possibility worth acting on.');
  lines.push('- Every line under "What must not change" is binding. Do not recommend anything that breaks one, however reasonable it looks.');
  lines.push('- Keep it short. Somebody is stuck and wants to get unstuck.');
  lines.push('');
  lines.push('## The failure');
  lines.push('');
  lines.push(`- Runner or framework: ${packet.runner}`);
  lines.push(`- Category: ${packet.category}`);
  lines.push(`- Classified from deterministic evidence: ${classified ? 'yes' : 'no'}`);
  lines.push('');

  if (packet.context.length > 0) {
    lines.push('## Context');
    lines.push('');
    for (const c of packet.context) {
      lines.push(`- ${c.name}: ${c.value}`);
    }
    lines.push('');
  }

  lines.push('## What is known');
  lines.push('');
  for (const k of packet.known) {
    lines.push(`- ${k}`);
  }
  lines.push('');

  lines.push('## What is not known');
  lines.push('');
  for (const u of packet.unknown) {
    lines.push(`- ${u}`);
  }
  lines.push('');

  if (packet.remediation.length > 0) {
    lines.push('## The remediation to explain');
    lines.push('');
    lines.push('This is the fix. Explain it in your own words so the person understands why it works. Do not replace it with a different one.');
    lines.push('');
    for (const r of packet.remediation) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  lines.push('## What must not change');
  lines.push('');
  for (const c of packet.constraints) {
    lines.push(`- ${c}`);
  }
  lines.push('');

  lines.push('## Exact error evidence');
  lines.push('');
  lines.push('Verbatim from the runner. Quote from it if it helps; do not rewrite it.');
  lines.push('');
  lines.push('```');
  for (const e of packet.evidence) {
    lines.push(e);
  }
  lines.push('```');

  return lines.join('\n');
}

/** The runner in the words a person would recognise. */
export function describeRunner(runner: Runner): string {
  switch (runner) {
    case 'ng-karma':
      return "Angular's unit-test builder with Karma";
    case 'ng-vitest':
      return "Angular's unit-test builder with Vitest";
    case 'playwright-ct':
      return 'Playwright component tests';
    default:
      return runner;
  }
}
