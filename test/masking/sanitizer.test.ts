import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Sanitizer } from '../../src/masking/sanitizer.js';

describe('Sanitizer with bundled defaults', () => {
  const sanitizer = new Sanitizer();

  it('exposes the bundled ruleset version', () => {
    assert.match(sanitizer.rulesetVersion, /^\d{4}\.\d+\.\d+$/);
  });

  it('redacts emails', () => {
    assert.equal(
      sanitizer.sanitize('contact john.doe@example.com for details'),
      'contact [EMAIL] for details'
    );
  });

  it('redacts secrets like OpenAI keys', () => {
    // Synthetic, zero-entropy fixture — chosen to (a) match the openai_key rule
    // `sk-[A-Za-z0-9\-_]*[A-Za-z0-9]{20,}` and (b) not trip secret-scanners.
    const out = sanitizer.sanitize('key: sk-AAAAAAAAAAAAAAAAAAAA');
    assert.equal(out, 'key: [SECRET]');
  });

  it('redacts validated IBANs but leaves checksum-bad strings alone', () => {
    assert.equal(
      sanitizer.sanitize('IBAN GB29NWBK60161331926819 received'),
      'IBAN [IBAN] received'
    );
    assert.equal(
      sanitizer.sanitize('IBAN GB29NWBK60161331926818 invalid'),
      'IBAN GB29NWBK60161331926818 invalid'
    );
  });

  it('redacts validated credit cards but leaves Luhn-passing IMEI alone (15-digit, no IIN)', () => {
    assert.equal(
      sanitizer.sanitize('paid with 4111 1111 1111 1111 yesterday'),
      'paid with [CREDIT_CARD] yesterday'
    );
    // 490154203237518 is a real IMEI — Luhn-passes but no IIN match for cards;
    // ordering puts credit_card before imei, so it falls through to the IMEI rule.
    const imeiOut = sanitizer.sanitize('IMEI 490154203237518 was logged');
    assert.equal(imeiOut, 'IMEI [IMEI] was logged');
  });

  it('passes through strings shorter than the floor', () => {
    assert.equal(sanitizer.sanitize('hi'), 'hi');
    assert.equal(sanitizer.sanitize(''), '');
  });

  it('walks structured values via sanitizeUnknown', () => {
    // Field name is `value`, not `secret`/`apiKey`/`password`, and the literal
    // is a zero-entropy synthetic fixture — both choices avoid tripping
    // secret-scanners on this test file. The openai_key sanitizer rule still
    // fires because it matches on the value's shape, not the field name.
    const input = {
      role: 'user',
      content: 'reach me at john@example.com',
      meta: ['nothing', { value: 'sk-AAAAAAAAAAAAAAAAAAAA' }],
      n: 42,
      flag: true,
    };
    const out = sanitizer.sanitizeUnknown(input) as typeof input;
    assert.equal(out.content, 'reach me at [EMAIL]');
    assert.deepEqual((out.meta as [string, { value: string }])[1], { value: '[SECRET]' });
    assert.equal(out.n, 42);
    assert.equal(out.flag, true);
  });
});

describe('Sanitizer with custom patterns', () => {
  it('appends operator-defined rules after the defaults', () => {
    const sanitizer = new Sanitizer(undefined, [
      { name: 'ticket', regex: 'PROJ-\\d+', marker: '[TICKET]' },
    ]);
    assert.equal(
      sanitizer.sanitize('see ticket PROJ-12345 for context'),
      'see ticket [TICKET] for context'
    );
  });

  it('honors caseSensitive: false on custom patterns', () => {
    const sanitizer = new Sanitizer(undefined, [
      { regex: 'foobar', marker: '[X]', caseSensitive: false },
    ]);
    assert.equal(sanitizer.sanitize('FooBar matches'), '[X] matches');
  });
});

describe('Sanitizer with explicit rules file', () => {
  it('compiles only the rules passed in', () => {
    const sanitizer = new Sanitizer(
      {
        version: '0.0.0',
        rules: [
          {
            name: 'cat',
            description: 'feline',
            marker: '[ANIMAL]',
            pattern: 'cat',
          },
        ],
      },
      []
    );
    assert.equal(sanitizer.sanitize('the cat sat on the mat'), 'the [ANIMAL] sat on the mat');
    // Bundled rules NOT loaded → email passes through
    assert.equal(sanitizer.sanitize('hi at me@example.com'), 'hi at me@example.com');
  });

  it('drops rules whose validator is unknown (fail-closed)', () => {
    const original = console.warn;
    console.warn = () => {}; // suppress in test output
    try {
      const sanitizer = new Sanitizer(
        {
          version: '0.0.0',
          rules: [
            {
              name: 'mystery',
              description: 'unknown validator',
              marker: '[X]',
              pattern: '\\d+',
              // @ts-expect-error — deliberately invalid value
              validation: 'not_a_real_validator',
            },
          ],
        },
        []
      );
      assert.equal(sanitizer.sanitize('see number 12345 here'), 'see number 12345 here');
    } finally {
      console.warn = original;
    }
  });
});
