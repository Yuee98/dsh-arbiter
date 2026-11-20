import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  WebBootstrap,
  WebOpinion,
  WebConsensusStatus,
  WebPoint,
  WebTransport,
} from './web-types.js';
import { useAnnotationEditor } from './web-use-editor.js';
import { copy } from './web-copy.js';
import { WorkflowList, pointMatches } from './web-workflow-list.js';
import { MaterialPane } from './web-material-pane.js';
import { LabelForm } from './web-label-form.js';
import { OpinionPanel } from './web-opinion-panel.js';
import { ScalePanel } from './web-scale-panel.js';
import { DraftConflict } from './web-draft-conflict.js';
import { useWebOpinions } from './web-use-opinions.js';
export function AnnotationApp({
  transport,
}: {
  readonly transport: WebTransport;
}) {
  const [data, setData] = useState<WebBootstrap | null>(null),
    [initialError, setInitialError] = useState('');
  const [status, setStatus] = useState<ReadonlyMap<
    string,
    WebConsensusStatus
  > | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [progress, setProgress] = useState('all');
  const [consensus, setConsensus] = useState('all');
  const changed = useCallback((point: WebPoint) => {
    setData((value) =>
      value === null
        ? null
        : {
            ...value,
            current: point.token,
            points: value.points.map((item) =>
              item.token === point.token ? point : item,
            ),
          },
    );
  }, []);
  const editor = useAnnotationEditor(transport, changed);
  const { open, confirm, save, failure, point } = editor;
  useEffect(() => {
    let active = true;
    transport
      .bootstrap()
      .then(async (value) => {
        if (!active) return;
        setData(value);
        const token = value.current ?? value.points[0]?.token;
        if (token !== undefined) await open(token);
      })
      .catch((error: unknown) => {
        if (active)
          setInitialError(error instanceof Error ? error.message : copy.error);
      });
    return () => {
      active = false;
    };
  }, [open, transport]);
  const assisted = data?.mode === 'assisted';
  const opinions = useWebOpinions(
    editor.readOpinions,
    assisted && point?.preparation === 'ready' ? point.token : null,
    point?.viewToken ?? null,
  );
  const busy = editor.busy || opinions.pending;
  useEffect(() => {
    if (!assisted) return;
    let active = true;
    transport
      .consensus()
      .then((rows) => {
        if (active)
          setStatus(new Map(rows.map((row) => [row.token, row.status])));
      })
      .catch(() => {
        if (active) setStatusError(true);
      });
    return () => {
      active = false;
    };
  }, [assisted, statusAttempt, transport]);
  const visible = useMemo(
    () =>
      data?.points.filter((item) =>
        pointMatches(item, progress, consensus, status),
      ) ?? [],
    [consensus, data, progress, status],
  );
  const navigate = useCallback(
    (delta: number) => {
      if (data === null) return;
      const index = data.points.findIndex(
        (item) => item.token === point?.token,
      );
      const next =
        delta > 0
          ? data.points.slice(index + 1).find((item) => visible.includes(item))
          : data.points
              .slice(0, index)
              .findLast((item) => visible.includes(item));
      if (next !== undefined) open(next.token).catch(failure);
    },
    [data, failure, open, point?.token, visible],
  );
  const confirmNext = async () => {
    if (await confirm()) navigate(1);
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.repeat || busy) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save().catch(failure);
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        confirm().catch(failure);
      } else if (
        event.altKey &&
        ['ArrowLeft', 'ArrowRight'].includes(event.key)
      ) {
        event.preventDefault();
        navigate(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => {
      window.removeEventListener('keydown', keyboard);
    };
  }, [confirm, busy, failure, navigate, save]);
  const selectOpinion = (opinion: WebOpinion) => {
    if (point !== null)
      editor.edit({
        ...point.form,
        noScores: false,
        pairs: opinion.pairs,
        behaviour: opinion.behaviour,
        rationale: opinion.rationale ?? '',
        evidence: opinion.evidence,
      });
  };
  if (data === null)
    return (
      <p role={initialError === '' ? 'status' : 'alert'}>
        {initialError || copy.loading}
      </p>
    );
  return (
    <>
      <header className="page-header">
        <h1>{copy.title}</h1>
        <span className="mode-label">
          {assisted ? copy.assisted : copy.blind}
        </span>
        <details className="keyboard-help">
          <summary>{copy.keyboard}</summary>
          <p>{copy.shortcuts}</p>
        </details>
      </header>
      <main className="annotation-layout">
        <WorkflowList
          points={data.points}
          current={point?.token ?? null}
          assisted={assisted}
          visible={visible}
          statuses={status}
          statusError={statusError}
          retryStatus={() => {
            setStatusError(false);
            setStatusAttempt((value) => value + 1);
          }}
          progress={progress}
          consensus={consensus}
          onProgress={setProgress}
          onConsensus={setConsensus}
          busy={busy}
          onOpen={(token) => {
            open(token).catch(failure);
          }}
        />
        {point !== null && (
          <>
            <MaterialPane point={point}>
              {assisted && point.preparation === 'ready' && (
                <OpinionPanel
                  key={point.viewToken ?? point.token}
                  report={opinions.report}
                  failed={opinions.failed}
                  busy={busy || editor.blocked}
                  onRetry={opinions.retry}
                  onSelect={selectOpinion}
                />
              )}
            </MaterialPane>
            <section className="decision">
              <h2>{copy.decision}</h2>
              <ScalePanel data={data} />
              <LabelForm
                form={point.form}
                date={point.decisionDate}
                sampled={point.sampled}
                disabled={
                  busy || point.preparation !== 'ready' || editor.blocked
                }
                onChange={(form) => {
                  editor.edit(form);
                }}
                onSample={(sampled) => {
                  editor.edit(point.form, sampled);
                }}
                onConfirm={() => {
                  confirm().catch(failure);
                }}
                onConfirmNext={() => {
                  confirmNext().catch(failure);
                }}
              />
              <p role="status">{editor.message}</p>
              {editor.error !== '' && <p role="alert">{editor.error}</p>}
              <div className="actions">
                {editor.error !== '' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      save().catch(failure);
                    }}
                  >
                    {copy.retry}
                  </button>
                )}
                {editor.blocked && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      confirm().catch(failure);
                    }}
                  >
                    {copy.retryConfirm}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    navigate(-1);
                  }}
                >
                  {copy.previous}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    navigate(1);
                  }}
                >
                  {copy.next}
                </button>
              </div>
              {editor.blocked && (
                <details>
                  <summary>{copy.settleConfirm}</summary>
                  <p>{copy.settleHelp}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      editor.settle().catch(failure);
                    }}
                  >
                    {copy.settleConfirm}
                  </button>
                </details>
              )}
              <details>
                <summary>{copy.review}</summary>
                <p>{copy.reviewWarning}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    editor.rebase().catch(failure);
                  }}
                >
                  {copy.review}
                </button>
              </details>
              {editor.newerDraft !== null && (
                <DraftConflict
                  newer={editor.newerDraft}
                  busy={busy}
                  onResolve={(keepLocal) => {
                    editor.resolveDraft(keepLocal).catch(failure);
                  }}
                />
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
