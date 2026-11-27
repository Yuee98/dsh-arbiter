import { useEffect, useState } from 'react';
import type { WebOpinionReport } from './web-types.js';

export function useWebOpinions(
  read: (token: string) => Promise<WebOpinionReport>,
  token: string | null,
  viewToken: string | null,
) {
  const [reports, setReports] = useState<ReadonlyMap<string, WebOpinionReport>>(
    new Map(),
  );
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const report = token === null ? undefined : reports.get(token);
  const current = report?.viewToken === viewToken ? report : null;
  useEffect(() => {
    if (token === null || viewToken === null || current !== null) return;
    let active = true;
    read(token)
      .then((result) => {
        if (!active) return;
        if (result.viewToken !== viewToken) {
          setFailed(viewToken);
          return;
        }
        setReports((previous) => new Map(previous).set(token, result));
      })
      .catch(() => {
        if (active) setFailed(viewToken);
      });
    return () => {
      active = false;
    };
  }, [attempt, current, read, token, viewToken]);
  return {
    report: current,
    pending:
      token !== null &&
      viewToken !== null &&
      failed !== viewToken &&
      current === null,
    failed: failed !== null && failed === viewToken,
    retry: () => {
      setFailed(null);
      setAttempt((value) => value + 1);
    },
  };
}
