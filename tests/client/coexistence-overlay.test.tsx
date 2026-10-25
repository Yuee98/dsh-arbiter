import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { CoexistenceOverlay } from '../../src/client/coexistence-overlay.js';
import type { CoexistenceView } from '../../src/client/view-types.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

const OFFICIAL = '@deepseek-ai/dsh-experimental-auto-review';

function blocking(overrides: Partial<CoexistenceView> = {}): CoexistenceView {
  return {
    detection: 'complete',
    missing: [],
    blocked: true,
    reason: 'official-running',
    official: {
      present: true,
      module: OFFICIAL,
      enabled: true,
      running: true,
      phase: 'active',
    },
    autoSlot: 'arbiter',
    autoSlotProblem: null,
    observations: 2,
    conflicts: [
      {
        id: 'official-auto-review',
        severity: 'blocking',
        kind: 'official-auto-review',
        source: OFFICIAL,
        entryId: 'auto-review',
        capability: 'permissionPresets.auto',
        detail: null,
      },
    ],
    notices: [
      {
        id: 'coexistence-1',
        conflictId: 'official-auto-review',
        severity: 'blocking',
        kind: 'official-auto-review',
        source: OFFICIAL,
        capability: 'permissionPresets.auto',
        at: 1_700_000_000_000,
        acknowledged: false,
      },
    ],
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function serve(view: CoexistenceView | null): void {
  server.use(
    http.get('*/api/arbiter/coexistence', () =>
      HttpResponse.json({ ok: true, coexistence: view }),
    ),
  );
}

/**
 * The overlay is mounted outside Arbiter's settings page, so these cases assert
 * the reminder reaches a user who never opened that page, and that its actions
 * keep "read" separate from "resolved".
 */
describe('frame-wide conflict overlay', () => {
  test('shows the official conflict without the settings page being open', async () => {
    serve(blocking());
    renderClient(<CoexistenceOverlay />);
    const alert = await screen.findByRole('alertdialog', {
      name: '存在冲突的审批提供者',
    });
    expect(alert).toHaveTextContent(OFFICIAL);
    expect(alert).toHaveTextContent('正在运行');
  });

  test('offers plugin-management navigation when the host provides it', async () => {
    serve(blocking());
    let opened = 0;
    const { user } = renderClient(
      <CoexistenceOverlay
        onOpenPluginManager={() => {
          opened += 1;
        }}
      />,
    );
    const alert = await screen.findByRole('alertdialog', {
      name: '存在冲突的审批提供者',
    });
    await user.click(screen.getByRole('button', { name: '打开插件管理' }));
    expect(opened).toBe(1);
    // Navigation is not acknowledgement: the reminder stays on screen.
    expect(alert).toBeInTheDocument();
  });

  test('opens once per conflict period and stays dismissed after acknowledgement', async () => {
    let acknowledged = false;
    server.use(
      http.get('*/api/arbiter/coexistence', () =>
        HttpResponse.json({
          ok: true,
          coexistence: blocking({
            notices: blocking().notices.map((notice) => ({
              ...notice,
              acknowledged,
            })),
          }),
        }),
      ),
      http.post('*/api/arbiter/coexistence', () => {
        acknowledged = true;
        return HttpResponse.json({
          ok: true,
          coexistence: blocking({
            notices: blocking().notices.map((notice) => ({
              ...notice,
              acknowledged: true,
            })),
          }),
        });
      }),
    );
    const { user } = renderClient(<CoexistenceOverlay />);
    const alert = await screen.findByRole('alertdialog', {
      name: '存在冲突的审批提供者',
    });
    await user.click(within(alert).getByRole('button', { name: '知道了' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    // The overlay is the transient reminder only; the persistent section lives
    // in the status panel, so nothing here claims the conflict is resolved.
    expect(screen.queryByText('审批提供者共存')).toBeNull();
  });

  test('renders nothing when the host reports no conflict', async () => {
    serve(
      blocking({ notices: [], conflicts: [], blocked: false, reason: null }),
    );
    renderClient(<CoexistenceOverlay />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
