import { ImportDetailPage } from "@/pages/import-detail-page";

export function AssistantImportReview({ id, enabled }: { id: string; enabled: boolean }) {
  if (!enabled) return null;
  return (
    <section className="surface max-h-[60vh] overflow-y-auto p-4 sm:p-5" aria-label="Assistant item review">
      <ImportDetailPage batchId={id} embedded />
    </section>
  );
}
