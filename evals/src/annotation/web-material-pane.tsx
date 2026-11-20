import type { ReactNode } from 'react';
import type { WebPoint } from './web-types.js';
import { copy, materialBlockLabels } from './web-copy.js';
import { materialSections } from './web-material.js';
import {
  asText,
  entries,
  fields,
  materialBlocks,
  materialFields,
} from './web-readable-material.js';
import { Timeline } from './web-timeline.js';

function Action({ blocks }: { readonly blocks: ReadonlyMap<string, string> }) {
  const action = materialFields(blocks.get('PENDING_ACTION'));
  const environment = materialFields(blocks.get('ENVIRONMENT'));
  const args = fields(action['arguments']);
  const program = asText(action['programText'] ?? args['command']);
  const cwd = asText(args['cwd'] ?? environment['cwd']);
  const otherArgs = Object.entries(args).filter(
    ([key, value]) =>
      key !== 'cwd' &&
      (!['command', 'code', 'program'].includes(key) || value !== program),
  );
  return (
    <section className="pending-action" aria-label={copy.action}>
      <header className="action-heading">
        <h3>{copy.action}</h3>
        <code>{asText(action['name'] ?? environment['tool'])}</code>
        {cwd !== '' && <span className="action-path">{cwd}</span>}
      </header>
      <pre>
        {program || asText(action['arguments']) || blocks.get('PENDING_ACTION')}
      </pre>
      {program !== '' && otherArgs.length > 0 && (
        <details>
          <summary>{copy.actionArgs}</summary>
          <pre>{asText(Object.fromEntries(otherArgs))}</pre>
        </details>
      )}
    </section>
  );
}

function SupportingMaterial({
  blocks,
}: {
  readonly blocks: ReadonlyMap<string, string>;
}) {
  const quality = materialFields(blocks.get('MATERIAL_COMPLETENESS'));
  const gaps = [
    ...entries(quality['blocking_gaps']),
    ...entries(quality['missing_input']),
  ];
  const timeline = materialFields(blocks.get('SESSION_TIMELINE'));
  const omissions = entries(timeline['omissions']);
  return (
    <>
      <Timeline
        label={copy.parentEvidence}
        source={materialFields(blocks.get('PARENT_HUMAN_EVIDENCE'))}
      />
      <Timeline label={copy.timeline} source={timeline} />
      <Timeline
        label={copy.humanEvidence}
        source={materialFields(blocks.get('HUMAN_AUTHORIZATION'))}
        legacy="human"
      />
      <Timeline
        label={copy.toolHistory}
        source={materialFields(blocks.get('TURN_TOOL_HISTORY'))}
        legacy="call"
      />
      {(gaps.length > 0 ||
        omissions.length > 0 ||
        quality['action_truncated'] != null) && (
        <details className="material-details">
          <summary>{copy.materialLimits}</summary>
          <pre>
            {asText({
              gaps,
              omissions,
              actionTruncated: quality['action_truncated'],
            })}
          </pre>
        </details>
      )}
      {materialBlockLabels.map(([key, label]) => {
        const block = blocks.get(key);
        if (block === undefined) return null;
        const data = materialFields(block);
        if (
          key === 'PRIOR_VERDICTS' &&
          entries(data['prior_verdicts']).length === 0 &&
          data['coverage'] === 'known-empty'
        )
          return null;
        return (
          <details className="material-details" key={key}>
            <summary>{label}</summary>
            <pre>{block}</pre>
          </details>
        );
      })}
    </>
  );
}

export function MaterialPane({
  point,
  children,
}: {
  readonly point: WebPoint;
  readonly children?: ReactNode;
}) {
  const sections = materialSections(point.request);
  const material = sections.find(
    ({ key }) => key === 'user' || key === 'state',
  );
  const blocks = materialBlocks(material?.lines ?? []);
  const changed = new Set(point.changedLines);
  return (
    <section aria-label={copy.material} className="material">
      <div className="material-heading">
        <h2>{copy.material}</h2>
        <span>
          {copy.workflow} {point.workflow} · {copy.point} {point.position}
        </span>
      </div>
      {point.preparation === 'preparation-failed' ? (
        <p role="alert">
          {copy.failed} {point.error}
        </p>
      ) : (
        <>
          {blocks.size > 0 ? (
            <Action blocks={blocks} />
          ) : (
            <p className="event-text">{material?.lines.join('\n')}</p>
          )}
          {children}
          {blocks.size > 0 && <SupportingMaterial blocks={blocks} />}
          <details className="material-details">
            <summary>{copy.full}</summary>
            {point.hasPredecessor && (
              <p className="material-muted">{copy.changes}</p>
            )}
            {sections.map((section) => (
              <details key={section.key} open={section === material}>
                <summary>
                  {section === material ? copy.originalCase : section.key}
                </summary>
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
