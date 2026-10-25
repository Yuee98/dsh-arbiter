import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { getJson } from '../api.js';
import { credentialResponse } from '../decoders/reviewer.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import type { CredentialStatusView } from '../view-types.js';

/** What this page knows about the draft reference right now. */
type CredentialProbe =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly view: CredentialStatusView };

/**
 * Describe the draft's credential reference.
 *
 * The reference is sent exactly as stored: the decision backend resolves it
 * verbatim, so trimming or substituting it would describe a different
 * credential. Changing the reference returns to the loading state instead of
 * showing the previous reference's answer, and a failed query is reported as
 * unknown rather than as "not set".
 */
export function CredentialStatus(props: {
  readonly reference: string;
}): ReactNode {
  const t = useArbiterTranslation();
  const [probe, setProbe] = useState<CredentialProbe>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setProbe({ kind: 'loading' });
    void getJson(
      `/credentials?ref=${encodeURIComponent(props.reference)}`,
      credentialResponse,
    )
      .then((view) => {
        if (!cancelled) setProbe({ kind: 'ready', view });
      })
      .catch(() => {
        if (!cancelled) setProbe({ kind: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [props.reference]);

  return (
    <span style={{ fontSize: 12.5, lineHeight: '30px' }}>
      {credentialText(probe, t)}
    </span>
  );
}

function credentialText(
  probe: CredentialProbe,
  t: ReturnType<typeof useArbiterTranslation>,
): string {
  if (probe.kind === 'loading') return t('reviewer.loading');
  if (probe.kind === 'failed') return t('reviewer.credentialUnavailable');
  const { view } = probe;
  switch (view.state) {
    case 'unsupported':
      return t('reviewer.noCredentials');
    case 'unavailable':
      return t('reviewer.credentialUnavailable');
    case 'configured':
      return t('reviewer.configured', {
        value:
          view.source === null
            ? ''
            : t('reviewer.credentialSource', { source: view.source }),
      });
    case 'unconfigured':
      return t('reviewer.unset');
  }
}
