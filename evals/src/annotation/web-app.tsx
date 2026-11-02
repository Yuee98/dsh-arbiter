import { useCallback, useEffect, useState } from 'react';
import type {
  WebBootstrap,
  WebOpinion,
  WebPoint,
  WebTransport,
} from './web-types.js';
import { useAnnotationEditor } from './web-use-editor.js';
import { copy } from './web-copy.js';
import { WorkflowList } from './web-workflow-list.js';
import { MaterialPane } from './web-material-pane.js';
import { LabelForm } from './web-label-form.js';
import { OpinionPanel } from './web-opinion-panel.js';
import { ScalePanel } from './web-scale-panel.js';

export function AnnotationApp({
  transport,
}: {
  readonly transport: WebTransport;
}) {
  const [data, setData] = useState<WebBootstrap | null>(null),
    [initialError, setInitialError] = useState('');
  const [seen, setSeen] = useState<ReadonlyMap<string, readonly WebOpinion[]>>(
    new Map(),
  );
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
  const navigate = useCallback(
    (delta: number) => {
      const index =
        data?.points.findIndex((value) => value.token === point?.token) ?? -1;
      const next = data?.points[index + delta];
      if (next !== undefined) open(next.token).catch(failure);
    },
    [data, failure, open, point?.token],
  );
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.repeat || editor.busy) return;
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
  }, [confirm, editor.busy, failure, navigate, save]);
  const loadOpinions = async () => {
    if (point === null || data?.mode !== 'assisted') return;
    try {
      await editor.flush();
      const values = await transport.opinions(point.token);
      setSeen((previous) => new Map(previous).set(point.token, values));
    } catch (error) {
      failure(error);
    }
  };
  const disagreements = new Set(
    [...seen]
      .filter(
        ([, values]) =>
          new Set(
            values
              .filter((value) => value.complete)
              .map((value) => JSON.stringify([value.pairs, value.behaviour])),
          ).size > 1,
      )
      .map(([token]) => token),
  );
  if (data === null)
    return (
      <p role={initialError === '' ? 'status' : 'alert'}>
        {initialError || copy.loading}
      </p>
    );
  const exposed = point !== null && (point.exposed || seen.has(point.token));
  return (
    <>
      <header>
        <h1>{copy.title}</h1>
        <p>{data.mode === 'blind' ? copy.blind : copy.assisted}</p>
        <p>{copy.shortcuts}</p>
      </header>
      <main className="annotation-layout">
        <WorkflowList
          points={data.points}
          current={point?.token ?? null}
          assisted={data.mode === 'assisted'}
          disagreements={disagreements}
          busy={editor.busy}
          onOpen={(token) => {
            open(token).catch(failure);
          }}
        />
        {point !== null && (
          <>
            <MaterialPane point={point} />
            <section className="decision">
              <ScalePanel data={data} />
              {exposed && <p>{copy.exposed}</p>}
              <LabelForm
                form={point.form}
                sampled={point.sampled}
                disabled={
                  editor.busy || point.preparation !== 'ready' || editor.blocked
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
              />
              <p role="status">{editor.message}</p>
              {editor.error !== '' && <p role="alert">{editor.error}</p>}
              <div className="actions">
                <button
                  type="button"
                  disabled={editor.busy}
                  onClick={() => {
                    save().catch(failure);
                  }}
                >
                  {copy.retry}
                </button>
                {editor.blocked && (
                  <button
                    type="button"
                    disabled={editor.busy}
                    onClick={() => {
                      confirm().catch(failure);
                    }}
                  >
                    {copy.confirm}
                  </button>
                )}
                <button
                  type="button"
                  disabled={editor.busy}
                  onClick={() => {
                    navigate(-1);
                  }}
                >
                  {copy.previous}
                </button>
                <button
                  type="button"
                  disabled={editor.busy}
                  onClick={() => {
                    navigate(1);
                  }}
                >
                  {copy.next}
                </button>
              </div>
              <details>
                <summary>{copy.review}</summary>
                <p>{copy.reviewWarning}</p>
                <button
                  type="button"
                  disabled={editor.busy}
                  onClick={() => {
                    editor.rebase().catch(failure);
                  }}
                >
                  {copy.review}
                </button>
              </details>
              {data.mode === 'assisted' && (
                <OpinionPanel
                  opinions={seen.get(point.token) ?? []}
                  loaded={seen.has(point.token)}
                  busy={editor.busy}
                  onLoad={() => {
                    loadOpinions().catch(failure);
                  }}
                  onSelect={(opinion) => {
                    editor.edit({
                      ...point.form,
                      pairs: opinion.pairs,
                      behaviour: opinion.behaviour,
                      rationale: opinion.rationale ?? '',
                      evidence: opinion.evidence,
                    });
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
