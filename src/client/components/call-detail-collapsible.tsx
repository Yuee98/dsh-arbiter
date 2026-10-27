/**
 * A disclosure that renders its content only while open.
 *
 * Native `<details>` keeps its children in the DOM when collapsed, which makes
 * "the raw material is hidden until requested" unobservable in tests and in the
 * accessibility tree. This uses an explicit button with `aria-expanded` and
 * mounts the content only when expanded, so the collapsed state is real rather
 * than purely visual.
 */

import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from './ui/cn.js';

export function Collapsible(props: {
  readonly summary: string;
  readonly children: ReactNode;
  readonly level?: 'group' | 'item';
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div data-collapsible={props.level ?? 'group'} className="arb:my-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="arb:flex arb:w-full arb:cursor-pointer arb:items-center arb:gap-2 arb:rounded arb:border arb:border-border-subtle arb:bg-layer-2/80 arb:px-2.5 arb:py-1.5 arb:text-left arb:text-xs arb:font-medium arb:text-primary arb:transition-colors hover:arb:bg-layer-3 arb:focus-visible:outline-none arb:focus-visible:ring-1 arb:focus-visible:ring-accent"
      >
        <ChevronRight
          className={cn(
            'arb:h-3.5 arb:w-3.5 arb:shrink-0 arb:text-secondary arb:transition-transform arb:duration-200',
            open && 'arb:rotate-90',
          )}
          aria-hidden="true"
        />
        <span>{props.summary}</span>
      </button>
      {open ? (
        <div className="arb:mt-1.5 arb:rounded-b arb:border-x arb:border-b arb:border-border-subtle arb:bg-layer-1/50 arb:p-2.5">
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
