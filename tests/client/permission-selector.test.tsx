import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { PermissionSelector } from '../../src/client/components/permission-selector.js';
import type { HostBridge } from '../../src/client/view-types.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

const SESSION = 'session-1';

interface AdmissionBody {
  readonly ok: boolean;
  readonly revision: string;
  readonly admission: Record<string, unknown>;
}

function admission(overrides: Record<string, unknown> = {}): AdmissionBody {
  return {
    ok: true,
    revision: 'revision-1',
    admission: {
      sessionId: SESSION,
      rootSessionId: SESSION,
      enabled: false,
      boundary: 'guarded',
      revision: 'revision-1',
      admissionRevision: null,
      seq: null,
      at: null,
      reason: 'no-admission',
      managed: false,
      ...overrides,
    },
  };
}

function bridge(overrides: Partial<HostBridge> = {}): HostBridge {
  return {
    available: () => true,
    hostPreset: () => ({ currentValue: 'workspace-write' }),
    observe: () => () => undefined,
    catalog: () =>
      Promise.resolve([
        { value: 'read-only', name: '只读' },
        { value: 'workspace-write', name: '工作区内修改' },
        { value: 'danger-full-access', name: '完全权限' },
        { value: 'auto', name: '自动审查' },
        { value: 'custom', name: '自定义' },
      ]),
    selectPreset: () => Promise.resolve(true),
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('arbiter permission selector', () => {
  test('shows the state the server confirmed, not the one it was asked for', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          admission({ enabled: true, reason: 'session-enabled' }),
        ),
      ),
      http.post('*/api/arbiter/sessions', () =>
        // The backend answers with a *different* state than the request asked
        // for: the control must render the answer.
        HttpResponse.json(
          admission({ enabled: false, reason: 'session-disabled' }),
        ),
      ),
    );
    const { user } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    const trigger = await screen.findByRole('button', {
      name: /自动审查（Arbiter · 工作区写入）/u,
    });
    expect(trigger).toBeEnabled();

    await user.click(trigger);
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '自动审查（Arbiter）',
      }),
    );

    // The requested "enable" is not what the server confirmed.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /未启用自动审查/u }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Arbiter ·/u })).toBeNull();
  });

  test('posts only the session and the action, never a boundary', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
      http.post('*/api/arbiter/sessions', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          admission({ enabled: true, reason: 'session-enabled' }),
        );
      }),
    );
    const { user } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '自动审查（Arbiter）',
      }),
    );
    await waitFor(() => {
      expect(bodies).toEqual([{ sessionId: SESSION, action: 'enable' }]);
    });
  });

  test('keeps the confirmed state when the write fails and never shows the requested value', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
      http.post('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'boundary-unconfirmed',
            message: 'the host did not confirm the boundary',
            revision: 'revision-1',
          },
          { status: 409 },
        ),
      ),
    );
    const { user } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '自动审查（Arbiter）',
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/宿主未确认执行边界，该会话保持拦截状态/u),
      ).toBeInTheDocument();
    });
    // The old value is still the displayed one: a failed enable does not stick.
    expect(
      screen.getByRole('button', { name: /未启用自动审查/u }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Arbiter ·/u })).toBeNull();
  });

  test('drops a superseded answer so a late response cannot revive an old value', async () => {
    const first = deferred<AdmissionBody>();
    let reads = 0;
    server.use(
      http.get('*/api/arbiter/sessions', async () => {
        reads += 1;
        // The first read stays unanswered; the second (newer) read answers
        // "enabled". When the first finally answers "disabled" it is stale.
        if (reads === 1) return HttpResponse.json(await first.promise);
        return HttpResponse.json(
          admission({ enabled: true, reason: 'session-enabled' }),
        );
      }),
    );
    renderClient(<PermissionSelector sessionId={SESSION} bridge={bridge()} />);
    await waitFor(() => {
      expect(reads).toBe(1);
    });

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Arbiter · 工作区写入/u }),
      ).toBeInTheDocument();
    });

    // The stale answer arrives last and must be discarded, not re-rendered.
    await act(async () => {
      first.resolve(admission({ enabled: false }));
      await Promise.resolve();
    });
    expect(
      screen.getByRole('button', { name: /Arbiter · 工作区写入/u }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /未启用自动审查/u }),
    ).toBeNull();
  });

  test('adopts a second connection change on focus without writing', async () => {
    let enabled = false;
    const writes: string[] = [];
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          admission(
            enabled
              ? { enabled: true, reason: 'session-enabled' }
              : { enabled: false },
          ),
        ),
      ),
      http.post('*/api/arbiter/sessions', () => {
        writes.push('write');
        return HttpResponse.json(admission());
      }),
    );
    const { user } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await screen.findByRole('button', { name: /未启用自动审查/u });

    // Another connection enables the session while this page is idle.
    enabled = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Arbiter · 工作区写入/u }),
      ).toBeInTheDocument();
    });
    expect(writes).toEqual([]);
    // The trigger is the control, not a second copy of it.
    expect(screen.getAllByRole('button', { name: /Arbiter/u })).toHaveLength(1);
    expect(user).toBeDefined();
  });

  test('falls back to Chinese when the host language has no arbiter module', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const { locale } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
      { locale: 'zh' },
    );
    const trigger = await screen.findByRole('button', {
      name: /未启用自动审查/u,
    });
    await act(async () => {
      locale.setLocale('en');
      await Promise.resolve();
    });
    // The English catalog has no `permission` module: the Chinese text must
    // remain, never a raw key or `undefined`.
    expect(screen.getByRole('button', { name: /未启用自动审查/u })).toBe(
      trigger,
    );
    const text = document.body.textContent;
    expect(text).not.toMatch(/permission\./u);
    expect(text).not.toMatch(/undefined/u);
  });

  test('localizes the presets it ships with but keeps a renamed host label', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          catalog: () =>
            Promise.resolve([
              { value: 'read-only', name: 'read-only' },
              // A deployment that renamed the preset keeps its own label.
              { value: 'workspace-write', name: '工作区内修改（自定义）' },
            ]),
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual([
      '自动审查（Arbiter）',
      '关闭自动审查',
      '只读',
      '工作区内修改（自定义）',
    ]);
  });

  test('leaves arbiter by the host command alone, never a client-side disable', async () => {
    const order: string[] = [];
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          admission({ enabled: true, reason: 'session-enabled' }),
        ),
      ),
      http.post('*/api/arbiter/sessions', async ({ request }) => {
        const body: unknown = await request.json();
        const action: unknown =
          body !== null && typeof body === 'object'
            ? Reflect.get(body, 'action')
            : null;
        order.push(`api:${typeof action === 'string' ? action : 'unknown'}`);
        return HttpResponse.json(admission());
      }),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          selectPreset: (sessionId, preset) => {
            order.push(`command:${sessionId}:${preset}`);
            return Promise.resolve(true);
          },
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /Arbiter · 工作区写入/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '工作区内修改',
      }),
    );
    // #4 already disables on a successful host command and ignores a failed
    // one, so the client sends no disable of its own: that would exit
    // admission even when the command then failed.
    await waitFor(() => {
      expect(order).toEqual([`command:${SESSION}:workspace-write`]);
    });
  });

  test('keeps the disable action working when the host bridge is unusable', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          admission({ enabled: true, reason: 'session-enabled' }),
        ),
      ),
      http.post('*/api/arbiter/sessions', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(admission({ reason: 'session-disabled' }));
      }),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          available: () => false,
          catalog: () => Promise.resolve(null),
          selectPreset: () => Promise.resolve(false),
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /Arbiter · 工作区写入/u }),
    );
    // No host preset is offered, but leaving Arbiter still is.
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['自动审查（Arbiter）', '关闭自动审查']);
    await user.click(
      within(menu).getByRole('menuitemradio', { name: '关闭自动审查' }),
    );
    await waitFor(() => {
      expect(bodies).toEqual([{ sessionId: SESSION, action: 'disable' }]);
    });
    expect(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    ).toBeInTheDocument();
  });

  test('a failed disable keeps the enabled state and reports the refusal', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          admission({ enabled: true, reason: 'session-enabled' }),
        ),
      ),
      http.post('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          {
            ok: false,
            code: 'boundary-unconfirmed',
            message: '',
            revision: 'revision-1',
          },
          { status: 409 },
        ),
      ),
    );
    const { user } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await user.click(
      await screen.findByRole('button', { name: /Arbiter · 工作区写入/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '关闭自动审查',
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByText(/宿主未确认执行边界，该会话保持拦截状态/u),
      ).toBeInTheDocument();
    });
    // Still enabled: a refused disable does not look like a successful one.
    expect(
      screen.getByRole('button', { name: /Arbiter · 工作区写入/u }),
    ).toBeInTheDocument();
  });

  test('a focus read during a write never settles the display before the write', async () => {
    const write = deferred<AdmissionBody>();
    // First mount read: disabled. The read coalesced after the write: enabled
    // (the server state the write produced).
    const reads: AdmissionBody[] = [
      admission({ enabled: false }),
      admission({ enabled: true, reason: 'session-enabled' }),
    ];
    let writeCount = 0;
    server.use(
      http.get('*/api/arbiter/sessions', () => {
        const next = reads.shift() ?? admission({ enabled: false });
        return HttpResponse.json(next);
      }),
      http.post('*/api/arbiter/sessions', async () => {
        writeCount += 1;
        return HttpResponse.json(await write.promise);
      }),
    );
    const { user } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '自动审查（Arbiter）',
      }),
    );
    await waitFor(() => {
      expect(writeCount).toBe(1);
    });

    // A focus read arrives while the write is still in flight. Its answer is
    // "disabled" (the pre-write server state) and must not be applied.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    // Still busy: the focus answer must not have settled the write's display
    // into a confirmed "disabled" state.
    expect(await screen.findByText('正在应用…')).toBeInTheDocument();

    // The write's own answer is the newest server state.
    await act(async () => {
      write.resolve(admission({ enabled: true, reason: 'session-enabled' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Arbiter · 工作区写入/u }),
      ).toBeInTheDocument();
    });
    // Exactly one read ran after the write, and none during it.
    expect(reads).toHaveLength(0);
  });

  test('keeps no state across an unmount, so a remount shows only the fresh answer', async () => {
    let enabled = true;
    const writes: string[] = [];
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          admission(
            enabled ? { enabled: true, reason: 'session-enabled' } : {},
          ),
        ),
      ),
      http.post('*/api/arbiter/sessions', () => {
        writes.push('write');
        return HttpResponse.json(admission());
      }),
    );
    const view = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await screen.findByRole('button', { name: /Arbiter · 工作区写入/u });

    // Another connection disables the session, then this client goes away.
    enabled = false;
    view.unmount();
    expect(writes).toEqual([]);

    // The remount has no memory of the enabled state: only the fresh answer.
    renderClient(<PermissionSelector sessionId={SESSION} bridge={bridge()} />);
    expect(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Arbiter · 工作区写入/u }),
    ).toBeNull();
  });

  test('adopts a reread triggered by a settled /permission command pair', async () => {
    const listener: { current: (() => void) | null } = { current: null };
    let enabled = true;
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          admission(
            enabled ? { enabled: true, reason: 'session-enabled' } : {},
          ),
        ),
      ),
    );
    renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          observe: (_sessionId, notify) => {
            listener.current = notify;
            return () => {
              listener.current = null;
            };
          },
        })}
      />,
    );
    await screen.findByRole('button', { name: /Arbiter · 工作区写入/u });

    // The session exited through a same-value native command: no knob and no
    // projection changed, only the command pair settled.
    enabled = false;
    await act(async () => {
      listener.current?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /未启用自动审查/u }),
      ).toBeInTheDocument();
    });
  });

  test('unsubscribes the host observer when it unmounts', async () => {
    let stops = 0;
    // Only the configured baseline answers; an unconfigured read fails, which
    // is enough for this case because it asserts the subscription lifetime.
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const view = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          observe: () => () => {
            stops += 1;
          },
        })}
      />,
    );
    await screen.findByRole('button', { name: /未启用自动审查/u });
    view.unmount();
    expect(stops).toBe(1);
  });

  test('leaves no element behind when its registration is removed', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const view = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await screen.findByRole('button', { name: /未启用自动审查/u });
    view.unmount();
    // The overlay is the component's own subtree: removing the registration
    // must not leave a trigger, menu, live region or wrapper for the host's
    // own control to sit behind.
    expect(view.container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole('button', { name: /未启用自动审查/u }),
    ).toBeNull();
  });

  test('offers the host presets but never the auto or derived entries', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const { user } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    const items = within(screen.getByRole('menu')).getAllByRole(
      'menuitemradio',
    );
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      '自动审查（Arbiter）',
      '关闭自动审查',
      '只读',
      '工作区内修改',
      '完全权限',
    ]);
  });
});
