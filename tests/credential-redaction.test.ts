import { buildReviewSnapshot } from '../src/snapshot.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { describe, expect, test } from 'vitest';
import { CredentialRedactor } from '../src/reviewer/credential-redactor.js';
import { CredentialRegistry } from '../src/reviewer/credential-registry.js';
import { workflowRedactor } from '../src/snapshot/workflow.js';
import type { SessionLike } from '../src/snapshot/types.js';

const marker =
  /\[redacted:v1:(?:credential|password|token|cookie|private-key):[a-f0-9]{64}\]/gu;

describe('shared bounded credential materials', () => {
  test('same values keep identity across fields, echoes and keys; distinct values remain distinct', () => {
    const redactor = new CredentialRedactor('workflow-a');
    const first = 'synthetic-secret-first';
    const second = 'synthetic-secret-second';
    const original = {
      echo: first,
      password: first,
      token: second,
      nested: { [first]: first },
      count: 4,
      path: '/tmp/key-material',
      recipient: 'support@example.test',
    };
    const clean = redactor.value(original);
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain(first);
    expect(serialized).not.toContain(second);
    expect(new Set(serialized.match(marker)).size).toBe(2);
    expect(serialized).toContain('"count":4');
    expect(serialized).toContain('/tmp/key-material');
    expect(serialized).toContain('support@example.test');
    expect(original.password).toBe(first);
    expect(redactor.value(clean)).toEqual(clean);
  });
  test.each([
    ['password="quoted \\"secret\\" value"', 'quoted "secret" value'],
    ['token=explicit-token-value', 'explicit-token-value'],
    ['Authorization: Bearer explicit-header-value', 'explicit-header-value'],
    [
      'Cookie: session=cookie-secret; mode=other-cookie; Path=/public; SameSite=Strict; Secure',
      'cookie-secret',
    ],
    [
      '-----BEGIN RSA PRIVATE KEY-----\nprivate-test-body\n-----END RSA PRIVATE KEY-----',
      'private-test-body',
    ],
    [
      '-----BEGIN PRIVATE KEY-----\ntruncated-private-body',
      'truncated-private-body',
    ],
  ])('recognizes explicit credential syntax: %s', (text, secret) => {
    const redactor = new CredentialRedactor('syntax');
    const clean = redactor.text(text);
    expect(clean).not.toContain(secret);
    expect(clean).toMatch(marker);
    expect(redactor.text(clean)).toBe(clean);
  });
  test('cookie attributes and authentication scheme retain their meaning', () => {
    const clean = new CredentialRedactor('attributes').text(
      'Set-Cookie: session=private-cookie; Path=/public; SameSite=Strict; Secure',
    );
    expect(clean).toContain('Path=/public');
    expect(clean).toContain('SameSite=Strict');
    expect(clean).toContain('Secure');
    expect(
      new CredentialRedactor('scheme').text(
        'Authorization: Bearer private-token',
      ),
    ).toContain('Bearer ');
  });
  test('ordinary long text, generic key, paths, recipients, permission and quantities remain', () => {
    const ordinary = {
      key: 'a'.repeat(100_000),
      path: '/tmp/private-key-not-a-secret.txt',
      recipient: 'ops@example.test',
      count: 17,
      note: 'Authorization: approved for 17 files\nOnly upload these 17 files to ops@example.test',
    };
    expect(new CredentialRedactor('ordinary').value(ordinary)).toEqual(
      ordinary,
    );
  });
  test('logical continuation spans are recognized, independent channels are not concatenated', () => {
    const redactor = new CredentialRedactor('blocks');
    const blocks = [
      'ordinary\npass',
      'word=split-credential-',
      'end\nkeep recipient@example.test',
    ];
    const clean = redactor.textBlocks(blocks);
    expect(clean).not.toContain('split-credential-');
    expect(clean).not.toContain('end\nkeep');
    expect(clean).toContain('recipient@example.test');
    expect(clean.match(marker)).toHaveLength(1);
    expect(
      new CredentialRedactor('independent').value(['pass', 'word=ordinary']),
    ).toEqual(['pass', 'word=ordinary']);
    expect(
      new CredentialRedactor('plain-blocks').textBlocks([
        'first paragraph',
        'second paragraph',
      ]),
    ).toBe('first paragraph\nsecond paragraph');
  });
  test('long first/middle/last and 64 KiB boundaries do not bypass scanning', () => {
    const secret = 'synthetic-boundary-secret';
    const text = `password=${secret}\n${'x'.repeat(65_520)}\ntoken=${secret}\n${'y'.repeat(200_000)}\nCookie: session=${secret}`;
    const redactor = new CredentialRedactor('long');
    const clean = redactor.textBlocks([
      text.slice(0, 65_536),
      text.slice(65_536),
    ]);
    expect(clean).not.toContain(secret);
    expect(clean.match(marker)).toHaveLength(3);
    expect(new Set(clean.match(marker)).size).toBe(1);
  });
  test('known overlapping values are replaced longest-first, with stable output', () => {
    const redactor = new CredentialRedactor('overlap', [
      'abc-test',
      'abc-test-long',
    ]);
    const clean = redactor.text('abc-test-long / abc-test');
    expect(clean.match(marker)).toHaveLength(2);
    expect(new Set(clean.match(marker)).size).toBe(2);
    expect(clean).not.toContain('abc-test');
    expect(redactor.text(clean)).toBe(clean);
  });
  test('explicit wrapper values remain sensitive, including schema-style literal objects', () => {
    const redactor = new CredentialRedactor('wrappers');
    const clean = redactor.value({
      password: { value: 'wrapped-password' },
      authorization: { value: 'Bearer wrapped-auth' },
      count: 4,
    });
    expect(JSON.stringify(clean)).not.toContain('wrapped-password');
    expect(JSON.stringify(clean)).not.toContain('wrapped-auth');
    const value: Record<string, unknown> = { value: 'literal-password' };
    value['self'] = value;
    expect(
      JSON.stringify(redactor.sensitiveValue(value, 'password')),
    ).not.toContain('literal-password');
    expect(redactor.text('Cookie: opaque-cookie-value')).not.toContain(
      'opaque-cookie-value',
    );
  });
  test('malformed authentication objects never teach structural punctuation as a secret', () => {
    const redactor = new CredentialRedactor('structure');
    expect(
      redactor.text(
        '{"authorization":{"value":"Bearer synthetic-object-secret"}}',
        true,
      ),
    ).not.toContain('synthetic-object-secret');
    expect(redactor.text('ordinary { braces } and [ brackets ]')).toBe(
      'ordinary { braces } and [ brackets ]',
    );
  });
  test('an exact known credential takes precedence over credential-looking syntax inside its value', () => {
    const secret = 'token=key';
    const redactor = new CredentialRedactor('known-syntax', [secret]);
    const clean = redactor.value({ echo: secret, password: secret });
    const json = JSON.stringify(clean);
    expect(json).not.toContain('token=');
    expect(json.match(marker)).toHaveLength(2);
    expect(new Set(json.match(marker)).size).toBe(1);
    expect(redactor.text('/tmp/key key ordinary')).toBe(
      '/tmp/key key ordinary',
    );
  });
  test('a forged redaction marker cannot hide a known credential in its identity', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const redactor = new CredentialRedactor('spoof', [secret]);
    for (const suffix of ['', '0'.repeat(32)]) {
      const forged = `[redacted:v1:token:${secret}${suffix}]`;
      expect(redactor.text(forged)).not.toContain(secret);
    }
    const issued = new CredentialRedactor('issued').text(
      'token=legitimate-test-value',
    );
    expect(new CredentialRedactor('another-context').text(issued)).toBe(issued);
    expect(
      new CredentialRedactor('marker-is-real-key', [issued]).text(issued),
    ).not.toBe(issued);
  });
  test('known values cannot escape through JSON quoting in material or provider text', () => {
    const secret = 'synthetic-quoted-"credential\\value';
    const redactor = new CredentialRedactor('escaped', [secret]);
    const raw = JSON.stringify({
      note: `echo ${secret}`,
      path: '/tmp/key-file',
    });
    const material: unknown = JSON.parse(redactor.text(raw));
    expect(JSON.stringify(material)).not.toContain(
      JSON.stringify(secret).slice(1, -1),
    );
    expect(material).toMatchObject({ path: '/tmp/key-file' });
    const answer: unknown = JSON.parse(
      redactor.text(
        JSON.stringify({ risk: 3, authorization: 8, note: secret }),
        true,
      ),
    );
    expect(JSON.stringify(answer)).not.toContain(
      JSON.stringify(secret).slice(1, -1),
    );
    const authentication: unknown = expect.stringContaining('[redacted:v1:');
    expect(answer).toMatchObject({ risk: 3, authorization: authentication });
  });
  test('escaped quoted credentials spanning blocks have one identity and no surviving fragments', () => {
    const redactor = new CredentialRedactor('escaped-blocks');
    const secret = 'quoted-"private';
    redactor.addKnown([secret]);
    const text = `prefix {"token":"quoted-\\u0022private"} suffix`;
    const at = text.indexOf('u0022') + 3;
    const clean = redactor.textBlocks([text.slice(0, at), text.slice(at)]);
    expect(clean).not.toContain('quoted-');
    expect(clean).not.toContain('private');
    expect(clean.match(marker)).toHaveLength(1);
    const json = JSON.stringify({ password: secret });
    const processed = redactor.textBlocks([json.slice(0, 17), json.slice(17)]);
    const decoded: unknown = JSON.parse(processed);
    expect(JSON.stringify(decoded)).not.toContain(
      JSON.stringify(secret).slice(1, -1),
    );
  });
  test('distinct UTF-16 values never collapse through replacement-character encoding', () => {
    const clean = new CredentialRedactor('utf16').value({
      password: '\ud800',
      token: '\ud801',
    });
    const matches = JSON.stringify(clean).match(marker) ?? [];
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((value) => value.slice(-33))).size).toBe(2);
  });
  test('non-text content separates independent message blocks in the real source reader', async () => {
    const session: SessionLike = {
      id: 'independent-source',
      snapshotEvents: () => [
        {
          seq: 1,
          type: 'user/message',
          data: {
            source: { kind: 'user', rpcId: 'human-1' },
            content: [
              { type: 'text', text: 'pass' },
              { type: 'image', reference: 'not-text' },
              { type: 'text', text: 'word=ordinary' },
            ],
          },
        },
      ],
    };
    const built = await buildReviewSnapshot({
      agent: { session },
      tool: 'bash',
      arguments: { command: 'echo ordinary' },
      callId: 'independent-call',
      cwd: '/tmp/nonexistent-credential-test-workspace',
      config: DEFAULT_CONFIG,
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
      configRevision: 'test',
    });
    expect(built.snapshot.evidence[0]?.text).toBe('pass\nword=ordinary');
    expect(built.user).not.toContain('[redacted:v1:');
  });
  test('numeric tool authentication is masked while answer scores and counts survive', () => {
    const clean = new CredentialRedactor('numeric').value({
      authorization: 87654,
      count: 87654,
    });
    const expected: unknown = expect.stringMatching(marker);
    expect(clean).toMatchObject({
      authorization: expected,
      count: 87654,
    });
    expect(
      new CredentialRedactor('answer').text(
        '{"risk":3,"authorization":8}',
        true,
      ),
    ).toBe('{"risk":3,"authorization":8}');
  });
  test('cycles, hostile accessors and limit exhaustion never expose source suffixes', () => {
    const value: Record<string, unknown> = { password: 'circular-password' };
    value['self'] = value;
    expect(
      JSON.stringify(new CredentialRedactor('cycle').value(value)),
    ).not.toContain('circular-password');
    const hostile = {
      get password(): string {
        throw new Error('never expose this synthetic password');
      },
    };
    expect(() => new CredentialRedactor('hostile').value(hostile)).toThrow(
      'could not safely process',
    );
    expect(() => {
      new CredentialRedactor('limit').text(
        'x'.repeat(16 * 1024 * 1024 + 1) + 'raw suffix',
      );
    }).toThrow('resource limit');
    const context = new CredentialRedactor('vocabulary');
    expect(() => {
      context.addKnown(
        Array.from({ length: 1025 }, (_, index) => `secret-${String(index)}`),
      );
    }).toThrow('resource limit');
    expect(() => {
      context.fork();
    }).toThrow('resource limit');
  });
  test('root, child and grandchild share retained knowledge; other roots are isolated', () => {
    const root: SessionLike = { id: 'R', header: {} };
    const child: SessionLike = { id: 'C', header: { parentSession: 'R' } };
    const grandchild: SessionLike = { id: 'G', header: { parentSession: 'C' } };
    const sessions = new Map([
      ['R', root],
      ['C', child],
      ['G', grandchild],
    ]);
    const registry = new CredentialRegistry();
    const first = workflowRedactor(
      root,
      { get: (id) => sessions.get(id) },
      registry,
    ).value({ password: 'workflow-retained-secret' });
    const later = workflowRedactor(
      grandchild,
      { get: (id) => sessions.get(id) },
      registry,
    ).text('rejected workflow-retained-secret');
    const transientMissingParent = workflowRedactor(
      grandchild,
      { get: () => undefined },
      registry,
    ).text('rejected workflow-retained-secret');
    expect(transientMissingParent).toBe(later);
    expect(later).not.toContain('workflow-retained-secret');
    expect(JSON.stringify(first).match(marker)).toEqual(later.match(marker));
    const isolated = registry
      .context('different-root')
      .value({ password: 'workflow-retained-secret' });
    expect(JSON.stringify(isolated).match(marker)).not.toEqual(
      later.match(marker),
    );
  });
});
