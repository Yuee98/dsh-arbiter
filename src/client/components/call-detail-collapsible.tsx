/**
 * A disclosure that renders its content only while open.
 *
 * Native `<details>` keeps its children in the DOM when collapsed, which makes
 * "the raw material is hidden until requested" unobservable in tests and in the
 * accessibility tree. This uses an explicit button with `aria-expanded` and
 * mounts the content only when expanded, so the collapsed state is real rather
 * than purely visual.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

export function Collapsible(props: {
  readonly summary: string;
  readonly children: ReactNode;
  readonly level?: 'group' | 'item';
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div data-collapsible={props.level ?? 'group'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        style={{
          cursor: 'pointer',
          border: 'none',
          background: 'none',
          padding: 0,
          font: 'inherit',
          color: 'var(--dsw-alias-label-primary)',
          textAlign: 'left',
        }}
      >
        {props.summary}
      </button>
      {open ? <div style={{ marginTop: 6 }}>{props.children}</div> : null}
    </div>
  );
}
