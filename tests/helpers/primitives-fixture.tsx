/**
 * Test-only stand-in for the host's browser primitives.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is not an installed package: the web
 * shell publishes it in its platform seed table and plugin bundles resolve it
 * through the module loader. Vitest never runs that loader, so the `ui` project
 * aliases the specifier here.
 *
 * The fixture reproduces two things the selector's tests actually depend on and
 * nothing else:
 *
 *   - `Menu` renders a `role="menu"` with `role="menuitem"` rows, draws the
 *     selected row's state through `data-selected` (the real component marks it
 *     with a class and exposes no ARIA state, which is a known, accepted
 *     trade-off), calls `onSelect`, and closes on `Escape`;
 *   - `RiskConfirmation` renders a `role="dialog"` with the acknowledgement
 *     checkbox and the cancel / confirm actions, all caller-supplied copy.
 *
 * It deliberately does NOT portal, animate or reproduce the host's visuals: the
 * pinned-host E2E run is the only proof that the real components look and behave
 * natively. A mismatch surfaces there, not here.
 */
import type { ReactNode } from 'react';

export interface HostMenuItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}

export interface HostMenuProps {
  readonly open: boolean;
  readonly anchor: ReactNode;
  readonly items?: readonly (
    HostMenuItem | { readonly type: 'separator'; readonly id: string }
  )[];
  readonly selectedId?: string | undefined;
  readonly onSelect?: (id: string) => void;
  readonly onClose: () => void;
  readonly side?: string;
  readonly align?: string;
  readonly portal?: boolean;
  readonly compact?: boolean;
  readonly children?: ReactNode;
}

function isSeparator(
  item: HostMenuItem | { readonly type: 'separator'; readonly id: string },
): item is { readonly type: 'separator'; readonly id: string } {
  return 'type' in item;
}

export function Menu(props: HostMenuProps) {
  return (
    <span>
      {props.anchor}
      {props.open ? (
        <div
          role="menu"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') props.onClose();
          }}
        >
          {(props.items ?? []).map((item) =>
            isSeparator(item) ? (
              <div key={item.id} role="separator" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                data-selected={
                  item.id === props.selectedId ? 'true' : undefined
                }
                data-danger={item.danger === true ? 'true' : undefined}
                onClick={() => {
                  props.onSelect?.(item.id);
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </span>
  );
}

export interface HostRiskConfirmationProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly acknowledgeLabel: string;
  readonly cancelLabel: string;
  readonly closeLabel: string;
  readonly confirmLabel: string;
  readonly acknowledged: boolean;
  readonly disabled?: boolean;
  readonly onAcknowledgedChange: (value: boolean) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function RiskConfirmation(props: HostRiskConfirmationProps) {
  if (!props.open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={props.title}>
      <p>{props.description}</p>
      <label>
        <input
          type="checkbox"
          checked={props.acknowledged}
          disabled={props.disabled === true}
          onChange={(event) => {
            props.onAcknowledgedChange(event.target.checked);
          }}
        />
        <span>{props.acknowledgeLabel}</span>
      </label>
      <button type="button" onClick={props.onCancel}>
        {props.cancelLabel}
      </button>
      <button
        type="button"
        disabled={!props.acknowledged}
        onClick={props.onConfirm}
      >
        {props.confirmLabel}
      </button>
    </div>
  );
}

export interface HostIconProps {
  readonly size?: number;
  readonly className?: string;
  readonly strokeWidth?: number;
}

function glyph(name: string) {
  return function Icon(_props: HostIconProps) {
    return <span data-icon={name} aria-hidden="true" />;
  };
}

export const IconChevronDownOutlineRegular = glyph('chevron-down');
export const PermissionIconReadOnlyRegular = glyph('read-only');
export const PermissionIconWorkspaceWriteRegular = glyph('workspace-write');
export const PermissionIconFullAccessRegular = glyph('full-access');
export const PermissionIconAutoReviewRegular = glyph('auto-review');
