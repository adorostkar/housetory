import * as React from "react";
import { useLocation } from "react-router-dom";

/** Scrolls to the element named by the URL hash once the page content is ready. */
export function useScrollToHash(ready = true) {
  const location = useLocation();
  React.useEffect(() => {
    if (!ready || !location.hash) return;
    document
      .getElementById(location.hash.slice(1))
      ?.scrollIntoView?.({ block: "start" });
  }, [ready, location.hash, location.key]);
}
