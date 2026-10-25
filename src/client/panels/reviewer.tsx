import { credentialResponse } from '../decoders/reviewer.js';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getJson } from '../api.js';
import {
  Field,
  NumberInput,
  Section,
  Select,
  TextInput,
} from '../components/controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';

import type { Draft } from '../view-types.js';

export function ReviewerPanel(props: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { draft, onDraft } = props;
  const [credential, setCredential] = useState<CredentialView | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getJson('/credentials', credentialResponse)
      .then((value) => {
        if (!cancelled) setCredential(value);
      })
      .catch(() => {
        if (!cancelled) setCredential(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.reviewer.decision.apiKeyRef]);

  return (
    <>
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
          <ChatSettings draft={draft} onDraft={onDraft} />
        ) : (
          <DecisionSettings
            draft={draft}
            onDraft={onDraft}
            credential={credential}
          />
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
    </>
  );
}

function DecisionSettings({
  draft,
  onDraft,
  credential,
}: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
  readonly credential: CredentialView | null;
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
      <Field label={t('reviewer.model')}>
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
          options={['free', 'paid'] as const}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.decision.costTier = value;
            });
          }}
        />
      </Field>
      <Field label={t('reviewer.credential')}>
        <span style={{ fontSize: 12.5, lineHeight: '30px' }}>
          {credential === null
            ? t('reviewer.loading')
            : !credential.supported
              ? t('reviewer.noCredentials')
              : credential.configured
                ? t('reviewer.configured', {
                    value:
                      credential.source === null
                        ? ''
                        : t('reviewer.credentialSource', {
                            source: credential.source,
                          }),
                  })
                : t('reviewer.unset')}
        </span>
      </Field>
    </div>
  );
}

function ChatSettings({
  draft,
  onDraft,
}: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Field label={t('reviewer.provider')} hint={t('reviewer.providerHint')}>
        <TextInput
          value={draft.reviewer.chat.provider}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.chat.provider = value;
            });
          }}
        />
      </Field>
      <Field label={t('reviewer.model')} hint={t('reviewer.modelHint')}>
        <TextInput
          value={draft.reviewer.chat.model}
          onChange={(value) => {
            onDraft((next) => {
              next.reviewer.chat.model = value;
            });
          }}
        />
      </Field>
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
    </div>
  );
}

interface CredentialView {
  readonly configured: boolean;
  readonly source: string | null;
  readonly supported: boolean;
  readonly message?: string;
}
