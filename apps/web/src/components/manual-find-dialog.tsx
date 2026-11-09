import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Download,
  ExternalLink,
  FileWarning,
  Globe2,
  Loader2,
  Pencil,
  Search,
  ShieldCheck,
  Upload,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useInvalidateInventory,
  useItemManuals,
  useManualCandidates,
} from "@/lib/queries";
import type {
  ItemDetail,
  ManualCandidateList,
  ManualDownloadResult,
  ManualProfile,
  ManualSearchCandidate,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";

function requestIdFor(store: React.MutableRefObject<Record<string, string>>, key: string) {
  if (store.current[key]) return store.current[key];
  const generated =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  store.current[key] = generated;
  return generated;
}

function identityLabel(profile: ManualProfile) {
  return [profile.manufacturer, profile.model_identifier, profile.variant]
    .filter(Boolean)
    .join(" · ");
}

export function ManualFindDialog({
  item,
  open,
  onOpenChange,
  onUploadManual,
}: {
  item: ItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploadManual: () => void;
}) {
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();
  const manualsQuery = useItemManuals(open ? item.id : undefined);
  const candidatesQuery = useManualCandidates(item.id, open);
  const requestIds = React.useRef<Record<string, string>>({});

  const [manufacturer, setManufacturer] = React.useState("");
  const [modelIdentifier, setModelIdentifier] = React.useState("");
  const [variant, setVariant] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [editingIdentity, setEditingIdentity] = React.useState(false);
  const [reviewingId, setReviewingId] = React.useState<string | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = React.useState(false);
  const [duplicateNotice, setDuplicateNotice] = React.useState<string | null>(null);

  const status = manualsQuery.data?.search;
  const profile = status?.profile ?? null;
  const candidates = candidatesQuery.data?.candidates ?? [];
  const notices = candidatesQuery.data?.notices ?? [];

  React.useEffect(() => {
    if (!open) {
      setEditingIdentity(false);
      setReviewingId(null);
      setReviewConfirmed(false);
      setDuplicateNotice(null);
      return;
    }
    if (profile) {
      setManufacturer(profile.manufacturer);
      setModelIdentifier(profile.model_identifier);
      setVariant(profile.variant ?? "");
      setConfirmed(true);
      setEditingIdentity(false);
    } else {
      setManufacturer(item.brand ?? "");
      setModelIdentifier(item.model ?? "");
      setVariant("");
      setConfirmed(false);
      setEditingIdentity(true);
    }
    // Only re-initialise when the dialog opens or the confirmed profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile?.id, profile?.manufacturer, profile?.model_identifier, profile?.variant]);

  const saveProfile = useMutation({
    mutationFn: () =>
      api.put<ManualProfile>(`/items/${item.id}/manual-profile`, {
        manufacturer,
        model_identifier: modelIdentifier,
        variant: variant.trim() || null,
        confirmed,
      }),
    onSuccess: () => {
      toast.success("Exact product identity confirmed");
      setEditingIdentity(false);
      setConfirmed(true);
      invalidate();
      void manualsQuery.refetch();
    },
  });

  const search = useMutation({
    mutationFn: () => api.post<ManualCandidateList>(`/items/${item.id}/manual-search`),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.itemManualCandidates(item.id), data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.itemManuals(item.id) });
      if (data.candidates.length === 0) {
        toast.message("No exact-model candidates were found", {
          description:
            "Upload a manual from the manufacturer or try another confirmed variant.",
        });
      }
    },
  });

  const download = useMutation({
    mutationFn: (candidate: ManualSearchCandidate) =>
      api.post<ManualDownloadResult>(
        `/items/${item.id}/manual-search/${candidate.id}/download`,
        {
          request_id: requestIdFor(requestIds, candidate.id),
          confirm_model: true,
        },
      ),
    onSuccess: (result) => {
      invalidate();
      void candidatesQuery.refetch();
      setReviewingId(null);
      setReviewConfirmed(false);
      setDuplicateNotice(
        result.duplicate_documents.length > 0
          ? `The same file was already stored as “${result.duplicate_documents[0]?.title ?? "an existing manual"}”. The existing private copy was reused and linked to this item.`
          : null,
      );
      toast.success("Manual saved and attached");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const searchDisabled =
    !status?.configured || !profile || search.isPending || manualsQuery.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Find a manual for {item.name}</DialogTitle>
          <DialogDescription>
            Online discovery and download stay locked until you confirm the exact manufacturer
            and complete model identifier. Similar products are never treated as compatible.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto overscroll-contain pr-1">
          <section className="rounded-xl border border-border/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Confirmed product identity
                </h3>
                {profile && !editingIdentity ? (
                  <p className="mt-1 text-sm font-medium">{identityLabel(profile)}</p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Enter what is printed on the tool or its rating plate. Recorded item fields
                    are suggestions only and are not changed here.
                  </p>
                )}
              </div>
              {profile && !editingIdentity && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingIdentity(true)}
                >
                  <Pencil />
                  Edit identity
                </Button>
              )}
            </div>

            {(!profile || editingIdentity) && (
              <form
                className="mt-4 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveProfile.mutate();
                }}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Manufacturer" htmlFor="manual-manufacturer">
                    <Input
                      id="manual-manufacturer"
                      value={manufacturer}
                      maxLength={120}
                      onChange={(event) => setManufacturer(event.target.value)}
                      placeholder="DeWalt"
                      disabled={saveProfile.isPending}
                    />
                  </Field>
                  <Field
                    label="Complete model identifier"
                    htmlFor="manual-model"
                    hint="As printed on the label"
                  >
                    <Input
                      id="manual-model"
                      value={modelIdentifier}
                      maxLength={120}
                      onChange={(event) => setModelIdentifier(event.target.value)}
                      placeholder="DCD791"
                      disabled={saveProfile.isPending}
                    />
                  </Field>
                  <Field
                    label="Variant / revision"
                    htmlFor="manual-variant"
                    optional
                    hint="Regional or hardware suffix"
                  >
                    <Input
                      id="manual-variant"
                      value={variant}
                      maxLength={120}
                      onChange={(event) => setVariant(event.target.value)}
                      placeholder="Z, 3rd revision"
                      disabled={saveProfile.isPending}
                    />
                  </Field>
                </div>

                <label className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2.5 text-2xs leading-relaxed">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    disabled={saveProfile.isPending}
                  />
                  <span>
                    I checked the physical item or its label. This is the complete model, and
                    any regional, hardware or revision variant is recorded above.
                  </span>
                </label>

                {saveProfile.error && (
                  <FormError message={getApiErrorMessage(saveProfile.error)} />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      saveProfile.isPending ||
                      !confirmed ||
                      !manufacturer.trim() ||
                      !modelIdentifier.trim()
                    }
                  >
                    {saveProfile.isPending ? <Spinner /> : <Check />}
                    Save confirmed identity
                  </Button>
                  {profile && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingIdentity(false)}
                      disabled={saveProfile.isPending}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  Generic labels such as “Heavy drill” and unconfirmed fragments are rejected
                  by the server. Completeness means the manufacturer-specific identity you
                  verified, not a pattern such as “must contain a digit”. Saving identity never
                  edits the item.
                </p>
              </form>
            )}

            {profile && !editingIdentity && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                <Badge variant="sage">
                  <ShieldCheck className="mr-1 size-3" />
                  Confirmed
                </Badge>
                <span>Confirmed {formatDate(profile.confirmed_at)}</span>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-border/70 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-1.5 text-xs font-medium">
                  <Globe2 className="size-3.5 text-muted-foreground" />
                  Reviewed online search
                </h3>
                <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                  Only manufacturer, complete model, variant and (for questions) the question
                  are sent. Search results are saved for review; nothing downloads until you
                  confirm a specific candidate.
                </p>
                {status?.configured && status.provider_label && (
                  <p className="mt-1 text-2xs text-muted-foreground">
                    Provider: <span className="font-medium">{status.provider_label}</span>. No
                    provider request is made until you press Search.
                  </p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setDuplicateNotice(null);
                  search.mutate();
                }}
                disabled={searchDisabled}
              >
                {search.isPending ? <Loader2 className="animate-spin" /> : <Search />}
                Search for exact model
              </Button>
            </div>

            {!status?.configured && (
              <div className="mt-3 rounded-lg border border-border/60 bg-secondary/25 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                {status?.reason ??
                  "No real online search capability is configured. Manual upload and attached-manual questions still work."}
              </div>
            )}
            {status?.configured && !profile && (
              <div className="mt-3 rounded-lg border border-brass/25 bg-brass-soft/25 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                Confirm the exact product identity above before searching online.
              </div>
            )}
            {search.error && (
              <div className="mt-3">
                <FormError message={getApiErrorMessage(search.error)} />
              </div>
            )}
            {!search.isPending && notices.length > 0 && (
              <ul className="mt-3 space-y-1 text-2xs leading-relaxed text-muted-foreground">
                {notices.map((notice, index) => (
                  <li key={`${notice}-${index}`}>{notice}</li>
                ))}
              </ul>
            )}

            {candidates.length > 0 && (
              <ul className="mt-4 space-y-3">
                {candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <CandidateCard
                      candidate={candidate}
                      identity={profile ? identityLabel(profile) : "the confirmed item"}
                      reviewing={reviewingId === candidate.id}
                      reviewConfirmed={reviewConfirmed}
                      downloadPending={
                        download.isPending && reviewingId === candidate.id
                      }
                      onReview={() => {
                        setReviewingId(candidate.id);
                        setReviewConfirmed(false);
                      }}
                      onCancel={() => {
                        setReviewingId(null);
                        setReviewConfirmed(false);
                      }}
                      onConfirmChange={setReviewConfirmed}
                      onDownload={() => download.mutate(candidate)}
                      onUploadManual={() => {
                        onOpenChange(false);
                        onUploadManual();
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}

            {duplicateNotice && (
              <div className="mt-3 rounded-lg border border-brass/25 bg-brass-soft/30 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                {duplicateNotice}
              </div>
            )}
            {download.error && (
              <div className="mt-3">
                <FormError message={getApiErrorMessage(download.error)} />
              </div>
            )}
          </section>

          <p className="text-2xs leading-relaxed text-muted-foreground">
            Downloaded files are stored privately with their source URL, publisher evidence and
            retrieval date. Only PDF manuals from public HTTP(S) sources are accepted.{" "}
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onUploadManual();
              }}
              className="underline underline-offset-4 hover:text-foreground"
            >
              Upload a manual instead
            </button>
            .
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateCard({
  candidate,
  identity,
  reviewing,
  reviewConfirmed,
  downloadPending,
  onReview,
  onCancel,
  onConfirmChange,
  onDownload,
  onUploadManual,
}: {
  candidate: ManualSearchCandidate;
  identity: string;
  reviewing: boolean;
  reviewConfirmed: boolean;
  downloadPending: boolean;
  onReview: () => void;
  onCancel: () => void;
  onConfirmChange: (value: boolean) => void;
  onDownload: () => void;
  onUploadManual: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-background/35 p-3",
        reviewing && "border-brass/40 bg-brass-soft/15",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            candidate.source_type === "manufacturer"
              ? "sage"
              : candidate.source_type === "official"
                ? "outline"
                : "secondary"
          }
        >
          {candidate.source_type === "manufacturer"
            ? "Manufacturer"
            : candidate.source_type === "official"
              ? "Official source"
              : "Other source"}
        </Badge>
        {candidate.publisher && <span className="text-2xs">{candidate.publisher}</span>}
        {candidate.language && (
          <span className="text-2xs text-muted-foreground">
            {candidate.language}
          </span>
        )}
        <span className="text-2xs text-muted-foreground">
          Retrieved {formatDate(candidate.retrieved_at)}
        </span>
        {candidate.document_id && <Badge variant="sage">Saved</Badge>}
      </div>

      <a
        href={candidate.source_url}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-flex min-w-0 items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
      >
        <span className="break-words">{candidate.title}</span>
        <ExternalLink className="size-3 shrink-0" />
      </a>

      {candidate.model_coverage.length > 0 && (
        <p className="mt-1 text-2xs text-muted-foreground">
          Model evidence: {candidate.model_coverage.join(", ")}
        </p>
      )}
      {candidate.snippet && (
        <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
          {candidate.snippet}
        </p>
      )}
      <p className="mt-1 break-all text-2xs text-muted-foreground">
        {candidate.source_url}
      </p>
      {candidate.direct_file && candidate.file_url !== candidate.source_url && (
        <p className="mt-0.5 break-all text-2xs text-muted-foreground">
          PDF:{" "}
          <a
            href={candidate.file_url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {candidate.file_url}
          </a>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {candidate.document_id ? (
          <Button type="button" size="sm" variant="outline" asChild>
            <Link to={`/documents/${candidate.document_id}`}>Open saved manual</Link>
          </Button>
        ) : !candidate.direct_file ? (
          <>
            <Badge variant="outline">
              <FileWarning className="mr-1 size-3" />
              Source page only
            </Badge>
            <p className="w-full text-2xs leading-relaxed text-muted-foreground">
              No actual PDF link was found on this source page. Open it yourself or upload the
              manual you trust; Housetory will not guess a PDF address.
            </p>
            <Button type="button" size="sm" variant="outline" asChild>
              <a href={candidate.source_url} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open source page
              </a>
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onUploadManual}>
              <Upload />
              Upload manual
            </Button>
          </>
        ) : reviewing ? (
          <>
            <label className="flex w-full items-start gap-2 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-2xs leading-relaxed">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
                checked={reviewConfirmed}
                onChange={(event) => onConfirmChange(event.target.checked)}
                disabled={downloadPending}
              />
              <span>
                I reviewed this candidate and verified that it covers {identity}. I understand
                the server accepts only a PDF from a public source and stores it privately with
                this provenance.
              </span>
            </label>
            <Button
              type="button"
              size="sm"
              onClick={onDownload}
              disabled={!reviewConfirmed || downloadPending}
            >
              {downloadPending ? <Loader2 className="animate-spin" /> : <Download />}
              Download &amp; attach
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onCancel}
              disabled={downloadPending}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={onReview}>
            <ShieldCheck />
            Review &amp; download
          </Button>
        )}
      </div>
    </div>
  );
}
