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
        className="arb:cursor-pointer arb:border-none arb:bg-transparent arb:p-0 arb:font-inherit arb:text-left arb:text-xs arb:font-medium arb:text-primary arb:hover:underline"
      >
        {props.summary}
      </button>
      {open ? <div className="arb:mt-1.5">{props.children}</div> : null}
    </div>
  );
}
