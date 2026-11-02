import type { WebPoint } from './web-types.js';
import { copy } from './web-copy.js';
import { materialLines, materialSections } from './web-material.js';

export function MaterialPane({ point }: { readonly point: WebPoint }) {
  const lines = materialLines(point.request);
  const changed = new Set(point.changedLines);
  return (
    <section aria-label={copy.material} className="material">
      <h2>{copy.material}</h2>
      {point.preparation === 'preparation-failed' ? (
        <p role="alert">
          {copy.failed} {point.error}
        </p>
      ) : (
        <>
          <p>{point.hasPredecessor ? copy.changes : copy.noPredecessor}</p>
          {point.hasPredecessor && (
            <pre aria-label={copy.changes}>
              {lines.filter((_, index) => changed.has(index)).join('\n')}
            </pre>
          )}
          <details open>
            <summary>{copy.full}</summary>
            {materialSections(point.request).map((section) => (
              <details key={section.key} open={section.key !== 'system'}>
                <summary>{section.key}</summary>
                <pre>
                  {section.lines.map((line, index) => (
                    <span
                      key={String(index)}
                      className={
                        changed.has(section.offset + index)
                          ? 'changed'
                          : undefined
                      }
                    >
                      {line}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              </details>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
