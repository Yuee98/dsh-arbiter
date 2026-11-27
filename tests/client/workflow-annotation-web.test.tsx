import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { AnnotationApp } from '../../evals/src/annotation/web-app.js';
import { copy } from '../../evals/src/annotation/web-copy.js';
import { EMPTY_FORM } from '../../evals/src/annotation/web-types.js';
import type {
  WebBootstrap,
  WebConsensusSummary,
  WebMutation,
  WebOpinionReport,
  WebPoint,
} from '../../evals/src/annotation/web-types.js';

function fixture(
  mode: 'blind' | 'assisted' = 'blind',
  patch: Partial<WebPoint> = {},
) {
  let point: WebPoint = {
    token: 'first',
    referenceStatus: 'none',
    decisionDate: null,
    viewToken: 'view-first',
    workflow: 1,
    position: 1,
    status: 'draft',
    sampled: false,
    revision: 0,
    publicationPending: false,
    form: { ...EMPTY_FORM },
    preparation: 'ready',
    error: null,
    exposed: false,
    request: { user: 'VISIBLE_QUOTE <img src=x onerror=alert(1)>' },
    hasPredecessor: false,
    changedLines: [],
    ...patch,
  };
  const second: WebPoint = {
    ...point,
    token: 'second',
    referenceStatus: 'none',
    viewToken: 'view-second',
    position: 2,
    form: EMPTY_FORM,
    status: 'unopened',
  };
  const data: WebBootstrap = {
    mode,
    points: [point, second],
    current: 'first',
    risk: [{ score: 1, criterion: 'Risk criterion' }],
    authorization: [{ score: 10, criterion: 'Authorization criterion' }],
  };
  const update = (value: WebMutation, confirmed: boolean) => {
    point = {
      ...point,
      ...value,
      revision: value.revision + 1,
      status: confirmed ? value.form.state : 'draft',
      referenceStatus: confirmed ? value.form.state : point.referenceStatus,
      decisionDate: confirmed ? '2026-11-02' : point.decisionDate,
    };
    return Promise.resolve(point);
  };
  const transport = {
    bootstrap: vi.fn(() => Promise.resolve(data)),
    consensus: vi.fn((): Promise<readonly WebConsensusSummary[]> =>
      Promise.resolve([
        { token: 'first', status: 'disagreed' },
        { token: 'second', status: 'agreed' },
      ]),
    ),
    point: vi.fn((token: string) =>
      Promise.resolve(token === 'first' ? point : second),
    ),
    save: vi.fn((value: WebMutation) => update(value, false)),
    confirm: vi.fn((value: WebMutation) => update(value, true)),
    reload: vi.fn(() => Promise.resolve(point)),
    settle: vi.fn(() => {
      point = {
        ...point,
        revision: point.revision + 1,
        publicationPending: false,
        status: 'draft',
      };
      return Promise.resolve(point);
    }),
    rebase: vi.fn(() => {
      point = {
        ...point,
        revision: point.revision + 1,
        viewToken: 'view-rebased',
        status: 'draft',
      };
      return Promise.resolve(point);
    }),
    opinions: vi.fn((): Promise<WebOpinionReport> =>
      Promise.resolve({
        viewToken: 'view-first',
        opinions: [
          {
            id: 'm1',
            model: 'synthetic-model',
            rationale: '<script>unsafe()</script>',
            evidence: 'VISIBLE_QUOTE',
            pairs: '3,10',
            behaviour: 'deny',
            complete: true,
            conflicts: ['A later instruction superseded the first'],
            unresolvedConflicts: [],
          },
        ],
        consensus: {
          n: 1,
          k: 1,
          valid: 1,
          missing: 0,
          failed: 0,
          reasons: ['insufficient-exact-pair-consensus'],
          draft: null,
        },
      }),
    ),
  };
  return { transport, initial: point };
}
describe('standalone workflow annotation production React page', () => {
  test('explicit no-score behaviour confirmation is distinct from an empty score field', async () => {
    const user = userEvent.setup();
    const { transport } = fixture();
    render(<AnnotationApp transport={transport} />);
    await user.click(await screen.findByText(copy.optionalDecision));
    await user.type(
      await screen.findByLabelText(copy.rationale),
      'Material cannot establish scores',
    );
    await user.type(screen.getByLabelText(copy.author), 'synthetic-human');
    await user.selectOptions(
      screen.getByLabelText(copy.behaviour),
      'insufficient-material',
    );
    expect(screen.getByRole('button', { name: copy.confirm })).toBeDisabled();
    await user.click(screen.getByLabelText(copy.noScores));
    expect(screen.getByLabelText(copy.pairs)).toBeDisabled();
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    await waitFor(() => {
      expect(transport.confirm).toHaveBeenCalledTimes(1);
    });
    expect(transport.confirm.mock.calls[0]?.[0].form).toMatchObject({
      noScores: true,
      pairs: '',
      behaviour: 'insufficient-material',
    });
  });
  test.each([false, true])(
    'confirm-and-next advances only after a successful current write; failure=%s',
    async (fails) => {
      const user = userEvent.setup();
      const { transport } = fixture('blind', {
        form: {
          ...EMPTY_FORM,
          pairs: '3,10',
          behaviour: 'deny',
          rationale: 'reviewed',
          evidence: 'VISIBLE_QUOTE',
          author: 'tester',
        },
      });
      if (fails)
        transport.confirm.mockRejectedValueOnce(new Error(copy.unknown));
      render(<AnnotationApp transport={transport} />);
      await screen.findByLabelText(copy.rationale);
      await user.click(screen.getByRole('button', { name: copy.confirmNext }));
      await waitFor(() => {
        expect(transport.confirm).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(transport.point).toHaveBeenCalledTimes(fails ? 1 : 2);
        expect(screen.queryByText(copy.unknown) !== null).toBe(fails);
      });
      expect(screen.getByLabelText(copy.rationale)).toHaveValue(
        fails ? 'reviewed' : '',
      );
      expect(screen.getByLabelText(copy.author)).toHaveValue('tester');
    },
  );
  test.each([false, true])(
    'stale draft rebase displays both forms before explicit choice; keep local=%s',
    async (keepLocal) => {
      const user = userEvent.setup();
      const { transport, initial } = fixture('blind', {
        form: { ...EMPTY_FORM, rationale: 'local old input' },
      });
      const newer = {
        ...initial,
        revision: 1,
        form: { ...initial.form, rationale: 'newer page input' },
      };
      transport.reload.mockResolvedValue(newer);
      transport.rebase.mockResolvedValue({
        ...newer,
        revision: 2,
        viewToken: 'reviewed-new-view',
      });
      render(<AnnotationApp transport={transport} />);
      await screen.findByLabelText(copy.rationale);
      await user.click(screen.getByText(copy.review, { selector: 'summary' }));
      await user.click(screen.getByRole('button', { name: copy.review }));
      expect(
        await screen.findByRole('region', { name: copy.newerDraft }),
      ).toHaveTextContent('newer page input');
      expect(screen.getByLabelText(copy.rationale)).toHaveValue(
        'local old input',
      );
      expect(transport.rebase).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole('button', {
          name: keepLocal ? copy.keepMine : copy.adoptNewer,
        }),
      );
      await waitFor(() => {
        expect(
          screen.queryByRole('region', { name: copy.newerDraft }),
        ).not.toBeInTheDocument();
      });
      expect(screen.getByLabelText(copy.rationale)).toHaveValue(
        keepLocal ? 'local old input' : 'newer page input',
      );
      expect(transport.rebase.mock.calls).toEqual(
        keepLocal ? [['first', 1]] : [],
      );
    },
  );
  test('pending confirmation cannot be discarded by rebase and can be adopted for recovery', async () => {
    const user = userEvent.setup();
    const { transport, initial } = fixture();
    const pending = {
      ...initial,
      publicationPending: true,
      decisionDate: '2025-01-01',
      form: {
        ...initial.form,
        rationale: 'durable confirmation',
        author: 'tester',
      },
    };
    transport.reload.mockResolvedValue(pending);
    render(<AnnotationApp transport={transport} />);
    await screen.findByLabelText(copy.rationale);
    await user.click(screen.getByText(copy.review, { selector: 'summary' }));
    await user.click(screen.getByRole('button', { name: copy.review }));
    expect(
      await screen.findByRole('button', { name: copy.keepMine }),
    ).toBeDisabled();
    expect(transport.rebase).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: copy.adoptNewer }));
    expect(
      await screen.findByRole('button', { name: copy.retryConfirm }),
    ).toBeEnabled();
    expect(screen.getByLabelText(copy.rationale)).toHaveValue(
      'durable confirmation',
    );
    expect(screen.getByText(`${copy.date} 2025-01-01`)).toBeInTheDocument();
    transport.settle.mockResolvedValue({
      ...pending,
      publicationPending: false,
      status: 'draft',
      revision: 1,
    });
    await user.click(
      screen.getByText(copy.settleConfirm, { selector: 'summary' }),
    );
    await user.click(screen.getByRole('button', { name: copy.settleConfirm }));
    expect(await screen.findByText(copy.settledDraft)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.rationale)).toHaveValue(
      'durable confirmation',
    );
    expect(transport.settle).toHaveBeenCalledWith('first', 0);
  });
  test('shared consensus is selectable into an unconfirmed draft', async () => {
    const user = userEvent.setup();
    const { transport } = fixture('assisted');
    const report = await transport.opinions(),
      base = report.opinions[0];
    if (base === undefined) throw new Error('fixture');
    transport.opinions.mockClear();
    transport.opinions.mockResolvedValue({
      ...report,
      opinions: [base],
      consensus: {
        n: 3,
        k: 3,
        valid: 3,
        missing: 0,
        failed: 0,
        reasons: [],
        draft: { ...base, id: 'model-consensus' },
      },
    });
    render(<AnnotationApp transport={transport} />);
    await screen.findByLabelText(copy.rationale);
    await user.click(
      await screen.findByRole('button', { name: copy.consensusSelect }),
    );
    expect(screen.getByLabelText(copy.pairs)).toHaveValue('3,10');
    expect(transport.confirm).not.toHaveBeenCalled();
  });
  test('rebase clears old-view opinions before the new material can use them', async () => {
    const user = userEvent.setup();
    const { transport, initial } = fixture('assisted');
    transport.reload.mockResolvedValue({
      ...initial,
      preparation: 'preparation-failed',
      request: null,
      viewToken: null,
      error: 'MATERIAL_CHANGED_REVIEW_REQUIRED',
    });
    transport.rebase.mockResolvedValue({
      ...initial,
      revision: 1,
      viewToken: 'new-view',
      request: { user: 'NEW_AUTHORIZATION_FACT' },
    });
    render(<AnnotationApp transport={transport} />);
    await screen.findByLabelText(copy.rationale);
    expect(await screen.findByText('synthetic-model')).toBeVisible();
    await user.click(screen.getByText(copy.review, { selector: 'summary' }));
    await user.click(screen.getByRole('button', { name: copy.review }));
    expect(
      await screen.findByText('NEW_AUTHORIZATION_FACT', { selector: 'p' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('<script>unsafe()</script>'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: copy.selectOpinion }),
    ).not.toBeInTheDocument();
  });
  test('formal progress distinguishes a prior approved reference from local unopened work', async () => {
    const { transport } = fixture('blind', {
      status: 'unopened',
      referenceStatus: 'confirmed',
    });
    render(<AnnotationApp transport={transport} />);
    await screen.findByLabelText(copy.rationale);
    expect(
      screen.getByRole('navigation', { name: copy.workflows }),
    ).toHaveTextContent(`1 / 2`);
    expect(screen.getByLabelText(copy.rationale)).toHaveValue('');
  });
  test('restores a local draft, escapes current material and never requests opinions in blind mode', async () => {
    const { transport } = fixture('blind', {
      form: { ...EMPTY_FORM, rationale: 'restored draft' },
    });
    render(<AnnotationApp transport={transport} />);
    expect(await screen.findByLabelText(copy.rationale)).toHaveValue(
      'restored draft',
    );
    expect(
      screen.getByText(/VISIBLE_QUOTE/u, { selector: 'p' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('FUTURE_FAILURE_SENTINEL');
    expect(
      screen.queryByRole('region', { name: copy.opinions }),
    ).not.toBeInTheDocument();
    expect(transport.opinions).not.toHaveBeenCalled();
    expect(transport.consensus).not.toHaveBeenCalled();
    expect(transport.confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: copy.confirm })).toBeDisabled();
  });
  test('autosaves draft only and flushes current form before explicit single-point confirmation', async () => {
    const user = userEvent.setup();
    const { transport } = fixture();
    render(<AnnotationApp transport={transport} />);
    await user.click(await screen.findByText(copy.optionalDecision));
    await user.type(
      await screen.findByLabelText(copy.rationale),
      'Human rationale',
    );
    await waitFor(() => {
      expect(transport.save).toHaveBeenCalled();
    });
    expect(transport.confirm).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(copy.pairs), '3,10\n4,9');
    await user.selectOptions(screen.getByLabelText(copy.behaviour), 'deny');
    await user.type(screen.getByLabelText(copy.evidence), 'VISIBLE_QUOTE');
    await user.type(screen.getByLabelText(copy.author), 'synthetic-human');
    await user.click(screen.getByRole('button', { name: copy.confirm }));
    await waitFor(() => {
      expect(transport.confirm).toHaveBeenCalledTimes(1);
    });
    expect(transport.confirm.mock.calls[0]?.[0].token).toBe('first');
    expect(transport.confirm.mock.calls[0]?.[0].form).toMatchObject({
      pairs: '3,10\n4,9',
      behaviour: 'deny',
      author: 'synthetic-human',
    });
    expect(await screen.findByText(copy.confirmed)).toBeInTheDocument();
    expect(
      transport.confirm.mock.calls.every(([value]) => value.token === 'first'),
    ).toBe(true);
  });
  test.each([copy.error, copy.conflict])(
    'retains unsaved input and blocks navigation after %s; explicit retry recovers',
    async (message) => {
      const user = userEvent.setup();
      const { transport } = fixture();
      transport.save.mockRejectedValueOnce(new Error(message));
      render(<AnnotationApp transport={transport} />);
      await user.click(await screen.findByText(copy.optionalDecision));
      await user.type(
        await screen.findByLabelText(copy.rationale),
        'retained input',
      );
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByLabelText(copy.rationale)).toHaveValue(
        'retained input',
      );
      expect(transport.point).toHaveBeenCalledTimes(1);
      expect(transport.confirm).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: copy.retry }));
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
      expect(screen.getByLabelText(copy.rationale)).toHaveValue(
        'retained input',
      );
    },
  );
  test('assisted rows start collapsed next to the case and expand into a draft suggestion', async () => {
    const user = userEvent.setup();
    const { transport } = fixture('assisted');
    render(<AnnotationApp transport={transport} />);
    const material = await screen.findByRole('region', { name: copy.material });
    const panel = within(material).getByRole('region', { name: copy.opinions });
    const name = await within(panel).findByText('synthetic-model');
    expect(within(panel).getByText('R3 / A10')).toBeVisible();
    expect(
      within(panel).getByText('<script>unsafe()</script>'),
    ).not.toBeVisible();
    await user.click(name);
    expect(within(panel).getByText('<script>unsafe()</script>')).toBeVisible();
    expect(within(panel).getByText('VISIBLE_QUOTE')).toBeVisible();
    expect(
      within(panel).getByText('A later instruction superseded the first'),
    ).toBeVisible();
    await user.click(
      within(panel).getByRole('button', { name: copy.selectOpinion }),
    );
    expect(screen.getByLabelText(copy.pairs)).toHaveValue('3,10');
    expect(screen.getByLabelText(copy.behaviour)).toHaveValue('');
    expect(screen.getByText(`${copy.matrixResult} 允许`)).toBeVisible();
    expect(transport.opinions).toHaveBeenCalledTimes(1);
    expect(transport.confirm).not.toHaveBeenCalled();
  });
  test('consensus filter includes unopened points without opening their opinions', async () => {
    const user = userEvent.setup();
    const { transport } = fixture('assisted');
    render(<AnnotationApp transport={transport} />);
    await screen.findByRole('option', { name: `${copy.consensusAgreed} (1)` });
    await user.selectOptions(screen.getByLabelText(copy.consensus), 'agreed');
    const index = screen.getByRole('navigation', { name: copy.workflows });
    expect(within(index).getByRole('button', { name: /点 2/u })).toBeVisible();
    expect(
      within(index).queryByRole('button', { name: /点 1/u }),
    ).not.toBeInTheDocument();
    expect(transport.opinions).toHaveBeenCalledExactlyOnceWith('first');

    await user.selectOptions(
      screen.getByLabelText(copy.consensus),
      'disagreed',
    );
    expect(within(index).getByRole('button', { name: /点 1/u })).toBeVisible();
    expect(
      within(index).queryByRole('button', { name: /点 2/u }),
    ).not.toBeInTheDocument();
  });
  test('preparation failures remain navigable, cannot confirm and preserve a restored draft', async () => {
    const user = userEvent.setup();
    const { transport } = fixture('blind', {
      preparation: 'preparation-failed',
      request: null,
      error: 'OVER_BUDGET',
      status: 'preparation-failed',
      form: { ...EMPTY_FORM, rationale: 'retained old draft' },
    });
    render(<AnnotationApp transport={transport} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.failed);
    expect(screen.getByLabelText(copy.rationale)).toHaveValue(
      'retained old draft',
    );
    expect(screen.getByRole('button', { name: copy.confirm })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: copy.next }));
    await waitFor(() => {
      expect(transport.point).toHaveBeenLastCalledWith('second');
    });
    expect(transport.confirm).not.toHaveBeenCalled();
  });
  test('save keyboard shortcut uses the real editor queue; scale criteria remain available', async () => {
    const user = userEvent.setup();
    const { transport } = fixture();
    render(<AnnotationApp transport={transport} />);
    await user.click(await screen.findByText(copy.optionalDecision));
    await user.type(
      await screen.findByLabelText(copy.rationale),
      'keyboard draft',
    );
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(transport.save).toHaveBeenCalledTimes(1);
    });
    await user.click(screen.getByText(copy.scales));
    expect(screen.getByText('Risk criterion')).toBeVisible();
    expect(screen.getByText('Authorization criterion')).toBeVisible();
  });
});
