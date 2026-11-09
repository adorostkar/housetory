import { Component, type ErrorInfo, type ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled Housetory UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center">
        <BrandMark />
        <h1 className="mt-8 font-display text-3xl tracking-[-0.03em]">
          Something interrupted the page.
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
          Your data is safe. Reload Housetory to continue.
        </p>
        <Button className="mt-6" onClick={() => window.location.reload()}>
          Reload Housetory
        </Button>
      </div>
    );
  }
}
