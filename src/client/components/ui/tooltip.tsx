import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { useArbiterPortalContainer } from './portal-context.js';

export interface TooltipProps {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly delayDuration?: number;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
}

export function Tooltip({
  content,
  children,
  delayDuration = 200,
  side = 'top',
}: TooltipProps): ReactNode {
  const container = useArbiterPortalContainer();

  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal container={container ?? undefined}>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={4}
            data-arbiter-surface="tooltip"
            className={cn(
              'arb:z-50 arb:overflow-hidden arb:rounded arb:border arb:border-border-default arb:bg-layer-2 arb:px-2 arb:py-1 arb:text-xs arb:text-primary arb:shadow-md arb:animate-in arb:fade-in-0 arb:zoom-in-95',
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
