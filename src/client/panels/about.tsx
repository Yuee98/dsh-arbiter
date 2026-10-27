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
        <pre className="arb:m-0 arb:rounded-md arb:border arb:border-border-default arb:bg-layer-3 arb:p-3 arb:font-mono arb:text-xs arb:whitespace-pre-wrap arb:text-primary">
          {t('about.trialCommands')}
        </pre>
        <p className="arb:m-0 arb:text-xs arb:text-secondary">
          {t('about.executionPrefix')}
          {props.state.executionMode}
          {t('about.executionExplanation')}
        </p>
      </Section>
      <Section title={t('about.boundaries')}>
        <div className="arb:text-xs arb:leading-relaxed arb:text-primary">
          <div>
            <strong>{t('about.connected')}</strong>
          </div>
          <ul className="arb:my-1.5 arb:mb-2.5 arb:list-disc arb:pl-5 arb:text-secondary">
            {props.state.coverage.gated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <strong>{t('about.notIndividual')}</strong>
          </div>
          <ul className="arb:my-1.5 arb:mb-2.5 arb:list-disc arb:pl-5 arb:text-secondary">
            {props.state.coverage.notGated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div>
            <strong>{t('about.lifecycle')}</strong>
          </div>
          <p className="arb:mt-1 arb:text-secondary">
            {t('about.lifecycleDescription')}
          </p>
        </div>
      </Section>
      <Section title={t('about.limits')}>
        <ul className="arb:m-0 arb:list-disc arb:pl-5 arb:text-xs arb:leading-relaxed arb:text-secondary">
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
