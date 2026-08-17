/**
 * Data-driven coverage test: every rule shipped in the bundled YAML must
 * (a) have at least one `example` in the schema, (b) have each example
 * actually redacted to its declared marker by the SDK's Sanitizer, and
 * (c) be *reachable* — i.e. the rule itself, not some earlier rule, is what
 * redacts its own examples. Adding a new rule to data-masking-rules.yaml
 * automatically extends test coverage — no per-rule test to write.
 *
 * (b) alone is not enough: every secret rule emits the same `[SECRET]` marker,
 * so an example consumed by an earlier, more generic rule still produces a
 * `[SECRET]`-containing output and (b) passes while the rule under test never
 * runs. (c) is the assertion that distinguishes "this rule fired" from "some
 * rule fired".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import bundledRules from '../../src/masking/rules/rules.json' with { type: 'json' };
import type { MaskingRule, MaskingRulesFile } from '../../src/masking/rules/types.js';
import { Sanitizer } from '../../src/masking/sanitizer.js';

const rulesFile = bundledRules as MaskingRulesFile;
const sanitizer = new Sanitizer();

/**
 * A Sanitizer over an arbitrary slice of the bundled ruleset. Uses the real
 * production compile + apply path (flags, validators, zero-width stripping),
 * just with fewer rules — so these tests exercise the shipped engine rather
 * than a re-implementation of it.
 */
function sanitizerOver(rules: readonly MaskingRule[]): Sanitizer {
  return new Sanitizer({ version: rulesFile.version, rules: rules as MaskingRule[] });
}

/** Does this single rule, on its own, redact `text`? */
function claims(rule: MaskingRule, text: string): boolean {
  return sanitizerOver([rule]).sanitize(text) !== text;
}

describe('every rule has at least one example', () => {
  for (const rule of rulesFile.rules) {
    it(`${rule.name}`, () => {
      assert.ok(
        rule.examples && rule.examples.length > 0,
        `Rule "${rule.name}" has no examples — add at least one to data-masking-rules.yaml ` +
          `so it gets coverage in this suite.`
      );
    });
  }
});

describe('every YAML example is redacted to its rule marker', () => {
  for (const rule of rulesFile.rules) {
    if (!rule.examples) continue;
    for (const example of rule.examples) {
      it(`${rule.name} → "${truncate(example)}"`, () => {
        // Wrap in surrounding context so:
        //  - inputs shorter than the Sanitizer's MIN_INPUT_LENGTH floor are
        //    still long enough to be processed
        //  - we can verify the surrounding chars survive (catches over-greedy
        //    patterns that would also chew into innocent context)
        const wrapped = `<< ${example} >>`;
        const output = sanitizer.sanitize(wrapped);

        assert.notEqual(
          output,
          wrapped,
          `Sanitizer left example unchanged for rule "${rule.name}".`
        );
        assert.ok(
          output.includes(rule.marker),
          `Expected marker ${rule.marker} in output for rule "${rule.name}", got: ${output}`
        );
        assert.ok(
          output.startsWith('<< ') && output.endsWith(' >>'),
          `Rule "${rule.name}" overran into surrounding context: ${output}`
        );
      });
    }
  }
});

/**
 * Reachability: a rule is dead code if the sanitizer never reaches it.
 *
 * Engine model: this SDK applies rules strictly sequentially in declared file
 * order (`Sanitizer.sanitize`), each rule's matches replaced before the next
 * rule runs. So for every rule R and every example E that R documents:
 *
 *   1. isolation  — R compiled ON ITS OWN must redact E. Proves R is
 *                   well-formed and that E really is an instance of R.
 *   2. shadowing  — the rules declared BEFORE R, run as a pipeline, must leave
 *                   E untouched. Proves R is the rule that actually claims E.
 *
 * Note the trace-hub (Java) engine merges same-marker/same-flags/same-validator
 * rules into one alternation and runs the buckets in first-appearance order, so
 * it can shadow *more* than this sequential model does; a rule that fails here
 * is dead in every engine, but passing here does not by itself prove
 * reachability in trace-hub. RuleCoverageTest.java carries that check.
 */
describe('every rule is reachable — no earlier rule consumes its examples', () => {
  for (const [index, rule] of rulesFile.rules.entries()) {
    if (!rule.examples) continue;
    for (const example of rule.examples) {
      it(`${rule.name} → "${truncate(example)}"`, () => {
        const wrapped = `<< ${example} >>`;

        // 1. isolation — the rule must match its own example unaided.
        assert.ok(
          claims(rule, wrapped),
          `Rule "${rule.name}" does not match its own example. The pattern and the ` +
            `example have drifted apart — whatever redacts this example in the full ` +
            `pipeline, it is not "${rule.name}". Fix the pattern or the example in ` +
            `data-masking-rules.yaml. (pattern: ${rule.pattern})`
        );

        // 2. shadowing — nothing declared earlier may already redact it.
        const earlier = rulesFile.rules.slice(0, index);
        const prefixOutput = sanitizerOver(earlier).sanitize(wrapped);
        if (prefixOutput !== wrapped) {
          const culprit = earlier.find((r) => claims(r, wrapped));
          assert.fail(
            `Rule "${rule.name}" is UNREACHABLE: rule "${culprit?.name ?? '(unknown)'}" is ` +
              `declared earlier in data-masking-rules.yaml and already redacts this example, ` +
              `so "${rule.name}" never runs on it. Both emit "${rule.marker}", which is why ` +
              `the marker assertion above still passes — the rule is dead code.\n` +
              `  example : ${example}\n` +
              `  after "${culprit?.name ?? '?'}" : ${prefixOutput}\n` +
              `Fix: move "${rule.name}" ABOVE "${culprit?.name ?? '?'}" in ` +
              `data-masking-rules.yaml (specific-provider rules precede generic ` +
              `catch-alls), with a comment saying why — or delete "${rule.name}" if ` +
              `"${culprit?.name ?? '?'}" genuinely covers every case it would.`
          );
        }
      });
    }
  }
});

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > 50 ? oneLine.slice(0, 47) + '...' : oneLine;
}
