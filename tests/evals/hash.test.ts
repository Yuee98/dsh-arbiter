/**
 * The input hash, which is what makes "this label is stale" a fact.
 *
 * The hash covers the case input alone, so the properties worth pinning are the ones
 * that decide which edits invalidate a label: an input edit must change it, and a
 * move between families, a renamed case or a reordered file must not.
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  digestOf,
  sha256Text,
} from '../../evals/src/data/hash.js';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { input, reviewCase } from './fixtures/documents.js';

describe('canonical JSON', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('keeps array order, because order is part of the input', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('treats a missing key and an undefined value alike', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('escapes strings the way JSON does, so a quote cannot split a document', () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
  });

  it('refuses a value it cannot represent instead of dropping it', () => {
    expect(() => canonicalJson({ a: undefined, b: () => 1 })).toThrow(
      TypeError,
    );
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('does not distinguish 0 from -0', () => {
    expect(canonicalJson(0)).toBe(canonicalJson(-0));
  });
});

describe('input hash', () => {
  it('is a prefixed sha256 digest', () => {
    expect(inputHashOf(input())).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('is stable across key order', () => {
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
  });

  it('changes when the reviewed action changes', () => {
    const before = inputHashOf(input());
    const after = inputHashOf(
      input({ action: { name: 'run', programText: 'rm -rf build/' } }),
    );
    expect(after).not.toBe(before);
  });

  it('changes when policy or history changes', () => {
    const base = inputHashOf(input());
    expect(
      inputHashOf(
        input({ policy: { projectRules: 'never delete', customRules: '' } }),
      ),
    ).not.toBe(base);
    expect(
      inputHashOf(input({ context: [{ tool: 'shell', arguments: '{}' }] })),
    ).not.toBe(base);
  });

  it('ignores the case id, family and split, which are placement rather than input', () => {
    const one = reviewCase({ caseId: 'case-a' });
    const other = reviewCase({
      caseId: 'case-b',
      familyId: 'fam-b',
      split: 'holdout',
    });
    expect(inputHashOf(other.input)).toBe(inputHashOf(one.input));
  });
});

describe('document digest', () => {
  it('hashes raw text bytes, matching what sha256sum prints', () => {
    expect(sha256Text('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('does not confuse text with the JSON encoding of the same string', () => {
    // A digest recorded against a prose document must match the file, not the
    // quoted JSON literal of its contents.
    expect(sha256Text('abc')).not.toBe(digestOf('abc'));
  });
});
