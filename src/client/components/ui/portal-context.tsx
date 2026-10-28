import { createContext, useContext, type ReactNode } from 'react';

const ArbiterPortalContext = createContext<HTMLElement | null>(null);

export interface ArbiterPortalProviderProps {
  readonly container: HTMLElement | null;
  readonly children: ReactNode;
}

export function ArbiterPortalProvider(
  props: ArbiterPortalProviderProps,
): ReactNode {
  return (
    <ArbiterPortalContext.Provider value={props.container}>
      {props.children}
    </ArbiterPortalContext.Provider>
  );
}

export function useArbiterPortalContainer(): HTMLElement | null {
  return useContext(ArbiterPortalContext);
}
