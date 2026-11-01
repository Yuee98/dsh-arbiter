import { describe, expect, test } from 'vitest';
import { CredentialRedactor } from '../src/reviewer/credential-redactor.js';
import { copyArgumentsSchema } from '../src/audit/schema-redaction.js';

const marker = /\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/u;
const masked: unknown = expect.stringMatching(marker);

describe('credential boundary regressions from the first PR review', () => {
  test('an exact known credential takes precedence over ordinary authorization words', () => {
    const ordinary = new CredentialRedactor('ordinary-permission-word');
    expect(ordinary.value({ Authorization: 'approved' })).toEqual({
      Authorization: 'approved',
    });
    const known = new CredentialRedactor('known-permission-word', ['approved']);
    const identity = known.text('approved');
    expect(identity).toMatch(marker);
    expect(known.value({ Authorization: 'approved' })).toEqual({
      Authorization: identity,
    });
    expect(known.text('Authorization: approved')).toContain(identity);
  });
  test('short/numeric values keep explicit, whole-value and quoted identities without rewriting quantities or paths', () => {
    const redactor = new CredentialRedactor('short-context', [
      '4',
      'a',
      '123456789',
    ]);
    const source = {
      password: '4',
      instruction: 'Only send 4 files',
      path: '/tmp/q4',
      count: 4,
      echo: '4',
      article: 'a file',
      numericText: 'operation 123456789 failed',
    };
    expect(redactor.value(source)).toMatchObject({
      password: masked,
      instruction: source.instruction,
      path: source.path,
      count: 4,
      echo: masked,
      article: source.article,
      numericText: source.numericText,
    });
    expect(redactor.text('Authorization: Bearer 4')).not.toContain('Bearer 4');
    const text = 'Only send 4 files; /tmp/q4; password="4"; echo "\\u0034"';
    const expected = redactor.text(text);
    for (let at = 0; at <= text.length; at += 1) {
      const safe = redactor
        .textBlockValues([text.slice(0, at), text.slice(at)])
        .join('');
      expect(safe).toBe(expected);
      expect(safe).toContain('Only send 4 files; /tmp/q4');
      expect(safe.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu)).toHaveLength(
        2,
      );
    }
  });
  test('an existing credential prefix cannot prevent learning the new whole field value', () => {
    for (const old of ['4', 'synthetic-old-secret']) {
      const redactor = new CredentialRedactor(`prefix-${old}`, [old]);
      const secret = `${old}-new-whole`;
      const clean = redactor.text(`password="${secret}"`);
      const echo = redactor.text(secret);
      expect(echo).toMatch(marker);
      expect(clean).toContain(echo);
      expect(redactor.text(`an unlabelled echo ${secret}`)).toContain(echo);
      expect(redactor.value({ password: secret })).toEqual({ password: echo });
    }
  });
  test('an issued marker plus an attacker suffix is one new explicit credential', () => {
    const redactor = new CredentialRedactor('marker-suffix', [
      'original-synthetic-secret',
    ]);
    const issued = redactor.text('original-synthetic-secret');
    const secret = `${issued}-synthetic-private-suffix`;
    const clean = redactor.text(`token=${secret}`);
    expect(clean).not.toContain('synthetic-private-suffix');
    const echo = redactor.text(secret);
    expect(clean).toContain(echo);
    expect(echo).not.toBe(issued);
  });
  test('known values equal to public credential field names do not hide later explicit credentials', () => {
    const redactor = new CredentialRedactor('keyword-role', [
      'password',
      'Authorization',
      'token',
    ]);
    const clean = redactor.text(
      'password=synthetic-named-password\nAuthorization: Bearer synthetic-named-auth\ntoken=synthetic-named-token',
    );
    for (const secret of [
      'synthetic-named-password',
      'synthetic-named-auth',
      'synthetic-named-token',
    ])
      expect(clean).not.toContain(secret);
  });
  test.each(['"', "'", '`'])(
    'an unterminated %s credential hides its full tail and keeps the prefix',
    (quote) => {
      const redactor = new CredentialRedactor('unterminated');
      const clean = redactor.text(
        `ordinary recipient@example.test\npassword=${quote}synthetic-open-secret\ncontinued-secret-tail`,
      );
      expect(clean).toContain('ordinary recipient@example.test');
      expect(clean).not.toContain('synthetic-open-secret');
      expect(clean).not.toContain('continued-secret-tail');
      expect(clean).toMatch(marker);
      const json = new CredentialRedactor('unterminated-json').text(
        '{"password":"synthetic-json-open-secret',
      );
      expect(json).not.toContain('synthetic-json-open-secret');
    },
  );
  test.each(['token', 'access_token', 'api_key'])(
    '%s query value stops before recipient/count while ordinary ampersand credentials remain whole',
    (field) => {
      const redactor = new CredentialRedactor('query');
      const clean = redactor.text(
        `curl 'https://service.test/upload?${field}=private-query-secret&recipient=ops@example.test&count=4#section'`,
      );
      expect(clean).not.toContain('private-query-secret');
      expect(clean).toContain('&recipient=ops@example.test&count=4#section');
      expect(clean).toMatch(marker);
      const other = redactor.text(
        'password="ordinary&ampersand-secret"; count=4',
      );
      expect(other).not.toContain('ampersand-secret');
      expect(other).toContain('; count=4');
      const unquoted = redactor.text('password=ordinary&unquoted-secret');
      expect(unquoted).not.toContain('unquoted-secret');
    },
  );
  test('shared references are revisited in sensitive field context, independently of property order', () => {
    for (const sensitiveFirst of [false, true]) {
      const shared = { value: 'synthetic-shared-secret' };
      const source = sensitiveFirst
        ? { password: shared, metadata: shared }
        : { metadata: shared, password: shared };
      const clean = new CredentialRedactor(
        `shared-${String(sensitiveFirst)}`,
      ).value(source);
      expect(JSON.stringify(clean)).not.toContain('synthetic-shared-secret');
      expect(clean).toMatchObject({
        password: { value: masked },
        metadata: { value: masked },
      });
      expect(source.password.value).toBe('synthetic-shared-secret');
    }
  });
  test('numeric authentication in nested provider errors is never a score exemption', () => {
    const source = {
      error: { authorization: 987654321 },
      scores: { authorization: 123456789 },
    };
    const redactor = new CredentialRedactor('nested-error');
    expect(redactor.value(source, true)).toMatchObject({
      error: { authorization: masked },
      scores: { authorization: masked },
    });
    const text = new CredentialRedactor('nested-error-text').text(
      JSON.stringify(source),
      true,
    );
    expect(text).not.toContain('987654321');
    expect(text).not.toContain('123456789');
    expect(
      new CredentialRedactor('real-chat').text(
        '{"risk":3,"authorization":8}',
        true,
      ),
    ).toBe('{"risk":3,"authorization":8}');
  });
  test('sparse arrays retain JSON-visible indices and reject unbounded declared lengths', () => {
    const source: unknown[] = [];
    source[1] = { password: 'synthetic-sparse-secret' };
    const clean = new CredentialRedactor('sparse').value(source);
    expect(clean).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(clean))).toEqual([
      null,
      { password: masked },
    ]);
    expect(0 in source).toBe(false);
    const tooLarge: unknown[] = [];
    tooLarge.length = 100_001;
    expect(() =>
      new CredentialRedactor('sparse-limit').value(tooLarge),
    ).toThrow();
  });
  test('transformed structured keys cannot silently overwrite another field', () => {
    const redactor = new CredentialRedactor('key-collision', [
      'synthetic-key-secret',
    ]);
    const issued = redactor.text('synthetic-key-secret');
    const source = { 'synthetic-key-secret': 'first', [issued]: 'second' };
    expect(() => redactor.value(source)).toThrow();
    expect(Object.keys(source)).toHaveLength(2);
  });
  test('sensitive material and schema maps reject the same transformed-key ambiguity', () => {
    for (const shape of ['sensitive', 'schema']) {
      const redactor = new CredentialRedactor(`collision-${shape}`, [
        'synthetic-map-secret',
      ]);
      const issued = redactor.text('synthetic-map-secret');
      const source = {
        'synthetic-map-secret': { type: 'string' },
        [issued]: { type: 'integer' },
      };
      expect(() =>
        shape === 'sensitive'
          ? redactor.sensitiveValue(source, 'password')
          : copyArgumentsSchema({ properties: source }, redactor),
      ).toThrow();
      expect(Object.keys(source)).toHaveLength(2);
    }
  });
});
