import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { AnnotationApp } from '../../evals/src/annotation/web-app.js';
import { copy } from '../../evals/src/annotation/web-copy.js';
import { EMPTY_FORM } from '../../evals/src/annotation/web-types.js';
import type {
  WebBootstrap,
  WebMutation,
  WebOpinion,
  WebPoint,
} from '../../evals/src/annotation/web-types.js';

function fixture(
  mode: 'blind' | 'assisted' = 'blind',
  patch: Partial<WebPoint> = {},
) {
  let point: WebPoint = {
    token: 'first',
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
    };
    return Promise.resolve(point);
  };
  const transport = {
    bootstrap: vi.fn(() => Promise.resolve(data)),
    point: vi.fn((token: string) =>
      Promise.resolve(token === 'first' ? point : second),
    ),
    save: vi.fn((value: WebMutation) => update(value, false)),
    confirm: vi.fn((value: WebMutation) => update(value, true)),
    rebase: vi.fn(() =>
      Promise.resolve({ ...point, revision: point.revision + 1 }),
    ),
    opinions: vi.fn((): Promise<readonly WebOpinion[]> =>
      Promise.resolve([
        {
          id: 'm1',
          model: 'synthetic-model',
          rawResponse: '<script>unsafe()</script>',
          rationale: 'model rationale',
          evidence: 'VISIBLE_QUOTE',
          pairs: '3,10\n4,9',
          behaviour: 'deny',
          complete: true,
        },
      ]),
    ),
  };
  return { transport };
}
describe('standalone workflow annotation production React page', () => {
  test('restores a local draft, escapes current material and never requests opinions in blind mode', async () => {
    const { transport } = fixture('blind', {
      form: { ...EMPTY_FORM, rationale: 'restored draft' },
    });
    render(<AnnotationApp transport={transport} />);
    expect(await screen.findByLabelText(copy.rationale)).toHaveValue(
      'restored draft',
    );
    expect(screen.getByText(/VISIBLE_QUOTE/u)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('FUTURE_FAILURE_SENTINEL');
    expect(
      screen.queryByRole('button', { name: copy.opinions }),
    ).not.toBeInTheDocument();
    expect(transport.opinions).not.toHaveBeenCalled();
    expect(transport.confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: copy.confirm })).toBeDisabled();
  });
  test('autosaves draft only and flushes current form before explicit single-point confirmation', async () => {
    const user = userEvent.setup();
    const { transport } = fixture();
    render(<AnnotationApp transport={transport} />);
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
      await user.type(
        await screen.findByLabelText(copy.rationale),
        'retained input',
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
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
  test('assisted opinions load on explicit request, escape raw text and select into an unconfirmed draft', async () => {
    const user = userEvent.setup();
    const { transport } = fixture('assisted');
    render(<AnnotationApp transport={transport} />);
    await screen.findByLabelText(copy.rationale);
    expect(transport.opinions).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: copy.opinions }));
    expect(
      await screen.findByText('<script>unsafe()</script>'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.selectOpinion }));
    expect(screen.getByLabelText(copy.pairs)).toHaveValue('3,10\n4,9');
    expect(screen.getByLabelText(copy.behaviour)).toHaveValue('deny');
    expect(screen.getByText(copy.exposed)).toBeInTheDocument();
    expect(transport.confirm).not.toHaveBeenCalled();
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
