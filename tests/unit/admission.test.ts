import { describe, expect, test } from 'vitest';

import {
  ADMISSION_RECORD_TYPE,
  admissionRecordOf,
  admissionRevision,
  boundaryKnobs,
  foldAdmission,
  parentChain,
  resolveScope,
  toAdmission,
} from '../../src/host/admission.js';
import type { FoldedAdmission, ScopeLookup } from '../../src/host/admission.js';
import type { SessionEventLike } from '../../src/snapshot.js';

/**
 * Admission folding is the security-relevant pure step: a wrong answer here
 * either takes over a session the user never enabled or leaves a widened
 * session ungated. These cases pin both directions.
 */

function record(
  seq: number,
  data: Partial<{
    version: number;
    sessionId: string;
    rootSessionId: string;
    enabled: boolean;
    boundary: string;
    at: number;
  }> = {},
  type = ADMISSION_RECORD_TYPE,
): SessionEventLike {
  return {
    seq,
    time: 1_000 + seq,
    type,
    ignorable: true,
    data: {
      version: 1,
      sessionId: 's1',
      rootSessionId: 's1',
      enabled: true,
      boundary: 'guarded',
      at: 1_000 + seq,
      ...data,
    },
  };
}

function event(seq: number, type: string, data: unknown): SessionEventLike {
  return { seq, type, data };
}

describe('admission records', () => {
  test('a valid record is read and a foreign one is not', () => {
    expect(admissionRecordOf(record(1))).toEqual({
      enabled: true,
      boundary: 'guarded',
      seq: 1,
      at: 1_001,
      sessionId: 's1',
    });
    // A different plugin's record is not this plugin's state.
    expect(
      admissionRecordOf(record(2, {}, 'plugin:other/admission')),
    ).toBeNull();
    // Without the ignorable marker the cold reader would refuse the log, so
    // such an event is not a record at all.
    const { ignorable: _ignorable, ...unmarked } = record(3);
    expect(admissionRecordOf(unmarked)).toBeNull();
  });

  test('malformed payloads are rejected instead of defaulted', () => {
    for (const data of [
      { version: 2 },
      { version: 1, enabled: 'yes' },
      { version: 1, enabled: true, boundary: 'open' },
      { version: 1, enabled: true, boundary: 'guarded', at: 'now' },
      {},
    ]) {
      const eventRecord: SessionEventLike = {
        seq: 4,
        type: ADMISSION_RECORD_TYPE,
        ignorable: true,
        data,
      };
      expect(admissionRecordOf(eventRecord)).toBeNull();
    }
  });

  test('the last valid record wins and earlier ones are ignored', () => {
    const folded = foldAdmission([
      record(1, { enabled: true }),
      event(2, 'user/message', {}),
      record(3, { enabled: false }),
      record(4, { enabled: true, boundary: 'trusted' }),
    ]);
    expect(folded).toMatchObject({
      enabled: true,
      boundary: 'trusted',
      seq: 4,
    });
  });

  test('no record means no admission at all', () => {
    expect(foldAdmission([event(1, 'user/message', {})])).toBeNull();
  });
});

describe('fork seeds and ownership', () => {
  test("a copied parent record is not the child session's switch", () => {
    // A fork seed copies the parent's log prefix verbatim; the record still
    // names the parent, so the child must not inherit its admission.
    const inherited = [
      record(1, { sessionId: 'parent', rootSessionId: 'parent' }),
    ];
    expect(foldAdmission(inherited, 'parent')).toMatchObject({ enabled: true });
    expect(foldAdmission(inherited, 'child')).toBeNull();
    // A record without an owner (written before the field existed) counts for
    // the session reading its own log.
    const anonymous: SessionEventLike = {
      seq: 2,
      type: ADMISSION_RECORD_TYPE,
      ignorable: true,
      data: { version: 1, enabled: true, boundary: 'guarded', at: 1 },
    };
    expect(foldAdmission([anonymous], 'child')).toMatchObject({
      enabled: true,
    });
  });
});

describe('native /permission exit', () => {
  test('a completed successful command after the record disables admission', () => {
    const folded = foldAdmission([
      record(1, { enabled: true }),
      event(2, 'command/run', {
        commandId: 'c1',
        name: 'permission',
        args: ' workspace-write',
      }),
      event(3, 'command/done', { commandId: 'c1', kind: 'success' }),
    ]);
    expect(folded).toMatchObject({ enabled: false, seq: 3 });
    // The boundary the session was admitted at is retained as a fact.
    expect(folded?.boundary).toBe('guarded');
  });

  test('a failed, bare or unrelated command proves nothing', () => {
    const base = record(1, { enabled: true });
    const failed = foldAdmission([
      base,
      event(2, 'command/run', {
        commandId: 'c1',
        name: 'permission',
        args: ' unknown',
      }),
      event(3, 'command/done', { commandId: 'c1', kind: 'error' }),
    ]);
    expect(failed).toMatchObject({ enabled: true, seq: 1 });
    const bare = foldAdmission([
      base,
      event(2, 'command/run', {
        commandId: 'c2',
        name: 'permission',
        args: '',
      }),
      event(3, 'command/done', { commandId: 'c2', kind: 'success' }),
    ]);
    expect(bare).toMatchObject({ enabled: true, seq: 1 });
    const other = foldAdmission([
      base,
      event(2, 'command/run', {
        commandId: 'c3',
        name: 'arbiter',
        args: ' status',
      }),
      event(3, 'command/done', { commandId: 'c3', kind: 'success' }),
    ]);
    expect(other).toMatchObject({ enabled: true, seq: 1 });
  });

  test('a command older than a later enable does not undo it', () => {
    const folded = foldAdmission([
      event(1, 'command/run', {
        commandId: 'c1',
        name: 'permission',
        args: ' read-only',
      }),
      event(2, 'command/done', { commandId: 'c1', kind: 'success' }),
      record(3, { enabled: true }),
    ]);
    expect(folded).toMatchObject({ enabled: true, seq: 3 });
  });

  test('a done without its run is ignored rather than guessed', () => {
    const folded = foldAdmission([
      record(1, { enabled: true }),
      event(2, 'command/done', { commandId: 'missing', kind: 'success' }),
    ]);
    expect(folded).toMatchObject({ enabled: true, seq: 1 });
  });
});

describe('boundary mapping', () => {
  test('trusted widens the sandbox and guarded restores it', () => {
    expect(boundaryKnobs('trusted')).toEqual({
      sandbox: 'danger-full-access',
      approval: 'ask',
    });
    expect(boundaryKnobs('guarded')).toEqual({
      sandbox: 'workspace-write',
      approval: 'ask',
    });
  });

  test('the admission revision changes with state but not with reads', () => {
    const folded: FoldedAdmission = {
      enabled: true,
      boundary: 'guarded',
      seq: 4,
      at: 1_004,
      sessionId: 's1',
    };
    const first = admissionRevision('s1', folded);
    expect(admissionRevision('s1', folded)).toBe(first);
    expect(admissionRevision('s2', folded)).not.toBe(first);
    expect(admissionRevision('s1', { ...folded, enabled: false })).not.toBe(
      first,
    );
    expect(toAdmission('s1', 's1', folded).admissionRevision).toBe(first);
  });
});

describe('parent chain', () => {
  test('walks to the root and reports an unresolvable parent', () => {
    const parents = new Map<string, string | undefined>([
      ['child', 'parent'],
      ['parent', 'root'],
    ]);
    expect(parentChain('child', (id) => parents.get(id))).toEqual({
      ids: ['child', 'parent', 'root'],
      unresolved: null,
      cycle: false,
    });
    // A parent link that keeps pointing at itself is a cycle, not a root.
    expect(parentChain('orphan', () => 'gone')).toEqual({
      ids: ['orphan', 'gone'],
      unresolved: 'gone',
      cycle: true,
    });
  });

  test('a cycle is reported instead of looping or guessing a root', () => {
    const parents = new Map<string, string | undefined>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    const chain = parentChain('a', (id) => parents.get(id));
    expect(chain.cycle).toBe(true);
    expect(chain.ids.length).toBeLessThanOrEqual(17);
  });
});

describe('scope resolution', () => {
  function lookup(options: {
    readonly admissions: Readonly<Record<string, FoldedAdmission | null>>;
    readonly parents?: Readonly<Record<string, string>>;
    readonly known?: readonly string[];
  }): ScopeLookup {
    return {
      admissionOf: (id) => options.admissions[id] ?? null,
      parentOf: (id) => options.parents?.[id],
      known: (id) => (options.known ?? []).includes(id),
    };
  }

  const enabled: FoldedAdmission = {
    enabled: true,
    boundary: 'guarded',
    seq: 1,
    at: 1,
    sessionId: 'main',
  };

  test('an enabled main session is managed by its own record', () => {
    const scope = resolveScope(
      'main',
      lookup({ admissions: { main: enabled }, known: ['main'] }),
    );
    expect(scope).toMatchObject({ managed: true, reason: 'session-enabled' });
    expect(scope.admission?.sessionId).toBe('main');
  });

  test('no record is not an admission, however the host is configured', () => {
    const scope = resolveScope(
      'main',
      lookup({ admissions: {}, known: ['main'] }),
    );
    expect(scope).toMatchObject({ managed: false, reason: 'no-admission' });
  });

  test('an explicit disable on the session wins over an enabled ancestor', () => {
    const scope = resolveScope(
      'child',
      lookup({
        admissions: { child: { ...enabled, enabled: false }, main: enabled },
        parents: { child: 'main' },
        known: ['child', 'main'],
      }),
    );
    expect(scope).toMatchObject({ managed: false, reason: 'session-disabled' });
  });

  test('a subagent follows an enabled parent and a deeper ancestor', () => {
    const direct = resolveScope(
      'child',
      lookup({
        admissions: { main: enabled },
        parents: { child: 'main' },
        known: ['child', 'main'],
      }),
    );
    expect(direct).toMatchObject({
      managed: true,
      reason: 'parent-session-enabled',
    });
    expect(direct.admission?.sessionId).toBe('main');

    const deep = resolveScope(
      'grandchild',
      lookup({
        admissions: { main: enabled },
        parents: { grandchild: 'child', child: 'main' },
        known: ['grandchild', 'child', 'main'],
      }),
    );
    expect(deep.managed).toBe(true);
  });

  test('a subagent under a disabled parent is not managed', () => {
    const scope = resolveScope(
      'child',
      lookup({
        admissions: { main: { ...enabled, enabled: false } },
        parents: { child: 'main' },
        known: ['child', 'main'],
      }),
    );
    expect(scope).toMatchObject({
      managed: false,
      reason: 'parent-not-admitted',
    });
  });

  test('an unresolvable or cyclic parent never inherits admission', () => {
    const missing = resolveScope(
      'child',
      lookup({
        admissions: { main: enabled },
        parents: { child: 'gone' },
        known: ['child', 'main'],
      }),
    );
    expect(missing).toMatchObject({
      managed: false,
      reason: 'parent-unresolved',
      unresolvedParent: 'gone',
    });

    const cycle = resolveScope(
      'a',
      lookup({
        admissions: {},
        parents: { a: 'b', b: 'a' },
        known: ['a', 'b'],
      }),
    );
    expect(cycle).toMatchObject({ managed: false, reason: 'parent-cycle' });
  });

  test('an unknown session is never admitted', () => {
    const scope = resolveScope('ghost', lookup({ admissions: {} }));
    expect(scope).toMatchObject({
      managed: false,
      reason: 'parent-unresolved',
    });
  });
});

describe('commandless native preset exit', () => {
  test('a preset with no command open is a durable exit', () => {
    // Another surface (a picker) selected read-only; the plugin's own deferred
    // record can be lost, and the fold must still reproduce the exit.
    const events: SessionEventLike[] = [
      record(1, { enabled: true, boundary: 'guarded' }),
      { seq: 2, type: 'permission/preset', data: { preset: 'read-only' } },
    ];
    expect(foldAdmission(events, 's1')).toMatchObject({
      enabled: false,
      seq: 2,
      sessionId: 's1',
    });
  });

  test('a preset written inside a command is not an exit by itself', () => {
    const events: SessionEventLike[] = [
      record(1, { enabled: true, boundary: 'guarded' }),
      {
        seq: 2,
        type: 'command/run',
        data: { commandId: 'cmd-1', name: 'permission', args: ' read-only' },
      },
      { seq: 3, type: 'permission/preset', data: { preset: 'read-only' } },
    ];
    // Still open: the preset is the handler's partial write, not an exit.
    expect(foldAdmission(events, 's1')).toMatchObject({ enabled: true });
    // A failed settlement leaves admission exactly as it was.
    expect(
      foldAdmission(
        [
          ...events,
          {
            seq: 4,
            type: 'command/done',
            data: { commandId: 'cmd-1', kind: 'error', text: 'boom' },
          },
        ],
        's1',
      ),
    ).toMatchObject({ enabled: true });
    // A successful settlement is the exit.
    expect(
      foldAdmission(
        [
          ...events,
          {
            seq: 4,
            type: 'command/done',
            data: { commandId: 'cmd-1', kind: 'success' },
          },
        ],
        's1',
      ),
    ).toMatchObject({ enabled: false });
  });

  test('a later enable is not undone by an older commandless preset', () => {
    const events: SessionEventLike[] = [
      record(1, { enabled: true, boundary: 'guarded' }),
      { seq: 2, type: 'permission/preset', data: { preset: 'read-only' } },
      record(3, { enabled: true, boundary: 'guarded' }),
    ];
    expect(foldAdmission(events, 's1')).toMatchObject({
      enabled: true,
      seq: 3,
    });
  });
});
