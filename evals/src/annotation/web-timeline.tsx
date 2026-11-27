import { copy, eventKinds, eventStates } from './web-copy.js';
import { asText, entries, fields } from './web-readable-material.js';

function readableOutput(text: string): string {
  if (!/^\s*[[{]/u.test(text)) return text;
  try {
    const data: unknown = JSON.parse(text);
    return asText(data);
  } catch {
    return text;
  }
}

function EventContent({ event }: { readonly event: Record<string, unknown> }) {
  const kind = asText(event['kind']);
  const body = fields(event['body']);
  const content = fields(body['content']);
  const args = fields(event['arguments']);
  const text = asText(event['text']);
  const question = asText(
    fields(event['binding'])['question'] ?? event['question'],
  );
  if (text !== '')
    return (
      <>
        {question !== '' && (
          <p className="linked-question">
            {copy.answerTo} {question}
          </p>
        )}
        <p className="event-text">{text}</p>
      </>
    );
  if (kind === 'call')
    return <pre>{asText(args['command'] ?? event['arguments'])}</pre>;
  if (kind === 'result') {
    const stdout = readableOutput(asText(content['stdout']));
    const stderr = asText(content['stderr']);
    const output =
      [stdout, stderr].filter(Boolean).join('\n') || asText(body['content']);
    const incomplete =
      body['state'] !== 'present'
        ? eventStates.get(asText(body['state']))
        : entries(body['truncations']).length > 0
          ? copy.outputTrimmed
          : '';
    return (
      <>
        {incomplete && <p className="material-muted">{incomplete}</p>}
        {output !== '' &&
          (output.length <= 500 ? (
            <pre>{output}</pre>
          ) : (
            <details className="event-output">
              <summary>{copy.showOutput}</summary>
              <pre>{output}</pre>
            </details>
          ))}
      </>
    );
  }
  if (kind === 'settlement') return null;
  return <pre>{asText(event)}</pre>;
}

export function Timeline({
  source,
  label,
  legacy,
}: {
  readonly source: Record<string, unknown>;
  readonly label: string;
  readonly legacy?: 'human' | 'call';
}) {
  const items = entries(
    source['events'] ?? source['items'] ?? source['tool_calls'],
  );
  if (items.length === 0) return null;
  const rows = items.map(fields);
  const tools = new Map(
    rows
      .filter((event) => event['kind'] === 'call')
      .map((event) => [asText(event['callId']), asText(event['tool'])]),
  );
  const questions = new Map(
    rows
      .filter((event) => event['kind'] === 'question')
      .map((event) => [asText(event['eventId']), asText(event['text'])]),
  );
  return (
    <section className="timeline-section">
      <h3>{label}</h3>
      <ol className="timeline">
        {rows.map((value, index) => {
          const event = { ...value, kind: value['kind'] ?? legacy };
          const row = fields(event);
          const kind = asText(event.kind);
          const callId = asText(row['callId']);
          const tool = asText(
            row['tool'] ?? fields(row['call'])['tool'] ?? tools.get(callId),
          );
          const state = asText(row['outcome'] ?? row['status']);
          const binding = fields(row['binding']);
          const boundQuestion =
            binding['status'] === 'bound'
              ? questions.get(asText(binding['questionEventId']))
              : undefined;
          const display =
            boundQuestion === undefined
              ? row
              : {
                  ...row,
                  binding: {
                    ...binding,
                    question: binding['question'] ?? boundQuestion,
                  },
                };
          const sourceKind = asText(
            fields(row['source'])['kind'] ?? row['source'],
          );
          const title =
            eventKinds.get(sourceKind) ?? eventKinds.get(kind) ?? copy.event;
          return (
            <li
              key={asText(row['eventId'] ?? index)}
              className="timeline-event"
              data-kind={kind}
            >
              <div className="event-header">
                <strong>{title}</strong>
                {tool !== '' && <code>{tool}</code>}
                {callId !== '' && <span className="event-id">{callId}</span>}
                {state !== '' && (
                  <span className="event-state">
                    {eventStates.get(state) ?? state}
                  </span>
                )}
              </div>
              <EventContent event={display} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
