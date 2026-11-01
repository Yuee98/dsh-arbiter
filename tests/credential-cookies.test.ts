import { describe, expect, test } from 'vitest';
import { CredentialRedactor } from '../src/reviewer/credential-redactor.js';

const marker = /\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/u;
const masked: unknown = expect.stringMatching(marker);

describe('Cookie values and Set-Cookie attributes have distinct roles', () => {
  test('request cookie names resembling attributes never exempt their values', () => {
    const secret = 'synthetic-cookie-attribute-name-secret';
    const source = {
      Cookie: `sid=first-cookie-secret; Path=${secret}; Domain=another-cookie-secret`,
    };
    const redactor = new CredentialRedactor('cookie-request-roles');
    const safe = redactor.value(source);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(safe)).not.toContain('another-cookie-secret');
    expect(redactor.text(`Cookie: Path=${secret}`)).not.toContain(secret);
    expect(source.Cookie).toContain(secret);
  });
  test('the first Set-Cookie pair is always private, with subsequent attributes preserved', () => {
    const secret = 'synthetic-cookie-first-path-secret';
    const text = `Set-Cookie: Path=${secret}; Path=/tmp/output; Max-Age=4; Secure; HttpOnly`;
    const safe = new CredentialRedactor('set-cookie-first-pair').text(text);
    expect(safe).not.toContain(secret);
    expect(safe).toContain('Path=/tmp/output; Max-Age=4; Secure; HttpOnly');
    expect(safe).toMatch(marker);
  });
  test('quoted Cookie values share identity with their actual decoded value', () => {
    const secret = 'synthetic-quoted-cookie-secret';
    const redactor = new CredentialRedactor('cookie-double-quotes');
    const safe = redactor.value({
      password: secret,
      Cookie: `sid="${secret}"`,
    });
    const identity = redactor.text(secret);
    expect(safe).toEqual({ password: identity, Cookie: `sid="${identity}"` });
    expect(redactor.text(`Cookie: sid="${secret}"`)).toBe(
      `Cookie: sid="${identity}"`,
    );
  });
  test('known numeric values do not turn Set-Cookie metadata fragments into private scalars', () => {
    const redactor = new CredentialRedactor('cookie-numeric-attributes', ['4']);
    const identity = redactor.text('4');
    expect(
      redactor.value({ 'Set-Cookie': 'sid=4; Max-Age=4; Path=/tmp/q4' }),
    ).toEqual({ 'Set-Cookie': `sid=${identity}; Max-Age=4; Path=/tmp/q4` });
    expect(redactor.value({ Cookie: 'sid=4; Max-Age=4' })).toEqual({
      Cookie: `sid=${identity}; Max-Age=${identity}`,
    });
    const initial = redactor.value({
      'Set-Cookie': 'sid=another-private-cookie; Max-Age=4',
    });
    expect(redactor.value(initial)).toEqual(initial);
    expect(JSON.stringify(initial)).toContain('; Max-Age=4');
  });
  test('verified attribute names survive protocol collisions while their material echoes mask', () => {
    const redactor = new CredentialRedactor('cookie-attribute-labels', [
      'Path',
      'Secure',
    ]);
    const source = 'sid=private-cookie-value; Path=/tmp/Path; Secure';
    const result = redactor.value({ 'Set-Cookie': source });
    const path: unknown = expect.stringContaining('; Path=/tmp/[redacted:v1:');
    expect(result).toMatchObject({ 'Set-Cookie': path });
    expect(JSON.stringify(result)).toContain('; Secure');
    const text = redactor.text(`Set-Cookie: ${source}`);
    expect(text).toContain('; Path=/tmp/[redacted:v1:');
    expect(text).toContain('; Secure');
  });
  test('quoted header presentation retains the URL and every source split gives the same safe text', () => {
    const secret = 'synthetic-cookie-framing-secret';
    const redactor = new CredentialRedactor('cookie-quoted-presentation', [
      secret,
    ]);
    const text = `curl -H 'Cookie: sid="${secret}"' https://ops.example.test/?recipient=ops@example.test&count=4`;
    const expected = redactor.text(text);
    expect(expected).not.toContain(secret);
    expect(expected).toContain(
      'https://ops.example.test/?recipient=ops@example.test&count=4',
    );
    for (let at = 0; at <= text.length; at += 1)
      expect(
        redactor.textBlockValues([text.slice(0, at), text.slice(at)]).join(''),
      ).toBe(expected);
  });
  test('decoded structured credentials containing literal quotes remain distinct', () => {
    const redactor = new CredentialRedactor('credential-literal-quotes');
    const plain = 'synthetic-distinct-quoted-value';
    const quoted = `'${plain}'`;
    const safe = redactor.value({ password: plain, token: quoted });
    expect(safe).toMatchObject({ password: masked, token: masked });
    expect(redactor.text(plain)).not.toBe(redactor.text(quoted));
    expect(safe).toEqual({
      password: redactor.text(plain),
      token: redactor.text(quoted),
    });
  });
  test.each(['{', '['])(
    'a decoded authentication string %s is material rather than malformed JSON framing',
    (value) => {
      const redactor = new CredentialRedactor(`decoded-auth-${value}`);
      const safe = redactor.value({ Authorization: value });
      expect(safe).toEqual({ Authorization: redactor.text(value) });
      expect(redactor.text(value)).toMatch(marker);
    },
  );
});
