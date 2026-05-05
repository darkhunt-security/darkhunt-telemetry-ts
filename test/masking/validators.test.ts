import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aba } from '../../src/masking/validators/aba.js';
import { base58check } from '../../src/masking/validators/base58check.js';
import { bech32 } from '../../src/masking/validators/bech32.js';
import { creditCard } from '../../src/masking/validators/creditCard.js';
import { eip55 } from '../../src/masking/validators/eip55.js';
import { ibanMod97 } from '../../src/masking/validators/ibanMod97.js';
import { luhn } from '../../src/masking/validators/luhn.js';

describe('luhn', () => {
  it('accepts known-good Luhn numbers', () => {
    assert.equal(luhn('79927398713'), true);
    assert.equal(luhn('4111 1111 1111 1111'), true); // Visa test card
    assert.equal(luhn('5500-0000-0000-0004'), true); // Mastercard test card
  });

  it('rejects non-Luhn numbers', () => {
    assert.equal(luhn('1234567890'), false);
    assert.equal(luhn('4111111111111112'), false);
  });

  it('rejects empty / non-digit input', () => {
    assert.equal(luhn(''), false);
    assert.equal(luhn('abcdef'), false);
  });
});

describe('creditCard', () => {
  it('accepts valid Visa, Mastercard, Amex, Discover', () => {
    assert.equal(creditCard('4111111111111111'), true);
    assert.equal(creditCard('4111 1111 1111 1111'), true);
    assert.equal(creditCard('5555555555554444'), true);
    assert.equal(creditCard('378282246310005'), true);
    assert.equal(creditCard('6011111111111117'), true);
  });

  it('rejects 15-digit Luhn-passing IMEI (no IIN match)', () => {
    // Real IMEI that Luhn-passes but is not a card
    assert.equal(creditCard('490154203237518'), false);
  });

  it('rejects too-short / too-long', () => {
    assert.equal(creditCard('4111'), false);
    assert.equal(creditCard('41111111111111111'), false);
  });
});

describe('aba', () => {
  it('accepts known-good ABA routing numbers', () => {
    assert.equal(aba('021000021'), true); // JPMorgan Chase NY
    assert.equal(aba('111000025'), true); // Federal Reserve Bank
  });

  it('rejects 9-digit numbers that do not match the weighted checksum', () => {
    assert.equal(aba('123456789'), false);
  });

  it('rejects wrong length', () => {
    assert.equal(aba('12345678'), false);
    assert.equal(aba('1234567890'), false);
  });
});

describe('ibanMod97', () => {
  it('accepts known-good IBANs', () => {
    assert.equal(ibanMod97('GB29NWBK60161331926819'), true);
    assert.equal(ibanMod97('IE29 AIBK 9311 5212 3456 78'), true);
    assert.equal(ibanMod97('DE89370400440532013000'), true);
  });

  it('rejects malformed IBANs', () => {
    assert.equal(ibanMod97('GB29NWBK60161331926818'), false); // last digit changed
    assert.equal(ibanMod97('TOO-SHORT'), false);
  });
});

describe('base58check', () => {
  it('accepts known-good Bitcoin P2PKH/P2SH addresses', () => {
    assert.equal(base58check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), true);
    assert.equal(base58check('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), true);
  });

  it('rejects single-char tweaks (broken checksum)', () => {
    assert.equal(base58check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb'), false);
  });

  it('rejects non-base58 characters', () => {
    assert.equal(base58check('I0Ol-not-base58'), false);
  });
});

describe('bech32', () => {
  it('accepts known-good Bech32 / Bech32m addresses', () => {
    assert.equal(bech32('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), true);
    assert.equal(bech32('bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5ss52r5n8'), true);
  });

  it('rejects mixed-case input per spec', () => {
    assert.equal(bech32('BC1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), false);
  });

  it('rejects single-char tweaks (broken checksum)', () => {
    assert.equal(bech32('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'), false);
  });
});

describe('eip55', () => {
  it('accepts EIP-55 mixed-case addresses', () => {
    assert.equal(eip55('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), true);
    assert.equal(eip55('0x52908400098527886E0F7030069857D2E4169EE7'), true);
  });

  it('accepts all-lowercase / all-uppercase (no checksum to verify)', () => {
    assert.equal(eip55('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), true);
    assert.equal(eip55('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED'), true);
  });

  it('rejects bad mixed-case checksum', () => {
    // Same address but with a single char's case flipped
    assert.equal(eip55('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), false);
  });

  it('rejects malformed addresses', () => {
    assert.equal(eip55('0x123'), false);
    assert.equal(eip55('5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), false); // missing 0x
  });
});
