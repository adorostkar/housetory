import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "@/App";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeProvider } from "@/components/theme-provider";
import { ApiError, householdScopedQueryHash } from "@/lib/api";
import { NavigationGuardProvider } from "@/lib/navigation-guard";
import { startOffline } from "@/lib/offline/controller";
import "@/styles/globals.css";

// Before the first request: it decides if that request can be answered from the copy.
startOffline();

const queryClient = new QueryClient({
  defaultOptions: {
    // Requests are always made, also when the browser says it is offline. The
    // API client then answers from the offline copy, or fails at once. Without
    // this, reads would wait and changes would be sent later without a word.
    mutations: { networkMode: "always" },
    queries: {
      networkMode: "always",
      queryKeyHashFn: householdScopedQueryHash,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 1;
      },
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ErrorBoundary>
          <BrowserRouter>
            <NavigationGuardProvider>
              <App />
            </NavigationGuardProvider>
          </BrowserRouter>
        </ErrorBoundary>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        // A worker that was active before this page loaded (after a forced
        // reload, for one) does not take the page by itself. Ask it to, so the
        // app can be opened from the device the next time.
        if (!navigator.serviceWorker.controller) {
          registration.active?.postMessage({ type: "housetory-claim" });
        }
      })
      .catch((error: unknown) => {
        console.warn("Housetory service worker registration failed", error);
      });
  });
}
