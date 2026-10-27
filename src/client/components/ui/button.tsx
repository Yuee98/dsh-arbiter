import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ElementType, ReactNode } from 'react';
import { forwardRef } from 'react';
import { cn } from './cn.js';
import { Tooltip } from './tooltip.js';

export const buttonVariants = cva(
  'arb:inline-flex arb:items-center arb:justify-center arb:gap-1.5 arb:rounded arb:text-xs arb:font-medium arb:transition-colors arb:focus-visible:outline-none arb:focus-visible:ring-1 arb:focus-visible:ring-accent arb:disabled:pointer-events-none arb:disabled:opacity-50',
  {
    variants: {
      tone: {
        default:
          'arb:border arb:border-border-default arb:bg-layer-3 arb:text-primary arb:hover:bg-layer-4',
        primary:
          'arb:border arb:border-accent arb:bg-accent arb:text-accent-foreground arb:hover:opacity-90',
        danger:
          'arb:border arb:border-error arb:bg-layer-3 arb:text-error arb:hover:bg-error arb:hover:text-white',
        ghost:
          'arb:border-transparent arb:bg-transparent arb:text-secondary arb:hover:bg-layer-3 arb:hover:text-primary',
      },
      size: {
        sm: 'arb:h-7 arb:px-2 arb:py-1',
        md: 'arb:h-8 arb:px-3 arb:py-1.5',
        icon: 'arb:h-7 arb:w-7 arb:p-1',
      },
    },
    defaultVariants: {
      tone: 'default',
      size: 'md',
    },
  },
);

export interface IconButtonProps
  extends
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'>,
    VariantProps<typeof buttonVariants> {
  readonly label: string;
  readonly icon?: ElementType<{ className?: string | undefined }> | undefined;
  readonly children?: ReactNode | undefined;
  readonly tooltip?: ReactNode | undefined;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon: Icon,
      children,
      tooltip,
      className,
      tone = 'ghost',
      size = 'icon',
      type = 'button',
      disabled = false,
      ...props
    },
    ref,
  ) {
    const button = (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        disabled={disabled}
        className={cn(buttonVariants({ tone, size, className }))}
        {...props}
      >
        {Icon !== undefined ? <Icon className="arb:h-4 arb:w-4" /> : null}
        {children}
      </button>
    );

    if (disabled || tooltip === false) {
      return button;
    }

    return <Tooltip content={tooltip ?? label}>{button}</Tooltip>;
  },
);
