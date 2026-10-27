import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentPropsWithoutRef } from 'react';
import { forwardRef } from 'react';
import { cn } from './cn.js';
import { useArbiterPortalContainer } from './portal-context.js';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export interface PopoverContentProps extends ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Content
> {
  readonly surface?: string;
}

export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    {
      className,
      align = 'center',
      sideOffset = 4,
      surface = 'popover',
      ...props
    },
    ref,
  ) {
    const container = useArbiterPortalContainer();

    return (
      <PopoverPrimitive.Portal container={container ?? undefined}>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          data-arbiter-surface={surface}
          className={cn(
            'arb:z-50 arb:w-72 arb:rounded-md arb:border arb:border-border-default arb:bg-layer-2 arb:p-4 arb:text-primary arb:shadow-md arb:outline-none arb:data-[state=open]:animate-in arb:data-[state=closed]:animate-out arb:data-[state=closed]:fade-out-0 arb:data-[state=open]:fade-in-0 arb:data-[state=closed]:zoom-out-95 arb:data-[state=open]:zoom-in-95 arb:data-[side=bottom]:slide-in-from-top-2 arb:data-[side=left]:slide-in-from-right-2 arb:data-[side=right]:slide-in-from-left-2 arb:data-[side=top]:slide-in-from-bottom-2',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  },
);
