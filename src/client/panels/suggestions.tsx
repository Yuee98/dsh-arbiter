import {
  suggestionsResponse,
  analyzeResponse,
  replayResponse,
} from '../decoders/suggestions.js';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getJson, postJson } from '../api.js';
import {
  Button,
  JsonBlock,
  Notice,
  Section,
  inputStyle,
} from '../components/controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { errorText } from '../view-helpers.js';
import type { CandidateView, ReplayView } from '../view-types.js';

export function SuggestionsPanel(props: {
  readonly onApplied: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const [candidates, setCandidates] = useState<readonly CandidateView[]>([]);
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const response = await getJson('/suggestions', suggestionsResponse);
      setCandidates(response.candidates);
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load().catch((failure: unknown) => {
      setError(errorText(failure));
    });
  }, [load]);

  const analyze = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await postJson(
        '/analyze',
        { windowDays: 30, minOccurrences: 3 },
        analyzeResponse,
      );
      setNotice(
        t('suggestions.created', {
          proposals: response.proposals.length,
          created: response.created,
        }),
      );
      await load();
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  const act = async (
    candidate: CandidateView,
    action: 'accept' | 'reject',
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const edited = editing[candidate.candidateId];
      const rule =
        edited === undefined ? candidate.rule : (JSON.parse(edited) as unknown);
      await postJson('/suggestions/act', {
        candidateId: candidate.candidateId,
        action,
        rule,
      });
      setNotice(
        action === 'accept'
          ? t('suggestions.accepted')
          : t('suggestions.rejected'),
      );
      await load();
      props.onApplied();
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  const loadReplay = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setReplay(await getJson('/replay', replayResponse));
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title={t('suggestions.title')}
        description={t('suggestions.description')}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            onClick={() => {
              analyze().catch((failure: unknown) => {
                setError(errorText(failure));
              });
            }}
            disabled={busy}
            tone="primary"
          >
            {t('suggestions.analyze')}
          </Button>
          <Button
            onClick={() => {
              loadReplay().catch((failure: unknown) => {
                setError(errorText(failure));
              });
            }}
            disabled={busy}
          >
            {t('suggestions.replay')}
          </Button>
          <Button
            onClick={() => {
              load().catch((failure: unknown) => {
                setError(errorText(failure));
              });
            }}
            disabled={busy}
          >
            {t('suggestions.refresh')}
          </Button>
        </div>
        {error === null ? null : <Notice kind="error" text={error} />}
        {notice === null ? null : <Notice kind="ok" text={notice} />}
        {replay === null ? null : <ReplaySummary replay={replay} />}
        {candidates.length === 0 ? (
          <p
            style={{
              margin: 0,
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: 12.5,
            }}
          >
            {t('suggestions.empty')}
          </p>
        ) : (
          candidates.map((candidate) => {
            const ruleText = JSON.stringify(candidate.rule, null, 2);
            return (
              <CandidateCard
                key={candidate.candidateId}
                candidate={candidate}
                ruleText={ruleText}
                value={editing[candidate.candidateId]}
                onEdit={(value) => {
                  setEditing((current) => ({
                    ...current,
                    [candidate.candidateId]: value,
                  }));
                }}
                onAction={(action) => {
                  act(candidate, action).catch((failure: unknown) => {
                    setError(errorText(failure));
                  });
                }}
                busy={busy}
              />
            );
          })
        )}
      </Section>
    </>
  );
}

function CandidateCard({
  candidate,
  ruleText,
  value,
  onEdit,
  onAction,
  busy,
}: {
  readonly candidate: CandidateView;
  readonly ruleText: string;
  readonly value: string | undefined;
  readonly onEdit: (value: string) => void;
  readonly onAction: (action: 'accept' | 'reject') => void;
  readonly busy: boolean;
}): ReactNode {
  const t = useArbiterTranslation();

  return (
    <div
      key={candidate.candidateId}
      style={{
        border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <strong style={{ fontSize: 13 }}>{candidate.candidateId}</strong>
        <span
          style={{
            fontSize: 12,
            color: 'var(--dsw-alias-label-tertiary)',
          }}
        >
          {candidate.status}
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary)',
              marginBottom: 4,
            }}
          >
            {t('suggestions.stats')}
          </div>
          <JsonBlock value={candidate.stats} />
        </div>
        <div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary)',
              marginBottom: 4,
            }}
          >
            {t('suggestions.evidence')}
          </div>
          <JsonBlock value={candidate.evidence} />
        </div>
      </div>
      <div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary)',
            marginBottom: 4,
          }}
        >
          {t('suggestions.rule')}
        </div>
        <textarea
          aria-label={t('suggestions.rule')}
          value={value ?? ruleText}
          rows={10}
          onChange={(event) => {
            onEdit(event.target.value);
          }}
          style={{
            ...inputStyle,
            height: 'auto',
            padding: 8,
            fontFamily: 'var(--dsw-font-mono, monospace)',
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          onClick={() => {
            onAction('accept');
          }}
          disabled={busy || candidate.status !== 'pending'}
          tone="primary"
        >
          {t('suggestions.confirm')}
        </Button>
        <Button
          onClick={() => {
            onAction('reject');
          }}
          disabled={busy || candidate.status !== 'pending'}
          tone="danger"
        >
          {t('suggestions.reject')}
        </Button>
        <span
          style={{
            fontSize: 11.5,
            color: 'var(--dsw-alias-label-tertiary)',
            lineHeight: '30px',
          }}
        >
          {t('suggestions.safetyHint')}
        </span>
      </div>
    </div>
  );
}

function ReplaySummary({ replay }: { readonly replay: ReplayView }): ReactNode {
  const t = useArbiterTranslation();

  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
      <div>
        {t('suggestions.replaySummary', {
          comparable: replay.comparable,
          considered: replay.considered,
          normal: replay.normalAllow,
          progress: replay.progressAllow,
          promoted: replay.promoted,
          changed: replay.changed,
        })}
      </div>
      <div style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
        {t('suggestions.replayHint')}
      </div>
      {replay.items.length === 0 ? null : <JsonBlock value={replay.items} />}
    </div>
  );
}
