import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { forwardRef } from 'react';
import { cn } from './cn.js';
import { useArbiterPortalContainer } from './portal-context.js';

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  readonly surface?: string;
  readonly closeLabel?: string;
  readonly showCloseButton?: boolean;
}

export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  function DialogContent(
    {
      className,
      children,
      surface = 'dialog',
      closeLabel = 'Close',
      showCloseButton = true,
      ...props
    },
    ref,
  ) {
    const container = useArbiterPortalContainer();

    return (
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Overlay className="arb:fixed arb:inset-0 arb:z-50 arb:bg-black/60 arb:backdrop-blur-sm arb:data-[state=open]:animate-in arb:data-[state=closed]:animate-out arb:data-[state=closed]:fade-out-0 arb:data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          ref={ref}
          data-arbiter-surface={surface}
          className={cn(
            'arb:fixed arb:left-[50%] arb:top-[50%] arb:z-50 arb:grid arb:w-full arb:max-w-3xl arb:translate-x-[-50%] arb:translate-y-[-50%] arb:gap-4 arb:border arb:border-border-default arb:bg-layer-2 arb:p-6 arb:shadow-lg arb:duration-200 arb:data-[state=open]:animate-in arb:data-[state=closed]:animate-out arb:data-[state=closed]:fade-out-0 arb:data-[state=open]:fade-in-0 arb:data-[state=closed]:zoom-out-95 arb:data-[state=open]:zoom-in-95 arb:data-[state=closed]:slide-out-to-left-1/2 arb:data-[state=closed]:slide-out-to-top-[48%] arb:data-[state=open]:slide-in-from-left-1/2 arb:data-[state=open]:slide-in-from-top-[48%] arb:rounded-lg',
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton ? (
            <DialogPrimitive.Close
              className="arb:absolute arb:right-4 arb:top-4 arb:rounded-sm arb:opacity-70 arb:ring-offset-background arb:transition-opacity arb:hover:opacity-100 arb:focus:outline-none arb:focus:ring-2 arb:focus:ring-ring arb:focus:ring-offset-2 arb:disabled:pointer-events-none"
              aria-label={closeLabel}
            >
              <X className="arb:h-4 arb:w-4" />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);

export function DialogHeader({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>): ReactNode {
  return (
    <div
      className={cn(
        'arb:flex arb:flex-col arb:space-y-1.5 arb:text-left',
        className,
      )}
      {...props}
    />
  );
}

export const DialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        'arb:text-lg arb:font-semibold arb:leading-none arb:tracking-tight arb:text-primary',
        className,
      )}
      {...props}
    />
  );
});

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('arb:text-xs arb:text-secondary', className)}
      {...props}
    />
  );
});
