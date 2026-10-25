import type { ReactNode } from 'react';

import { Section } from '../components/controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';

import type { StateResponse } from '../view-types.js';

export function AboutPanel(props: {
  readonly state: StateResponse;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <>
      <Section
        title={t('about.trialTitle')}
        description={t('about.trialDescription')}
      >
        <pre
          style={{
            margin: 0,
            padding: 12,
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-module-platform)',
            fontSize: 12,
            fontFamily: 'var(--dsw-font-mono, monospace)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {t('about.trialCommands')}
        </pre>
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          {t('about.executionPrefix')}
          {props.state.executionMode}
          {t('about.executionExplanation')}
        </p>
      </Section>
      <Section title={t('about.boundaries')}>
        <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          <div>
            <strong>{t('about.connected')}</strong>
          </div>
          <ul style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
            {props.state.coverage.gated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <strong>{t('about.notIndividual')}</strong>
          </div>
          <ul style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
            {props.state.coverage.notGated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <strong>{t('about.lifecycle')}</strong>
          </div>
          <p style={{ margin: '4px 0 0' }}>{t('about.lifecycleDescription')}</p>
        </div>
      </Section>
      <Section title={t('about.limits')}>
        <ul
          style={{
            margin: 0,
            paddingLeft: 20,
            fontSize: 12.5,
            lineHeight: 1.7,
          }}
        >
          <li>{t('about.calibrationLimit')}</li>
          <li>{t('about.surfaceLimit')}</li>
          <li>{t('about.subagentLimit')}</li>
          <li>{t('about.projectRulesLimit')}</li>
          <li>{t('about.orderLimit')}</li>
        </ul>
      </Section>
    </>
  );
}
