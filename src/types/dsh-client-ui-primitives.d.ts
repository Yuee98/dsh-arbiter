/**
 * Minimal ambient declaration for the host's
 * `@deepseek-ai/dsh-client-ui-primitives` surface used by the permission
 * selector.
 *
 * The package is not published as a dependency of this plugin: it lives in the
 * web shell's platform seed table (`staticModules`), where a plugin bundle
 * resolves it through the module loader's `require`. Only the pieces this
 * plugin calls are declared here, mirroring the shapes the pinned host
 * (DSH 0.2.1-rc.3) actually renders:
 *
 *   - `Menu` owns the popup, its positioning, the selected highlight and the
 *     keyboard model. It deliberately offers no per-item description slot and
 *     no accessible name, which is why the selector passes no `aria-label`.
 *   - `RiskConfirmation` owns the modal, the acknowledgement checkbox and the
 *     portal to `document.body`. Every visible string is a caller-supplied
 *     prop, so the plugin keeps its own localized copy.
 *   - The icons are plain components; only size and class participate.
 *
 * Adding the real package later must not change these call sites.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react';

  /** One selectable row. `submenu` and `shortcut` are unused here. */
  export interface HostMenuItem {
    readonly id: string;
    readonly label: ReactNode;
    readonly icon?: ReactNode;
    readonly danger?: boolean;
    readonly disabled?: boolean;
  }

  /** A row that is not selectable; `type` separates rules from text. */
  export interface HostMenuSeparator {
    readonly type: 'separator';
    readonly id: string;
  }

  export interface HostMenuProps {
    readonly open: boolean;
    /**
     * The caller's own trigger node.
     *
     * `Menu` does not style it: the host's selector builds its own button, and
     * so does this plugin.
     */
    readonly anchor: ReactNode;
    readonly items?: readonly HostMenuItem[];
    /** The row drawn with the selected treatment; `undefined` selects none. */
    readonly selectedId?: string | undefined;
    readonly onSelect?: (id: string) => void;
    readonly onClose: () => void;
    readonly side?: 'top' | 'bottom' | 'left' | 'right';
    readonly align?: 'start' | 'end';
    /** Render into a portal; the audit host's own selector uses this. */
    readonly portal?: boolean;
    readonly compact?: boolean;
    readonly children?: ReactNode;
  }

  export const Menu: ComponentType<HostMenuProps>;

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

  export const RiskConfirmation: ComponentType<HostRiskConfirmationProps>;

  /** Shared props of the outline glyphs (14px at the host's scale). */
  export interface HostIconProps {
    readonly size?: number;
    readonly className?: string;
    readonly strokeWidth?: number;
  }

  export type HostIcon = ComponentType<HostIconProps>;

  export const IconChevronDownOutlineRegular: HostIcon;
  export const PermissionIconReadOnlyRegular: HostIcon;
  export const PermissionIconWorkspaceWriteRegular: HostIcon;
  export const PermissionIconFullAccessRegular: HostIcon;
  export const PermissionIconAutoReviewRegular: HostIcon;
}
