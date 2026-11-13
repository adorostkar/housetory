import * as React from "react";
import { useLocation } from "react-router-dom";

import { useSession } from "@/lib/queries";

export interface AssistantPageReference {
  kind: "item" | "document" | "room" | "location";
  id: string;
  name: string;
}

interface PageContextValue {
  references: AssistantPageReference[];
  setReferences: (references: AssistantPageReference[]) => void;
}

const PageContext = React.createContext<PageContextValue | null>(null);

export function AssistantPageContextProvider({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const householdId = useSession().data?.household?.id ?? "";
  const lastPage = React.useRef(pathname);
  if (pathname !== "/assistant") lastPage.current = pathname;
  const page = pathname === "/assistant" ? lastPage.current : pathname;
  const [registered, setRegistered] = React.useState<{
    page: string;
    householdId: string;
    references: AssistantPageReference[];
  } | null>(null);
  const references = registered?.page === page && registered.householdId === householdId
    ? registered.references
    : [];
  const setReferences = React.useCallback((next: AssistantPageReference[]) => {
    setRegistered({ page, householdId, references: next });
  }, [page, householdId]);
  const value = React.useMemo(() => ({ references, setReferences }), [references, setReferences]);
  return <PageContext.Provider value={value}>{children}</PageContext.Provider>;
}

export function useAssistantPageContext() {
  const context = React.useContext(PageContext);
  if (!context) throw new Error("AssistantPageContextProvider is required");
  return context;
}

export function useRegisterAssistantPageContext(references: AssistantPageReference[]) {
  const context = React.useContext(PageContext);
  const signature = JSON.stringify(references);
  const current = React.useRef(references);
  current.current = references;
  React.useEffect(() => {
    context?.setReferences(current.current);
  }, [context?.setReferences, signature]);
}
