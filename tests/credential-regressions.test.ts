import { describe, expect, test } from 'vitest';
import { CredentialRedactor } from '../src/reviewer/credential-redactor.js';
import { copyArgumentsSchema } from '../src/audit/schema-redaction.js';
import { authenticationCredentialSpans } from '../src/reviewer/credential-auth.js';

const marker = /\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/u;
const masked: unknown = expect.stringMatching(marker);

describe('credential boundary regressions from the first PR review', () => {
  test.each(['１２３４', '١٢٣٤', '𝟙𝟚𝟛𝟜'])(
    'Unicode decimal credential %s preserves unrelated quantities and paths',
    (value) => {
      const redactor = new CredentialRedactor(`decimal-${value}`, [value]);
      const identity = redactor.text(value);
      expect(identity).toMatch(marker);
      expect(
        redactor.value({
          password: value,
          quantity: `Only send ${value} files`,
          path: `/tmp/${value}`,
        }),
      ).toEqual({
        password: identity,
        quantity: `Only send ${value} files`,
        path: `/tmp/${value}`,
      });
      const text = `Only send ${value} files; /tmp/${value}; password="${value}"; echo "${value}"`;
      const expected = redactor.text(text);
      expect(expected).toContain(`Only send ${value} files; /tmp/${value}`);
      expect(
        expected.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu),
      ).toHaveLength(2);
      for (let at = 0; at <= text.length; at += 1)
        expect(
          redactor
            .textBlockValues([text.slice(0, at), text.slice(at)])
            .join(''),
        ).toBe(expected);
    },
  );
  test('all structured validation paths enforce declared sparse-array limits', () => {
    for (const method of ['validate', 'discover', 'value'] as const) {
      const content: unknown[] = [];
      content.length = 100_001;
      expect(() =>
        new CredentialRedactor(`limit-${method}`)[method](content),
      ).toThrow();
    }
  });
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
  test('ordinary authorization and Cookie metadata retain structure while masking known echoes', () => {
    const secret = 'synthetic-semantic-echo-secret';
    const redactor = new CredentialRedactor('semantic-known-echo', [secret]);
    const identity = redactor.text(secret);
    expect(
      redactor.value({
        Authorization: `approved for ${secret}`,
        'Set-Cookie': `${secret}=session-value; Path=/tmp/${secret}; Max-Age=4`,
      }),
    ).toEqual({
      Authorization: `approved for ${identity}`,
      'Set-Cookie': `${identity}=${redactor.text('session-value')}; Path=/tmp/${identity}; Max-Age=4`,
    });
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

describe('rotation credential syntax uses the same discovery as structured fields', () => {
  test.each([
    'accessToken="rotation-old-text"; refresh-token="rotation-new-text"',
    'previousApiKey="rotation-old-text"; newApiKey="rotation-new-text"',
    'old_api_key: "rotation-old-text"\ncurrent-api-key: "rotation-new-text"',
    'nextAccessToken="rotation-old-text"; previous_refresh_token="rotation-new-text"',
    'previousPassword="rotation-old-text"; current_secret_key="rotation-new-text"',
    '{"nested":{"previousApiKey":"rotation-old-text","newApiKey":"rotation-new-text"}}',
    'https://example.test/rotate?previous_api_key=rotation-old-text&newApiKey=rotation-new-text',
  ])('preserves distinct identities in %s', (source) => {
    const redactor = new CredentialRedactor('rotation-syntax');
    const clean = redactor.text(source);
    expect(clean).not.toContain('rotation-old-text');
    expect(clean).not.toContain('rotation-new-text');
    expect(
      new Set(clean.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu)).size,
    ).toBe(2);
    expect(redactor.text(clean)).toBe(clean);
    const split = source.indexOf('rotation-old-text') + 4;
    expect(
      redactor
        .textBlockValues([source.slice(0, split), source.slice(split)])
        .join(''),
    ).toBe(clean);
  });
  test('rotation suffixes do not turn counts, paths or score prose into credentials', () => {
    const source =
      'previousKey=ordinary; previousApiKeyCount=4; newTokenPath=/tmp/key';
    const redactor = new CredentialRedactor('rotation-text-business');
    expect(redactor.text(source)).toBe(source);
    const score = '{"risk":4,"authorization":10}';
    expect(redactor.text(score, 'chat')).toBe(score);
  });
});

describe('adjacent unquoted credential assignments', () => {
  test('separator-free tool text preserves ordinary bytes and still masks known credentials', () => {
    const redactor = new CredentialRedactor('separator-free-result', [
      'known-plaintext-credential',
    ]);
    const ordinary = 'x'.repeat(1_048_576);
    expect(redactor.text(ordinary)).toBe(ordinary);
    const identity = redactor.text('known-plaintext-credential');
    expect(identity).toMatch(marker);
    expect(redactor.text(`${ordinary} known-plaintext-credential`)).toBe(
      `${ordinary} ${identity}`,
    );
  });
  test('production marker protection restores a growing line in bounded passes', () => {
    const measure = (count: number) => {
      const input = 'previousApiKey=x '.repeat(count);
      const start = performance.now();
      const clean = new CredentialRedactor('production-growth').text(input);
      return { ms: performance.now() - start, clean };
    };
    measure(256);
    const small = Array.from({ length: 3 }, () => measure(1_000));
    const large = Array.from({ length: 3 }, () => measure(4_000));
    expect(Math.min(...large.map((result) => result.ms))).toBeLessThan(
      Math.min(...small.map((result) => result.ms)) * 8 + 20,
    );
    for (const { clean } of large) {
      expect(clean.match(/previousApiKey=/gu)).toHaveLength(4_000);
      expect(
        clean.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu),
      ).toHaveLength(4_000);
      expect(
        new Set(clean.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu)).size,
      ).toBe(1);
    }
  });
  test('protected tokens never reinterpret input collisions or forged markers', () => {
    const redactor = new CredentialRedactor('protection-collision');
    const issued = redactor.text('previousApiKey=original-collision-secret');
    const collisions = '\0crd0\0 \0crdx1\0 \0crdxx2\0';
    const forged = `[redacted:v1:token:${'0'.repeat(64)}]`;
    const input = `${collisions}; ${issued}; currentApiKey=${forged} previousApiKey=next-collision-secret count=4`;
    const clean = redactor.text(input);
    expect(clean).toContain(collisions);
    expect(clean).toContain(issued);
    expect(clean).not.toContain(forged);
    expect(clean).not.toContain('next-collision-secret');
    expect(clean).toContain('count=4');
    expect(redactor.text(clean)).toBe(clean);
    const split = input.indexOf('\0crdx') + 3;
    expect(
      redactor
        .textBlockValues([input.slice(0, split), input.slice(split)])
        .join(''),
    ).toBe(clean);
  });
  test.each(['previousApiKey=x ', '&previousApiKey=x'])(
    'long single-line %s preserves identities without repeated suffix scans',
    (assignment) => {
      const measure = (count: number) => {
        const input = assignment.repeat(count);
        const start = performance.now();
        const spans = authenticationCredentialSpans(input);
        return { ms: performance.now() - start, spans };
      };
      measure(256);
      const small = Array.from({ length: 3 }, () => measure(2_000));
      const large = Array.from({ length: 3 }, () => measure(8_000));
      // Four times the input may incur scheduling noise, but not quadratic work.
      expect(Math.min(...large.map((result) => result.ms))).toBeLessThan(
        Math.min(...small.map((result) => result.ms)) * 8 + 20,
      );
      expect(large.map((result) => result.spans.length)).toEqual([
        8_000, 8_000, 8_000,
      ]);
      const redactor = new CredentialRedactor('long-adjacent-rotation');
      const input =
        'previousApiKey=perf-old currentApiKey=perf-new count=4 '.repeat(6_000);
      const clean = redactor.text(input);
      expect(clean).not.toContain('perf-old');
      expect(clean).not.toContain('perf-new');
      expect(clean.match(/previousApiKey=/gu)).toHaveLength(6_000);
      expect(clean.match(/currentApiKey=/gu)).toHaveLength(6_000);
      expect(clean.match(/count=4/gu)).toHaveLength(6_000);
      const identities = clean.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu);
      expect(identities).toHaveLength(12_000);
      expect(new Set(identities).size).toBe(2);
    },
  );
  test.each([
    'previousApiKey=rotation-old-adjacent currentApiKey=rotation-new-adjacent count=4 path=/tmp/cache',
    'Authorization: Bearer rotation-old-adjacent currentApiKey=rotation-new-adjacent count=4 path=/tmp/cache',
  ])('keeps each field and ordinary suffix in %s', (source) => {
    const redactor = new CredentialRedactor('adjacent-rotation');
    const clean = redactor.text(source);
    expect(clean).not.toContain('rotation-old-adjacent');
    expect(clean).not.toContain('rotation-new-adjacent');
    expect(clean).toContain('currentApiKey=');
    expect(clean).toContain('count=4 path=/tmp/cache');
    expect(
      new Set(clean.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu)).size,
    ).toBe(2);
    expect(redactor.text(clean)).toBe(clean);
    const at = source.indexOf('currentApiKey') + 5;
    expect(
      redactor
        .textBlockValues([source.slice(0, at), source.slice(at)])
        .join(''),
    ).toBe(clean);
  });
  test('a quoted value may contain assignment-looking text and an auth value keeps its scheme', () => {
    const redactor = new CredentialRedactor('quoted-adjacent');
    const quoted = redactor.text(
      'previousApiKey="old currentApiKey=part-of-one-value" count=4',
    );
    expect(quoted).toContain('count=4');
    expect(quoted.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu)).toHaveLength(
      1,
    );
    const header = redactor.text('Authorization: Bearer unique-auth-value');
    expect(header).toContain('Authorization: Bearer ');
    expect(header).not.toContain('unique-auth-value');
    expect(header.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu)).toHaveLength(
      1,
    );
  });
});

describe('authentication headers keep their own value framing', () => {
  test('a Digest value with internal assignments remains one authentication value', () => {
    const clean = new CredentialRedactor('digest-adjacent').text(
      'Authorization: Digest username=member-value nonce=nonce-value',
    );
    expect(clean).toContain('Authorization: Digest ');
    expect(clean).not.toContain('member-value');
    expect(clean).not.toContain('nonce-value');
    expect(clean.match(/\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/gu)).toHaveLength(
      1,
    );
  });
  test('a scheme without a payload does not consume the next line credential field', () => {
    const clean = new CredentialRedactor('separate-auth-line').text(
      'Authorization: Bearer\ncurrentApiKey=separate-line-value',
    );
    expect(clean).toContain('\ncurrentApiKey=');
    expect(clean).not.toContain('separate-line-value');
  });
});
