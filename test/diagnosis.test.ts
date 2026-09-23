/**
 * The brief the toolkit hands an assistant when a run fails.
 *
 * The rule this holds in place, ruled 2026-09-23: the toolkit owns
 * detection, evidence, and guardrails; the assistant owns the explanation.
 * So the brief must carry every fact and every boundary, and it must tell
 * the assistant, in as many words, not to go looking for a cause of its own
 * when one has already been established.
 *
 * The failure mode worth guarding is quiet. An assistant handed a wall of
 * runner output will produce a confident, fluent, wrong answer, and a person
 * will act on it. That is worse than no help. Every assertion below exists
 * because of that: the classified brief forbids re-diagnosis, the
 * unclassified brief forbids invention, and both carry the constraints in
 * binding language rather than as suggestions.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildFailureBrief, unclassifiedPacket, upstreamPathFailure } from '../src/index';
import type { ProblemPacket } from '../src/index';

const NASTY = "C:\\workspace\\MikeVan's AI Development Toolkit\\app";
const ANGULAR_OUTPUT = [
  'Application bundle generation failed. [2.378 seconds]',
  '✘ [ERROR] Expected ";" but found "s"',
  "      1 │ import 'C:/workspace/MikeVan's AI Development Toolkit/app/polyfills.js';",
].join('\n');

function pathPacket(): ProblemPacket {
  return upstreamPathFailure({ workspaceRoot: NASTY, runner: 'ng-karma', output: ANGULAR_OUTPUT, succeeded: false })!.packet;
}

test('a classified brief asks the four questions and forbids diagnosing it again', () => {
  const brief = buildFailureBrief(pathPacket());

  assert.match(brief, /1\. What is wrong\?/);
  assert.match(brief, /2\. Why did it happen\?/);
  assert.match(brief, /3\. How do I fix it\?/);
  assert.match(brief, /4\. What should I not change\?/);

  assert.match(brief, /already been diagnosed/, 'the classification is handed over, not requested');
  assert.match(brief, /Do not diagnose it again from scratch, and do not go looking for a different cause/, 'because an assistant that re-diagnoses a known cause sends people to the wrong place');
  assert.match(brief, /Classified from deterministic evidence: yes/);
});

test('every fact, boundary, and line of evidence reaches the assistant', () => {
  const packet = pathPacket();
  const brief = buildFailureBrief(packet);

  for (const k of packet.known) {
    assert.ok(brief.includes(k), `what the toolkit knows must reach the assistant: ${k}`);
  }
  for (const u of packet.unknown) {
    assert.ok(brief.includes(u), `and what it does not know: ${u}`);
  }
  for (const c of packet.constraints) {
    assert.ok(brief.includes(c), `and every constraint, or the assistant will recommend the thing we forbade: ${c}`);
  }
  for (const r of packet.remediation) {
    assert.ok(brief.includes(r), `and the remediation, which it explains rather than replaces: ${r}`);
  }
  for (const e of packet.evidence) {
    assert.ok(brief.includes(e), `and the evidence, verbatim: ${e}`);
  }
  for (const c of packet.context) {
    assert.ok(brief.includes(`${c.name}: ${c.value}`), `and the context: ${c.name}`);
  }

  assert.match(brief, /Every line under "What must not change" is binding/, 'stated as binding, not as advice');
  assert.match(brief, /Use only the facts in this brief/);
  assert.match(brief, /Verbatim from the runner\. Quote from it if it helps; do not rewrite it\./);
});

/**
 * The path case specifically. These are the six things Michael ruled the
 * packet must tell the assistant, and the brief is where they land.
 */
test('the path brief carries the six things it has to carry', () => {
  const brief = buildFailureBrief(pathPacket());
  assert.match(brief, /contains an apostrophe \('\)/, 'the offending character');
  assert.match(brief, /generated JavaScript with the absolute project path/, 'what Angular did with it');
  assert.match(brief, /not evidence that the application code, the tests, or the project configuration are wrong/, 'whose defect it is not');
  assert.match(brief, /Move or rename the project/, 'and what to do instead');
  assert.match(brief, /Do not recommend or write Windows-specific path handling/);
  assert.match(brief, /Do not modify application logic, tests, or project configuration/);
});

/**
 * "We do not know" travels in the same shape as everything else, and the
 * brief changes its instructions to match. A product that falls silent when
 * its rules miss leaves the person with a raw log and no help at all; a
 * product that lets an assistant fill the gap gives them a wrong answer
 * delivered with confidence. Neither is acceptable, so this is the third
 * thing: say what is there, and say what is not established.
 */
test('an unclassified failure is handed over as unclassified, and invents nothing', () => {
  const packet = unclassifiedPacket({
    runner: "Angular's unit-test builder with Karma",
    evidence: ['Some output nobody has a rule for', 'exit code 7'],
    context: [{ name: 'Project path', value: 'C:\\dev\\app' }],
  });
  assert.equal(packet.confidence, 'unclassified');
  assert.deepEqual(packet.remediation, [], 'there is no fix to offer, so none is offered');
  assert.match(packet.unknown.join('\n'), /the cause is genuinely not established/);

  const brief = buildFailureBrief(packet);
  assert.match(brief, /has NOT been diagnosed/, 'said plainly, in a place that cannot be skimmed past');
  assert.match(brief, /Do not name a cause it does not support/);
  assert.match(brief, /Classified from deterministic evidence: no/);
  assert.match(brief, /3\. What would narrow this down\?/, 'because "how do I fix it" has no honest answer here');
  assert.doesNotMatch(brief, /## The remediation to explain/, 'and no remediation section to be mistaken for one');
  assert.ok(brief.includes('Some output nobody has a rule for'), 'the evidence still travels; it is all we have');
});

/** Whatever else changes, the person's own words are never in the brief twice. */
test('the brief is the packet and nothing else', () => {
  const packet = pathPacket();
  const brief = buildFailureBrief(packet);
  assert.ok(!/\bTODO\b|\bFIXME\b/.test(brief));
  assert.ok(brief.startsWith('# Explain a test run that failed before the tests started'), 'it says what it is in its first line');
  assert.ok(brief.split('```').length === 3, 'exactly one fenced block, holding the evidence');
});
