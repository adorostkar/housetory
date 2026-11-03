import { BrandMark } from "@/components/brand-mark";
import { ErrorState } from "@/components/error-state";

export function BootScreen() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center animate-fade-in">
        <BrandMark className="scale-110" />
        <p className="mt-6 text-[0.78rem] text-muted-foreground">Opening your home…</p>
      </div>
    </div>
  );
}

export function BootError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-5">
      <ErrorState
        title="Housetory can't reach its server"
        message="Check that the API container is running, then try again."
        onRetry={onRetry}
        className="w-full max-w-lg"
      />
    </div>
  );
}
