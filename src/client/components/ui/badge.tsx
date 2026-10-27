import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.js';

export const badgeVariants = cva(
  'arb:inline-flex arb:items-center arb:rounded-full arb:border arb:px-2.5 arb:py-0.5 arb:text-xs arb:font-semibold arb:transition-colors arb:focus:outline-none arb:focus:ring-2 arb:focus:ring-ring arb:focus:ring-offset-2',
  {
    variants: {
      tone: {
        default:
          'arb:border-transparent arb:bg-accent arb:text-accent-foreground',
        secondary: 'arb:border-transparent arb:bg-layer-3 arb:text-secondary',
        outline: 'arb:border-border-default arb:text-primary',
        danger: 'arb:border-transparent arb:bg-error/20 arb:text-error',
        success: 'arb:border-transparent arb:bg-success/20 arb:text-success',
        warning: 'arb:border-transparent arb:bg-warning/20 arb:text-warning',
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
  readonly children: ReactNode;
}

export function Badge({ className, tone, ...props }: BadgeProps): ReactNode {
  return <div className={cn(badgeVariants({ tone }), className)} {...props} />;
}
