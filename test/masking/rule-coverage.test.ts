/**
 * Data-driven coverage test: every rule shipped in the bundled YAML must
 * (a) have at least one `example` in the schema, and (b) have each example
 * actually redacted to its declared marker by the SDK's Sanitizer. Adding a
 * new rule to data-masking-rules.yaml automatically extends test coverage —
 * no per-rule test to write.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import bundledRules from '../../src/masking/rules/rules.json' with { type: 'json' };
import type { MaskingRulesFile } from '../../src/masking/rules/types.js';
import { Sanitizer } from '../../src/masking/sanitizer.js';

const rulesFile = bundledRules as MaskingRulesFile;
const sanitizer = new Sanitizer();

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

function truncate(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > 50 ? oneLine.slice(0, 47) + '...' : oneLine;
}
