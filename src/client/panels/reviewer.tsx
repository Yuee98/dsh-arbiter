import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getJson } from '../api.js';
import { modelCatalogResponse } from '../decoders/reviewer.js';
import {
  Field,
  NumberInput,
  Section,
  Select,
  TextInput,
} from '../components/controls.js';
import { CredentialStatus } from '../components/credential-status.js';
import { ModelSelect } from '../components/model-select.js';
import type { CatalogLoad } from '../components/model-select.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import type { ModelChoice } from '../model-choice.js';
import type { Draft, ModelCatalogView } from '../view-types.js';

/** The decision backend's cost tiers, kept in protocol order. */
const COST_TIERS = ['free', 'paid'] as const;

/**
 * The Reviewer configuration.
 *
 * The ordinary path is short: pick the backend type and, for chat, one route
 * from the host's configured models; decision asks for the endpoint, model and
 * credential reference. Sampling, output and timeout parameters live behind a
 * disclosure. Every edit goes into the page's shared draft — nothing here
 * saves, tests a connection, or issues a model request.
 */
export function ReviewerPanel(props: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { draft, onDraft } = props;
  const [catalog, setCatalog] = useState<ModelCatalogView | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<CatalogLoad>('loading');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getJson('/models', modelCatalogResponse)
      .then((value) => {
        if (cancelled) return;
        setCatalog(value);
        setCatalogStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        // A failed directory must not look like "no models configured": the
        // draft keeps its route and the selector reports the failed load.
        setCatalog(null);
        setCatalogStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onChoice = useCallback(
    (next: ModelChoice): void => {
      onDraft((draftValue) => {
        draftValue.reviewer.chat.provider = next.provider;
        draftValue.reviewer.chat.model = next.model;
      });
    },
    [onDraft],
  );

  return (
    <Section
      title={t('reviewer.title')}
      description={t('reviewer.description')}
    >
      <div style={{ display: 'flex', gap: 16 }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
          }}
        >
          <input
            type="radio"
            name="arbiter-reviewer-type"
            checked={draft.reviewer.type === 'chat'}
            onChange={() => {
              onDraft((next) => {
                next.reviewer.type = 'chat';
              });
            }}
          />
          {t('reviewer.chat')}
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
          }}
        >
          <input
            type="radio"
            name="arbiter-reviewer-type"
            checked={draft.reviewer.type === 'decision'}
            onChange={() => {
              onDraft((next) => {
                next.reviewer.type = 'decision';
              });
            }}
          />
          {t('reviewer.decision')}
        </label>
      </div>

      {draft.reviewer.type === 'chat' ? (
        <ChatBasics
          provider={draft.reviewer.chat.provider}
          model={draft.reviewer.chat.model}
          catalog={catalog}
          status={catalogStatus}
          query={query}
          onQuery={setQuery}
          onChoice={onChoice}
        />
      ) : (
        <DecisionBasics draft={draft} onDraft={onDraft} />
      )}

      {draft.reviewer.type === 'chat' ? (
        <ChatAdvanced draft={draft} onDraft={onDraft} />
      ) : (
        <DecisionAdvanced draft={draft} onDraft={onDraft} />
      )}

      <p
        style={{
          margin: 0,
          color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 11.5,
        }}
      >
        {t('reviewer.failureDescription')}
      </p>
    </Section>
  );
}

/**
 * The chat route selector plus its prompt.
 *
 * This is a group rather than one `<label>`: the selector owns two controls (a
 * search box and the select itself), and a label may only associate with one.
 */
function ChatBasics({
  provider,
  model,
  catalog,
  status,
  query,
  onQuery,
  onChoice,
}: {
  readonly provider: string;
  readonly model: string;
  readonly catalog: ModelCatalogView | null;
  readonly status: CatalogLoad;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly onChoice: (choice: ModelChoice) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div
      role="group"
      aria-label={t('reviewer.model.label')}
      style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <span
        style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5 }}
      >
        {t('reviewer.model.label')}
      </span>
      <ModelSelect
        choice={{ provider, model }}
        catalog={catalog}
        status={status}
        query={query}
        onQuery={onQuery}
        onChoice={onChoice}
      />
      <span
        style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 }}
      >
        {t('reviewer.model.hint')}
      </span>
    </div>
  );
}

/** URL, model and credential reference; timeout and cost tier are advanced. */
function DecisionBasics({
  draft,
  onDraft,
}: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Field label={t('reviewer.url')}>
        <TextInput
          value={draft.reviewer.decision.url}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.decision.url = value;
            });
          }}
          monospace
        />
      </Field>
      <Field label={t('reviewer.model.decisionLabel')}>
        <TextInput
          value={draft.reviewer.decision.model}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.decision.model = value;
            });
          }}
          monospace
        />
      </Field>
      <Field label={t('reviewer.apiKeyRef')} hint={t('reviewer.apiKeyHint')}>
        <TextInput
          value={draft.reviewer.decision.apiKeyRef}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.decision.apiKeyRef = value;
            });
          }}
          monospace
        />
      </Field>
      <Field label={t('reviewer.credential')}>
        <CredentialStatus reference={draft.reviewer.decision.apiKeyRef} />
      </Field>
    </div>
  );
}

/** Advanced parameters stay behind one disclosure so the common path is short. */
function AdvancedGroup(props: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontSize: 12.5 }}>
        {props.title}
      </summary>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
          marginTop: 10,
        }}
      >
        {props.children}
      </div>
    </details>
  );
}

function ChatAdvanced({
  draft,
  onDraft,
}: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <AdvancedGroup title={t('reviewer.advanced.title')}>
      <Field label={t('reviewer.temperature')}>
        <NumberInput
          value={draft.reviewer.chat.temperature}
          min={0}
          max={2}
          step={0.1}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.chat.temperature = value;
            });
          }}
        />
      </Field>
      <Field label={t('reviewer.maxTokens')}>
        <NumberInput
          value={draft.reviewer.chat.maxTokens}
          min={16}
          max={4000}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.chat.maxTokens = value;
            });
          }}
        />
      </Field>
      <Field label={t('reviewer.timeout')}>
        <NumberInput
          value={draft.reviewer.chat.timeoutMs}
          min={500}
          max={120000}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.chat.timeoutMs = value;
            });
          }}
        />
      </Field>
      <Field
        label={t('reviewer.repairRetries')}
        hint={t('reviewer.repairHint')}
      >
        <NumberInput
          value={draft.reviewer.chat.maxRepairRetries}
          min={0}
          max={3}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.chat.maxRepairRetries = value;
            });
          }}
        />
      </Field>
    </AdvancedGroup>
  );
}

function DecisionAdvanced({
  draft,
  onDraft,
}: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <AdvancedGroup title={t('reviewer.advanced.title')}>
      <Field label={t('reviewer.timeout')}>
        <NumberInput
          value={draft.reviewer.decision.timeoutMs}
          min={500}
          max={120000}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.decision.timeoutMs = value;
            });
          }}
        />
      </Field>
      <Field label={t('reviewer.cost')}>
        <Select
          value={draft.reviewer.decision.costTier}
          options={COST_TIERS}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.decision.costTier = value;
            });
          }}
        />
      </Field>
    </AdvancedGroup>
  );
}
