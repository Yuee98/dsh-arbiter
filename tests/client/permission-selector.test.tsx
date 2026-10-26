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
    /** The server state; the write is what moves it, not the read order. */
    let serverEnabled = false;
    let writeCount = 0;
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          admission(
            serverEnabled
              ? { enabled: true, reason: 'session-enabled' }
              : { enabled: false },
          ),
        ),
      ),
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

    // A focus read arrives while the write is still in flight, and the server
    // has not committed it yet. Its answer must not settle the display.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /正在应用/u })).toBeDisabled();
    });

    // The write commits; its answer is the newest server state.
    serverEnabled = true;
    await act(async () => {
      write.resolve(admission({ enabled: true, reason: 'session-enabled' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Arbiter · 工作区写入/u }),
      ).toBeEnabled();
    });
    // Only the one write ran; the coalesced reread read the committed state.
    expect(writeCount).toBe(1);
  }, 15_000);

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

  test('refuses a second selection while a native command is in flight', async () => {
    const command = deferred<unknown>();
    const writes: string[] = [];
    let exited = false;
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(
          exited
            ? admission({ enabled: false })
            : admission({ enabled: true, reason: 'session-enabled' }),
        ),
      ),
      http.post('*/api/arbiter/sessions', () => {
        writes.push('post');
        return HttpResponse.json(admission({ enabled: true }));
      }),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          selectPreset: () => command.promise.then(() => true),
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /Arbiter · 工作区写入/u }),
    );
    // A host preset goes through the native command, which this case holds open.
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '只读',
      }),
    );
    // The mutation is exclusive: the trigger reports busy and refuses input, so
    // an older command cannot land after a newer one.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '正在应用…' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: '正在应用…' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByRole('menu')).toBeNull();
    expect(writes).toEqual([]);

    exited = true;
    await act(async () => {
      command.resolve({ ok: true, value: { matched: true } });
      await Promise.resolve();
    });
    // The confirmation loop is bounded and timer-based, so this waits through
    // one of its attempts rather than for a same-tick state change.
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /未启用自动审查/u }),
        ).toBeEnabled();
      },
      { timeout: 8000 },
    );
  });

  test('reports a recognized command that did not change the admission', async () => {
    // The confirmation loop is bounded but timer-based; this case waits it out.
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        // The command was recognized but the handler did not apply it: the
        // session is still admitted, so this is a failure, not a success.
        HttpResponse.json(
          admission({ enabled: true, reason: 'session-enabled' }),
        ),
      ),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({ selectPreset: () => Promise.resolve(true) })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /Arbiter · 工作区写入/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '只读',
      }),
    );
    await waitFor(
      () => {
        expect(
          screen.getByText(/宿主命令未实际生效，仍显示上次确认的状态/u),
        ).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );
    // The confirmed state is still shown because the backend still says so.
    expect(
      screen.getByRole('button', { name: /Arbiter · 工作区写入/u }),
    ).toBeInTheDocument();
  }, 20_000);

  test('keeps an unlisted current host preset in the trigger without inventing an option', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          hostPreset: () => ({ currentValue: 'custom' }),
          catalog: () =>
            Promise.resolve([{ value: 'read-only', name: '只读' }]),
        })}
      />,
    );
    // The host legitimately reports `custom` when no configured preset matches;
    // that identity is the truth about the session and must not be dropped.
    const trigger = await screen.findByRole('button', {
      name: /未启用自动审查（custom）/u,
    });
    await user.click(trigger);
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitemradio')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['自动审查（Arbiter）', '关闭自动审查', '只读']);
  });

  test('shows an unmaterialized session as unavailable and inert', async () => {
    let unmaterialized = false;
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        unmaterialized
          ? HttpResponse.json(
              {
                ok: false,
                code: 'session-unknown',
                message: 'session-1 is not available in this host',
                revision: 'revision-1',
              },
              { status: 404 },
            )
          : HttpResponse.json(
              admission({ enabled: true, reason: 'session-enabled' }),
            ),
      ),
    );
    const { user } = renderClient(
      <PermissionSelector sessionId={SESSION} bridge={bridge()} />,
    );
    await screen.findByRole('button', { name: /Arbiter · 工作区写入/u });

    // The host restarted and has not materialized this session yet.
    unmaterialized = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    const unavailable = await screen.findByRole('button', {
      name: /当前会话不可用/u,
    });
    expect(unavailable).toBeDisabled();
    // The old enabled label is not presented as current.
    expect(screen.queryByRole('button', { name: /Arbiter ·/u })).toBeNull();

    // Once the session materializes, the fresh confirmed answer is shown.
    unmaterialized = false;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Arbiter · 工作区写入/u }),
      ).toBeEnabled();
    });
    expect(user).toBeDefined();
  });

  test('picks up a catalog that becomes available after mount, and a changed one', async () => {
    let catalogReads = 0;
    let notify: (() => void) | null = null;
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          catalog: () => {
            catalogReads += 1;
            // The first read fails (service not ready yet), the second answers
            // one option, the third answers two: a late and a changed catalog
            // must both reach the menu.
            if (catalogReads === 1) return Promise.resolve(null);
            if (catalogReads === 2) {
              return Promise.resolve([{ value: 'read-only', name: '只读' }]);
            }
            return Promise.resolve([
              { value: 'read-only', name: '只读' },
              { value: 'workspace-write', name: '工作区内修改' },
            ]);
          },
          observe: (_id, _listener, onCatalogChanged) => {
            notify = onCatalogChanged;
            return () => undefined;
          },
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    expect(
      within(screen.getByRole('menu')).queryByRole('menuitemradio', {
        name: '只读',
      }),
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: /取消/u }));

    // The host reports the catalog is available now.
    await act(async () => {
      notify?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(catalogReads).toBe(2);
    });
    await user.click(screen.getByRole('button', { name: /未启用自动审查/u }));
    expect(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '只读',
      }),
    ).toBeInTheDocument();

    // And a changed catalog replaces the options rather than appending.
    await act(async () => {
      notify?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(catalogReads).toBe(3);
    });
    await waitFor(() => {
      expect(
        within(screen.getByRole('menu')).getByRole('menuitemradio', {
          name: '工作区内修改',
        }),
      ).toBeInTheDocument();
    });
  });

  test('a newer catalog read wins over a slower earlier one', async () => {
    const first = deferred<readonly { value: string; name: string }[] | null>();
    let reads = 0;
    let notify: (() => void) | null = null;
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          catalog: () => {
            reads += 1;
            if (reads === 1) return first.promise;
            return Promise.resolve([{ value: 'read-only', name: '只读' }]);
          },
          observe: (_id, _listener, onCatalogChanged) => {
            notify = onCatalogChanged;
            return () => undefined;
          },
        })}
      />,
    );
    await screen.findByRole('button', { name: /未启用自动审查/u });
    await act(async () => {
      notify?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    // The first read settles last with a stale, larger option set and must not
    // replace the newer answer.
    await act(async () => {
      first.resolve([{ value: 'stale', name: '过期选项' }]);
      await Promise.resolve();
    });
    await user.click(screen.getByRole('button', { name: /未启用自动审查/u }));
    const menu = screen.getByRole('menu');
    expect(
      within(menu).getByRole('menuitemradio', { name: '只读' }),
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitemradio', { name: '过期选项' }),
    ).toBeNull();
  });

  test('a connection generation replacement rereads the backend state', async () => {
    let generationListener: (() => void) | null = null;
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
          // A silent reconnect: the generation source publishes a new value with
          // no browser focus, online or visibility event.
          observe: (_id, listener) => {
            generationListener = listener;
            return () => undefined;
          },
        })}
      />,
    );
    await screen.findByRole('button', { name: /Arbiter · 工作区写入/u });

    enabled = false;
    await act(async () => {
      generationListener?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /未启用自动审查/u }),
      ).toBeInTheDocument();
    });
  });

  test('a failed native command is reported as a failure, never as applied', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(admission({ enabled: false })),
      ),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        // The host did not even recognize the command.
        bridge={bridge({ selectPreset: () => Promise.resolve(false) })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '只读',
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByText(/宿主权限命令未生效，仍显示上次确认的状态/u),
      ).toBeInTheDocument();
    });
    // The previously confirmed value is still what is displayed.
    expect(
      screen.getByRole('button', { name: /未启用自动审查/u }),
    ).toBeInTheDocument();
  });

  test('stays busy while a native switch is still being confirmed', async () => {
    const command = deferred<unknown>();
    const reads: string[] = [];
    let admitted = true;
    let applied = false;
    server.use(
      http.get('*/api/arbiter/sessions', () => {
        reads.push('read');
        return HttpResponse.json(
          admitted
            ? admission({ enabled: true, reason: 'session-enabled' })
            : admission({ enabled: false }),
        );
      }),
      http.post('*/api/arbiter/sessions', () => {
        reads.push('write');
        return HttpResponse.json(admission({ enabled: true }));
      }),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          selectPreset: () => command.promise.then(() => true),
          hostPreset: () => ({
            currentValue: applied ? 'read-only' : 'workspace-write',
          }),
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /Arbiter · 工作区写入/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '只读',
      }),
    );

    // The command settles, but the first authoritative answer still says
    // "admitted" and the host selection has not moved yet. The control must
    // stay busy and refuse a second selection in that window.
    await act(async () => {
      command.resolve({ ok: true, value: { matched: true } });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(reads.length).toBeGreaterThan(1);
    });
    expect(screen.getByRole('button', { name: '正在应用…' })).toBeDisabled();
    expect(reads).not.toContain('write');

    // Once the switch really applied, the control settles to the confirmed
    // state and never overwrites it with an intermediate answer.
    admitted = false;
    applied = true;
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /未启用自动审查（只读）/u }),
        ).toBeEnabled();
      },
      { timeout: 10_000 },
    );
  }, 20_000);

  test('a rejected switch on an already disabled session is a failure, not success', async () => {
    server.use(
      http.get('*/api/arbiter/sessions', () =>
        HttpResponse.json(admission({ enabled: false })),
      ),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          // Recognized, but the host never applied it: the selection stays put.
          selectPreset: () => Promise.resolve(true),
          hostPreset: () => ({ currentValue: 'workspace-write' }),
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '只读',
      }),
    );
    // Arbiter was already disabled, so an admission read proves nothing about
    // the switch; the host selection is the independent evidence.
    await waitFor(
      () => {
        expect(
          screen.getByText(/宿主命令未实际生效，仍显示上次确认的状态/u),
        ).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 20_000);

  test('refreshes the catalog when the connection generation is replaced', async () => {
    let recovery: (() => void) | null = null;
    let catalogReads = 0;
    server.use(
      http.get('*/api/arbiter/sessions', () => HttpResponse.json(admission())),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          // The first catalog belongs to the old generation; the recovered host
          // serves a different option set with no catalog-changed event.
          catalog: () => {
            catalogReads += 1;
            return Promise.resolve(
              catalogReads === 1
                ? [{ value: 'read-only', name: '只读' }]
                : [{ value: 'workspace-write', name: '工作区内修改' }],
            );
          },
          observe: (_id, _listener, onCatalogChanged) => {
            recovery = onCatalogChanged;
            return () => undefined;
          },
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /未启用自动审查/u }),
    );
    expect(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '只读',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /取消/u }));

    // A recovered generation invalidates the options as well as the admission.
    await act(async () => {
      recovery?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(catalogReads).toBe(2);
    });
    await user.click(screen.getByRole('button', { name: /未启用自动审查/u }));
    expect(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '工作区内修改',
      }),
    ).toBeInTheDocument();
  });

  test('a failed reconciliation read keeps the control busy until the switch resolves', async () => {
    let reads = 0;
    let admitted = true;
    let applied = false;
    server.use(
      http.get('*/api/arbiter/sessions', () => {
        reads += 1;
        // The first reconciliation read fails transiently; the switch has not
        // been confirmed yet, so the control must not become actionable.
        if (reads === 2) {
          return HttpResponse.json(
            { message: 'temporarily unavailable' },
            { status: 500 },
          );
        }
        return HttpResponse.json(
          admitted
            ? admission({ enabled: true, reason: 'session-enabled' })
            : admission({ enabled: false }),
        );
      }),
    );
    const { user } = renderClient(
      <PermissionSelector
        sessionId={SESSION}
        bridge={bridge({
          selectPreset: () => Promise.resolve(true),
          hostPreset: () => ({
            currentValue: applied ? 'read-only' : 'workspace-write',
          }),
        })}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: /Arbiter · 工作区写入/u }),
    );
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitemradio', {
        name: '只读',
      }),
    );

    // During the failed read the control is still the mutation's: busy.
    await waitFor(() => {
      expect(reads).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByRole('button', { name: '正在应用…' })).toBeDisabled();

    // The next read confirms the switch; the control becomes interactive once.
    admitted = false;
    applied = true;
    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /未启用自动审查（只读）/u }),
        ).toBeEnabled();
      },
      { timeout: 10_000 },
    );
    expect(screen.queryByRole('button', { name: '正在应用…' })).toBeNull();
  }, 20_000);

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
