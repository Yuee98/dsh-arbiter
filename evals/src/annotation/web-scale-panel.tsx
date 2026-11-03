import type { WebBootstrap } from './web-types.js';
import { copy } from './web-copy.js';
export function ScalePanel({ data }: { readonly data: WebBootstrap }) {
  return (
    <details>
      <summary>{copy.scales}</summary>
      <h3>{copy.risk}</h3>
      <ol>
        {data.risk.map((band) => (
          <li key={band.score} value={band.score}>
            {band.criterion}
          </li>
        ))}
      </ol>
      <h3>{copy.authorization}</h3>
      <ol>
        {data.authorization.map((band) => (
          <li key={band.score} value={band.score}>
            {band.criterion}
          </li>
        ))}
      </ol>
    </details>
  );
}
