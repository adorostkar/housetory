import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Loader2,
  Mic,
  RotateCcw,
  Scissors,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useAiStatus,
  useInvalidateInventory,
  useLocations,
  useProperties,
  useRooms,
  useVoiceConfig,
  useVoiceNote,
} from "@/lib/queries";
import type {
  ContainerType,
  DuplicateCandidate,
  Room,
  StorageLocation,
  VoiceApplyEntry,
  VoiceApplyResult,
  VoiceLocation,
  VoiceNote,
  VoiceSuggestion,
  VoiceSuggestionEdit,
} from "@/lib/types";
import { cn, formatFileSize, pluralize } from "@/lib/utils";

const CREATE = "__create__";
const CONTAINER_KINDS: ContainerType[] = ["box", "bin", "crate", "suitcase", "bag", "other"];

interface ReviewState {
  key: string;
  id: string;
  splitOf: string | null;
  include: boolean;
  action: "import" | "skip" | "reject";
  edit: VoiceSuggestionEdit;
  mentionCount: number;
  quantityExplicit: boolean;
  sources: VoiceSuggestion["sources"];
  duplicateCandidates: DuplicateCandidate[];
  warnings: string[];
  roomChoice: string;
  locationChoice: string;
  duplicateResolution: "" | "new" | "add_quantity" | "skip";
  mergeItemId: string;
}

export function VoicePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryPropertyId = searchParams.get("property_id") ?? "";
  const queryRoomId = searchParams.get("room_id") ?? "";
  const queryLocationId = searchParams.get("location_id") ?? "";
  const queryNoteId = searchParams.get("note_id") ?? "";
  const propertiesQuery = useProperties();
  const properties = propertiesQuery.data?.items ?? [];
  const [propertyId, setPropertyId] = React.useState(queryPropertyId);
  const roomsQuery = useRooms(propertyId || undefined);
  const locationsQuery = useLocations();
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const voiceConfig = useVoiceConfig();
  const transcriptionStatus = useAiStatus("transcription");
  const interpretationStatus = useAiStatus("imports");
  const invalidate = useInvalidateInventory();
  const queryClient = useQueryClient();

  const [noteId, setNoteId] = React.useState<string | null>(queryNoteId || null);
  const noteQuery = useVoiceNote(noteId ?? undefined);
  const note = noteQuery.data;
  const [defaultRoomId, setDefaultRoomId] = React.useState(queryRoomId);
  const [defaultLocationId, setDefaultLocationId] = React.useState(queryLocationId);
  const queryDestinationApplied = React.useRef(false);
  const [transcriptDraft, setTranscriptDraft] = React.useState("");
  const transcriptSyncedFor = React.useRef<string | null>(null);
  const [reviews, setReviews] = React.useState<ReviewState[]>([]);
  const [initializedFor, setInitializedFor] = React.useState<string | null>(null);
  const [applyResult, setApplyResult] = React.useState<VoiceApplyResult | null>(null);

  React.useEffect(() => {
    if (queryDestinationApplied.current || !queryLocationId) return;
    const match = locations.find((location) => location.id === queryLocationId);
    if (!match) return;
    queryDestinationApplied.current = true;
    setDefaultRoomId(match.room_id);
    setDefaultLocationId(match.id);
  }, [queryLocationId, locations]);

  React.useEffect(() => {
    if (propertyId) return;
    const room = rooms.find((entry) => entry.id === (queryRoomId || defaultRoomId));
    if (room?.property_id) setPropertyId(room.property_id);
    else if (properties.length === 1) setPropertyId(properties[0]!.id);
  }, [propertyId, properties, queryRoomId, defaultRoomId, rooms]);

  const changeProperty = (value: string) => {
    setPropertyId(value);
    setDefaultRoomId("");
    setDefaultLocationId("");
  };

  React.useEffect(() => {
    if (!note) return;
    if (
      transcriptSyncedFor.current !== note.id &&
      ["transcribed", "review", "confirmed"].includes(note.status) &&
      note.transcript
    ) {
      transcriptSyncedFor.current = note.id;
      setTranscriptDraft(note.transcript);
    }
  }, [note]);

  React.useEffect(() => {
    if (!note || note.status !== "review" || initializedFor === note.id) return;
    setReviews(note.suggestions.map(toReviewState));
    setInitializedFor(note.id);
    setApplyResult(null);
  }, [note, initializedFor]);

  const defaultLocations = locations.filter(
    (location) => location.room_id === defaultRoomId,
  );

  const upload = useMutation({
    mutationFn: ({ file, duration }: { file: File; duration: number | null }) => {
      const formData = new FormData();
      formData.append("file", file);
      if (duration != null) formData.append("duration_seconds", String(duration));
      if (propertyId) formData.append("property_id", propertyId);
      if (defaultRoomId) formData.append("room_id", defaultRoomId);
      if (defaultLocationId) formData.append("location_id", defaultLocationId);
      return api.postForm<VoiceNote>("/voice", formData);
    },
    onSuccess: (created) => {
      setNoteId(created.id);
      setInitializedFor(null);
      setApplyResult(null);
      setTranscriptDraft("");
      transcriptSyncedFor.current = null;
      queryClient.setQueryData(queryKeys.voiceNote(created.id), created);
      navigate(`/voice?note_id=${created.id}`, { replace: true });
      toast.success("Recording uploaded. Transcribing…");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const interpret = useMutation({
    mutationFn: (transcript: string) =>
      api.post<VoiceNote>(`/voice/${noteId}/interpret`, { transcript }),
    onSuccess: (updated) => {
      if (noteId) queryClient.setQueryData(queryKeys.voiceNote(noteId), updated);
      setInitializedFor(null);
      setReviews([]);
      setApplyResult(null);
      toast.success("Transcript sent for inventory interpretation");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const retry = useMutation({
    mutationFn: () => api.post<VoiceNote>(`/voice/${noteId}/transcription/retry`),
    onSuccess: (updated) => {
      if (noteId) queryClient.setQueryData(queryKeys.voiceNote(noteId), updated);
      toast.success("Transcription queued again");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const cancel = useMutation({
    mutationFn: () => api.post<VoiceNote>(`/voice/${noteId}/cancel`),
    onSuccess: (updated) => {
      if (noteId) queryClient.setQueryData(queryKeys.voiceNote(noteId), updated);
      setInitializedFor(null);
      setReviews([]);
      toast.success("Voice note cancelled and its audio deleted");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const confirm = useMutation({
    mutationFn: () => {
      const entries = reviews
        .filter((entry) => entry.include)
        .map(buildApplyEntry);
      return api.post<VoiceApplyResult>(`/voice/${noteId}/confirm`, { entries });
    },
    onSuccess: (result) => {
      if (noteId) queryClient.setQueryData(queryKeys.voiceNote(noteId), result.note);
      setApplyResult(result);
      setInitializedFor(null);
      invalidate();
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiStatus });
      toast.success(
        `${pluralize(result.created, "item")} created · ${result.added_quantity} added to existing · ${result.failed} failed`,
      );
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const updateReview = (key: string, patch: Partial<ReviewState>) => {
    setReviews((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  };

  const updateEdit = (key: string, patch: Partial<VoiceSuggestionEdit>) => {
    setReviews((current) =>
      current.map((entry) =>
        entry.key === key ? { ...entry, edit: { ...entry.edit, ...patch } } : entry,
      ),
    );
  };

  const changeRoom = (key: string, value: string) => {
    setReviews((current) =>
      current.map((entry) => {
        if (entry.key !== key) return entry;
        if (value === CREATE) {
          return {
            ...entry,
            roomChoice: CREATE,
            locationChoice: "",
            edit: {
              ...entry.edit,
              room: createRoomLocation(entry.edit.room),
              storage_location: null,
            },
          };
        }
        const room = rooms.find((candidate) => candidate.id === value);
        if (!room) {
          return {
            ...entry,
            roomChoice: "",
            locationChoice: "",
            edit: { ...entry.edit, room: null, storage_location: null },
          };
        }
        return {
          ...entry,
          roomChoice: room.id,
          locationChoice: "",
          edit: {
            ...entry.edit,
            room: matchedRoomLocation(room),
            storage_location: null,
          },
        };
      }),
    );
  };

  const changeLocation = (key: string, value: string) => {
    setReviews((current) =>
      current.map((entry) => {
        if (entry.key !== key) return entry;
        if (value === CREATE) {
          return {
            ...entry,
            locationChoice: CREATE,
            edit: {
              ...entry.edit,
              storage_location: createStorageLocation(
                entry.edit.storage_location,
                entry.edit.room,
              ),
            },
          };
        }
        const location = locations.find((candidate) => candidate.id === value);
        return {
          ...entry,
          locationChoice: location?.id ?? "",
          edit: {
            ...entry.edit,
            storage_location: location
              ? matchedStorageLocation(location)
              : null,
          },
        };
      }),
    );
  };

  const splitSuggestion = (key: string) => {
    setReviews((current) => {
      const index = current.findIndex((entry) => entry.key === key);
      const target = current[index];
      if (!target || target.edit.quantity <= 1) return current;
      const child: ReviewState = {
        ...target,
        key: crypto.randomUUID(),
        id: crypto.randomUUID(),
        splitOf: target.id,
        include: true,
        edit: {
          ...target.edit,
          id: crypto.randomUUID(),
          split_of: target.id,
          quantity: 1,
        },
      };
      const updated = current.map((entry, entryIndex) =>
        entryIndex === index
          ? {
              ...entry,
              edit: { ...entry.edit, quantity: entry.edit.quantity - 1 },
            }
          : entry,
      );
      return [...updated.slice(0, index + 1), child, ...updated.slice(index + 1)];
    });
  };

  const transcriptionReady = Boolean(transcriptionStatus.data?.configured);
  const interpretationReady = Boolean(interpretationStatus.data?.configured);
  const includedCount = reviews.filter((entry) => entry.include).length;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Add items · Voice"
        title="Record an inventory note"
        description="Speak naturally. Housetory transcribes the recording, proposes grouped items and locations, and writes nothing until you approve the reviewed suggestions."
        actions={
          <Button variant="outline" asChild>
            <Link to="/items">Inventory</Link>
          </Button>
        }
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          {!noteId &&
            (transcriptionReady ? (
              <Recorder
                config={voiceConfig.data}
                transcriptionReady={transcriptionReady}
                transcriptionStatus={transcriptionStatus.data}
                uploadPending={upload.isPending}
                properties={properties}
                propertyId={propertyId}
                onPropertyChange={changeProperty}
                rooms={rooms}
                defaultRoomId={defaultRoomId}
                defaultLocationId={defaultLocationId}
                defaultLocations={defaultLocations}
                onDefaultRoomChange={(roomId) => {
                  setDefaultRoomId(roomId);
                  setDefaultLocationId("");
                }}
                onDefaultLocationChange={setDefaultLocationId}
                onUpload={(file, duration) => upload.mutate({ file, duration })}
              />
            ) : (
              <VoiceSetup status={transcriptionStatus.data} />
            ))}

          {note && (
            <>
              {["queued", "transcribing"].includes(note.status) && (
                <section className="surface flex items-start gap-3 p-5">
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-brass" />
                  <div className="min-w-0">
                    <p className="text-[0.85rem] font-medium">Transcribing the recording…</p>
                    <p className="mt-1 text-[0.74rem] leading-relaxed text-muted-foreground">
                      {note.status === "queued"
                        ? "The recording is queued for the configured transcription provider."
                        : "Audio is being transcribed. The recording is deleted automatically when this succeeds."}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate()}
                    >
                      Cancel and delete audio
                    </Button>
                  </div>
                </section>
              )}

              {note.status === "failed" && (
                <section className="surface border-destructive/25 p-5">
                  <p className="text-[0.85rem] font-medium text-destructive">
                    Transcription failed
                  </p>
                  <p className="mt-1 text-[0.76rem] leading-relaxed text-muted-foreground">
                    {note.transcript_error ||
                      "Try the recording again, or record a clearer note."}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {note.audio_retained && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate()}
                      >
                        {retry.isPending ? <Spinner /> : <RotateCcw />}
                        Retry transcription
                      </Button>
                    )}
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/items/new">Add manually instead</Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate()}
                    >
                      Delete and start over
                    </Button>
                  </div>
                </section>
              )}

              {note.status === "transcribed" && (
                <section className="surface p-5 sm:p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">
                        Edit the transcript
                      </h2>
                      <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">
                        Correct names, counts and rooms before interpretation. The AI never
                        changes inventory from the transcript alone.
                      </p>
                    </div>
                    <Badge variant="outline">Transcript ready</Badge>
                  </div>
                  <Textarea
                    className="mt-4 min-h-[180px]"
                    value={transcriptDraft}
                    maxLength={50_000}
                    onChange={(event) => setTranscriptDraft(event.target.value)}
                    aria-label="Editable voice transcript"
                  />
                  <FormError
                    message={
                      interpret.error
                        ? getApiErrorMessage(interpret.error)
                        : note.interpretation_error
                    }
                  />
                  {!interpretationReady && (
                    <p className="mt-3 rounded-xl border border-brass/25 bg-brass-soft/40 px-3.5 py-2.5 text-[0.73rem] leading-relaxed text-muted-foreground">
                      Inventory interpretation is not configured.{" "}
                      <Link to="/settings/ai" className="font-medium text-foreground underline underline-offset-4">
                        Configure a Smart imports task
                      </Link>{" "}
                      before interpreting. Your transcript is kept.
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      disabled={
                        interpret.isPending ||
                        !transcriptDraft.trim() ||
                        !interpretationReady
                      }
                      onClick={() => interpret.mutate(transcriptDraft.trim())}
                    >
                      {interpret.isPending ? <Spinner /> : <Sparkles />}
                      Interpret inventory
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate()}
                    >
                      Cancel voice note
                    </Button>
                  </div>
                </section>
              )}

              {note.status === "interpreting" && (
                <section className="surface flex items-start gap-3 p-5">
                  <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-brass" />
                  <div>
                    <p className="text-[0.85rem] font-medium">Interpreting the transcript…</p>
                    <p className="mt-1 text-[0.74rem] text-muted-foreground">
                      The configured Smart imports model is proposing items. Nothing is
                      written until you confirm.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate()}
                    >
                      Cancel
                    </Button>
                  </div>
                </section>
              )}

              {note.status === "review" && (
                <section className="space-y-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h2 className="font-display text-[1.55rem] tracking-[-0.025em]">
                        Review {pluralize(reviews.length, "suggestion")}
                      </h2>
                      <p className="mt-1 text-[0.74rem] leading-relaxed text-muted-foreground">
                        Repeated mentions are combined, corrections replace earlier counts,
                        and summary repetition is not counted again. Edit anything before
                        confirmation.
                      </p>
                    </div>
                    <Button
                      disabled={confirm.isPending || includedCount === 0}
                      onClick={() => confirm.mutate()}
                    >
                      {confirm.isPending ? <Spinner /> : <Check />}
                      Confirm selected ({includedCount})
                    </Button>
                  </div>

                  <NoteWarnings warnings={note.warnings} />

                  {reviews.length === 0 && (
                    <section className="surface p-5 text-[0.8rem] leading-relaxed text-muted-foreground">
                      No inventory suggestions were found. Edit the transcript and interpret
                      again, or add the item manually.
                    </section>
                  )}

                  {reviews.map((entry, index) => (
                    <ReviewCard
                      key={entry.key}
                      index={index}
                      entry={entry}
                      rooms={rooms}
                      locations={locations}
                      onChange={(patch) => updateReview(entry.key, patch)}
                      onEdit={(patch) => updateEdit(entry.key, patch)}
                      onRoomChange={(value) => changeRoom(entry.key, value)}
                      onLocationChange={(value) => changeLocation(entry.key, value)}
                      onSplit={() => splitSuggestion(entry.key)}
                    />
                  ))}

                  <details className="surface p-4 sm:p-5">
                    <summary className="cursor-pointer text-[0.8rem] font-medium">
                      Transcript and re-interpret
                    </summary>
                    <p className="mt-2 text-[0.72rem] leading-relaxed text-muted-foreground">
                      Re-interpreting replaces these suggestions. Suggestions you already
                      applied are kept, so finish or undo them first if the transcript is wrong.
                    </p>
                    <Textarea
                      className="mt-3 min-h-[140px]"
                      value={transcriptDraft}
                      onChange={(event) => setTranscriptDraft(event.target.value)}
                      aria-label="Editable voice transcript"
                    />
                    <Button
                      className="mt-3"
                      size="sm"
                      variant="outline"
                      disabled={
                        interpret.isPending ||
                        !transcriptDraft.trim() ||
                        !interpretationReady ||
                        note.suggestions.some((suggestion) => suggestion.state !== "proposed")
                      }
                      onClick={() => interpret.mutate(transcriptDraft.trim())}
                    >
                      {interpret.isPending ? <Spinner /> : <RotateCcw />}
                      Re-interpret transcript
                    </Button>
                  </details>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate()}
                    >
                      Cancel voice note
                    </Button>
                  </div>
                </section>
              )}

              {note.status === "confirmed" && (
                <section className="surface border-sage/30 bg-sage-soft/40 p-5">
                  <p className="flex items-center gap-2 text-[0.9rem] font-medium">
                    <Check className="size-4" /> Voice note applied
                  </p>
                  <p className="mt-1 text-[0.76rem] text-muted-foreground">
                    {pluralize(
                      resultCount(note, "new"),
                      "new item",
                    )}{" "}
                    · {resultCount(note, "add_quantity")} added to existing ·{" "}
                    {note.suggestions.filter((item) => item.state === "skipped").length} skipped
                  </p>
                  <Button className="mt-3" size="sm" asChild>
                    <Link to="/items">View inventory</Link>
                  </Button>
                </section>
              )}

              {note.status === "cancelled" && (
                <section className="surface p-5">
                  <p className="text-[0.85rem] font-medium">This voice note was cancelled.</p>
                  <p className="mt-1 text-[0.75rem] text-muted-foreground">
                    Its audio was deleted. Start a new recording when you are ready.
                  </p>
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setNoteId(null);
                      setReviews([]);
                      setApplyResult(null);
                      setTranscriptDraft("");
                      transcriptSyncedFor.current = null;
                      navigate("/voice", { replace: true });
                    }}
                  >
                    Record another note
                  </Button>
                </section>
              )}
            </>
          )}

          {applyResult && applyResult.note.status !== "confirmed" && (
            <PartialResult result={applyResult} />
          )}

          {noteQuery.isError && (
            <FormError message={getApiErrorMessage(noteQuery.error)} />
          )}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-8">
          <section className="surface p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              How it works
            </h2>
            <ol className="mt-3 space-y-3 text-[0.75rem] leading-relaxed text-muted-foreground">
              <li>
                <strong className="text-foreground/80">1.</strong> Record with microphone
                permission or upload an audio file.
              </li>
              <li>
                <strong className="text-foreground/80">2.</strong> Correct the transcript. The
                transcript is sent to the Smart imports model only after you choose
                Interpret.
              </li>
              <li>
                <strong className="text-foreground/80">3.</strong> Review grouped items,
                quantities, rooms and possible duplicates. Then confirm selected entries.
              </li>
            </ol>
          </section>

          <section className="surface p-5 text-[0.72rem] leading-relaxed text-muted-foreground">
            <p className="flex items-center gap-1.5 font-medium text-foreground/80">
              <AlertTriangle className="size-3.5 text-brass" /> Privacy
            </p>
            <p className="mt-2">
              {transcriptionStatus.data?.data_leaves_server
                ? `Audio is sent to ${transcriptionStatus.data.provider_label ?? transcriptionStatus.data.provider} for transcription.`
                : "Audio is processed by the configured backend and is not sent to a third-party transcription service unless the selected provider is remote."}
            </p>
            <p className="mt-2">
              {interpretationStatus.data?.data_leaves_server
                ? `The editable transcript is sent to ${interpretationStatus.data.provider_label ?? interpretationStatus.data.provider} for interpretation.`
                : "The editable transcript follows the Smart imports task configuration."}
            </p>
            <p className="mt-2">
              {voiceConfig.data?.retention_note ??
                "Audio is deleted after a successful transcript or cancellation."}
            </p>
          </section>

          <section className="surface p-5 text-[0.72rem] leading-relaxed text-muted-foreground">
            <p className="flex items-center gap-1.5 font-medium text-foreground/80">
              <Sparkles className="size-3.5 text-brass" /> Supported audio
            </p>
            <p className="mt-2">
              WebM, Ogg, WAV, MP3 and M4A, up to{" "}
              {voiceConfig.data?.max_upload_mb ?? 15} MB and{" "}
              {voiceConfig.data?.max_duration_seconds ?? 120} seconds. Browsers without a
              supported recorder can upload an audio file instead.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function VoiceSetup({
  status,
}: {
  status: ReturnType<typeof useAiStatus>["data"];
}) {
  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brass-soft text-brass">
          <Mic className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-[1.4rem] tracking-[-0.02em]">
            Voice transcription is not set up
          </h2>
          <p className="mt-1 max-w-xl text-[0.76rem] leading-relaxed text-muted-foreground">
            {status?.error ??
              "Choose a transcription-capable provider and model in AI settings to record or upload a voice note."}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/settings/ai">Configure voice transcription</Link>
            </Button>
            <span className="text-[0.68rem] text-muted-foreground">
              Manual entry, search, photos, documents and imports continue to work.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Recorder({
  config,
  transcriptionReady,
  transcriptionStatus,
  uploadPending,
  properties,
  propertyId,
  onPropertyChange,
  rooms,
  defaultRoomId,
  defaultLocationId,
  defaultLocations,
  onDefaultRoomChange,
  onDefaultLocationChange,
  onUpload,
}: {
  config: ReturnType<typeof useVoiceConfig>["data"];
  transcriptionReady: boolean;
  transcriptionStatus: ReturnType<typeof useAiStatus>["data"];
  uploadPending: boolean;
  properties: Array<{ id: string; name: string }>;
  propertyId: string;
  onPropertyChange: (propertyId: string) => void;
  rooms: Room[];
  defaultRoomId: string;
  defaultLocationId: string;
  defaultLocations: StorageLocation[];
  onDefaultRoomChange: (roomId: string) => void;
  onDefaultLocationChange: (locationId: string) => void;
  onUpload: (file: File, duration: number | null) => void;
}) {
  const maxSeconds = config?.max_duration_seconds ?? 120;
  const maxBytes = (config?.max_upload_mb ?? 15) * 1024 * 1024;
  const [recording, setRecording] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [recorded, setRecorded] = React.useState<File | null>(null);
  const [recordedDuration, setRecordedDuration] = React.useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [micError, setMicError] = React.useState<string | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const discardRef = React.useRef(false);
  const startedAtRef = React.useRef(0);
  const timerRef = React.useRef<number | null>(null);
  const recordedMimeRef = React.useRef("audio/webm");
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  React.useEffect(() => {
    return () => {
      clearTimer();
      discardRef.current = true;
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      stopTracks();
    };
  }, []);

  React.useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const chooseMime = () => {
    const options = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    if (typeof MediaRecorder.isTypeSupported !== "function") return "";
    return options.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
  };

  const stopRecording = React.useCallback(() => {
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    stopTracks();
    setRecording(false);
  }, []);

  const startRecording = async () => {
    setMicError(null);
    setFileError(null);
    if (!window.isSecureContext) {
      setMicError(
        "Microphone access requires HTTPS or localhost. Open Housetory at its secure address, or upload an audio file.",
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicError(
        "This browser cannot record audio. Use the upload option below instead.",
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = chooseMime();
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      recordedMimeRef.current = recorder.mimeType || mime || "audio/webm";
      chunksRef.current = [];
      discardRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopTracks();
        if (discardRef.current) return;
        const blob = new Blob(chunksRef.current, { type: recordedMimeRef.current });
        if (blob.size === 0) {
          setMicError("No audio was captured. Check the microphone and try again.");
          return;
        }
        const extension = extensionForType(recordedMimeRef.current);
        const file = new File([blob], `voice-note.${extension}`, {
          type: recordedMimeRef.current.split(";")[0] || "audio/webm",
        });
        const duration = Math.max(
          1,
          Math.min(maxSeconds, Math.round((Date.now() - startedAtRef.current) / 1000)),
        );
        setRecorded(file);
        setRecordedDuration(duration);
        setPreviewUrl(URL.createObjectURL(blob));
      };
      recorder.start(250);
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecorded(null);
      setRecordedDuration(null);
      setPreviewUrl(null);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
        setElapsed(seconds);
        if (seconds >= maxSeconds) stopRecording();
      }, 250);
    } catch (error) {
      stopTracks();
      const name = error instanceof DOMException ? error.name : "";
      setMicError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission was denied. Allow microphone access in the browser or upload an audio file."
          : name === "NotFoundError"
            ? "No microphone was found. Upload an audio file instead."
            : "The microphone could not be opened. Check browser permissions and try again.",
      );
    }
  };

  const cancelRecording = () => {
    discardRef.current = true;
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stopTracks();
    setRecording(false);
    setRecorded(null);
    setRecordedDuration(null);
    setPreviewUrl(null);
    setElapsed(0);
  };

  const inspectFile = async (file: File) => {
    setMicError(null);
    setFileError(null);
    if (!isSupportedAudioFile(file)) {
      setFileError("Choose a WebM, Ogg, WAV, MP3 or M4A audio file.");
      return;
    }
    if (file.size > maxBytes) {
      setFileError(`Audio files are limited to ${config?.max_upload_mb ?? 15} MB.`);
      return;
    }
    if (file.size < 128) {
      setFileError("This audio file is empty.");
      return;
    }
    const duration = await readAudioDuration(file);
    if (duration != null && duration > maxSeconds) {
      setFileError(`Recordings are limited to ${maxSeconds} seconds.`);
      return;
    }
    setRecorded(file);
    setRecordedDuration(duration);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const submit = () => {
    if (!recorded) return;
    onUpload(recorded, recordedDuration);
  };

  return (
    <section className="surface p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-[1.4rem] tracking-[-0.02em]">
            <Mic className="size-4 text-brass" /> Record or upload
          </h2>
          <p className="mt-1 text-[0.76rem] leading-relaxed text-muted-foreground">
            {transcriptionReady
              ? `Transcription is configured${transcriptionStatus?.model ? ` (${transcriptionStatus.model})` : ""}.`
              : "Transcription is not configured yet."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".webm,.ogg,.wav,.mp3,.m4a,.mp4,audio/*"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void inspectFile(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={recording || uploadPending || !transcriptionReady}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload />
            Upload audio
          </Button>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-dashed border-border bg-secondary/20 p-5 text-center">
        {recorded ? (
          <div className="space-y-3">
            <audio controls src={previewUrl ?? undefined} className="mx-auto w-full max-w-md" />
            <p className="text-[0.74rem] text-muted-foreground">
              {recorded.name} · {formatFileSize(recorded.size)}
              {recordedDuration != null ? ` · ${recordedDuration}s` : ""}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                disabled={uploadPending || !transcriptionReady}
                onClick={submit}
              >
                {uploadPending ? <Spinner /> : <Upload />}
                Upload and transcribe
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={uploadPending}
                onClick={() => {
                  setRecorded(null);
                  setRecordedDuration(null);
                  setPreviewUrl(null);
                }}
              >
                Choose another
              </Button>
            </div>
          </div>
        ) : recording ? (
          <div className="space-y-3">
            <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <Mic className="size-7 animate-pulse" />
            </span>
            <p className="font-display text-2xl tabular-nums tracking-[-0.02em]">
              {formatDuration(elapsed)}
            </p>
            <p className="text-[0.72rem] text-muted-foreground">
              Recording · maximum {formatDuration(maxSeconds)}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={stopRecording}>
                <Square /> Stop
              </Button>
              <Button size="sm" variant="outline" onClick={cancelRecording}>
                <X /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Mic className="size-7" strokeWidth={1.5} />
            </span>
            <p className="text-[0.86rem] font-medium">Speak your inventory note</p>
            <p className="mx-auto max-w-md text-[0.72rem] leading-relaxed text-muted-foreground">
              For example: “Box two has three ethernet cables and one HDMI cable.” The
              recording stays private and is deleted after transcription.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                disabled={!transcriptionReady || uploadPending}
                onClick={() => void startRecording()}
              >
                <Mic /> Start recording
              </Button>
            </div>
          </div>
        )}
      </div>

      {micError && <p className="mt-3 text-[0.75rem] text-destructive" role="alert">{micError}</p>}
      {fileError && <p className="mt-3 text-[0.75rem] text-destructive" role="alert">{fileError}</p>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Property" htmlFor="voice-property">
          <Select
            id="voice-property"
            className="mt-2"
            value={propertyId}
            onChange={(event) => onPropertyChange(event.target.value)}
          >
            <option value="">Choose a property</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default room" htmlFor="voice-room" optional>
          <Select
            id="voice-room"
            className="mt-2"
            value={defaultRoomId}
            onChange={(event) => onDefaultRoomChange(event.target.value)}
          >
            <option value="">No default room</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.property?.name ? `${room.property.name} / ${room.name}` : room.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default container or storage place" htmlFor="voice-location" optional>
          <Select
            id="voice-location"
            className="mt-2"
            value={defaultLocationId}
            disabled={!defaultRoomId}
            onChange={(event) => onDefaultLocationChange(event.target.value)}
          >
            <option value="">
              {defaultRoomId ? "Room only — no container" : "Choose a room first"}
            </option>
            {defaultLocations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.identifier ? `${location.identifier} · ` : ""}
                {location.name}
              </option>
            ))}
          </Select>
        </Field>
        <p className="text-[0.68rem] leading-relaxed text-muted-foreground sm:col-span-2">
          Defaults are used only when the speaker does not state a location. Spoken
          locations are matched against your existing rooms and places first.
        </p>
      </div>

    </section>
  );
}

function ReviewCard({
  index,
  entry,
  rooms,
  locations,
  onChange,
  onEdit,
  onRoomChange,
  onLocationChange,
  onSplit,
}: {
  index: number;
  entry: ReviewState;
  rooms: Room[];
  locations: StorageLocation[];
  onChange: (patch: Partial<ReviewState>) => void;
  onEdit: (patch: Partial<VoiceSuggestionEdit>) => void;
  onRoomChange: (value: string) => void;
  onLocationChange: (value: string) => void;
  onSplit: () => void;
}) {
  const room = entry.edit.room;
  const location = entry.edit.storage_location;
  const selectedRoom =
    entry.roomChoice && entry.roomChoice !== CREATE
      ? rooms.find((candidate) => candidate.id === entry.roomChoice)
      : null;
  const availableLocations = selectedRoom
    ? locations.filter((candidate) => candidate.room_id === selectedRoom.id)
    : [];
  const strongDuplicate = entry.duplicateCandidates.some(
    (candidate) => candidate.score >= 55,
  );
  const resolvedRoomNeedsChoice =
    room != null &&
    room.status !== "matched" &&
    !room.create &&
    entry.roomChoice === "";
  const resolvedLocationNeedsChoice =
    location != null &&
    location.status !== "matched" &&
    !location.create &&
    entry.locationChoice === "";

  return (
    <article
      className={cn(
        "surface p-4 sm:p-5",
        entry.include ? "border-sage/40" : "opacity-75",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-primary"
            checked={entry.include}
            onChange={(event) => onChange({ include: event.target.checked })}
            aria-label={`Include ${entry.edit.name}`}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[0.92rem] font-medium">{entry.edit.name}</h3>
              {entry.mentionCount > 1 && (
                <Badge variant="sage">Combined {entry.mentionCount} mentions</Badge>
              )}
              {entry.quantityExplicit && <Badge variant="brass">Explicit count</Badge>}
              {strongDuplicate && <Badge variant="brass">Possible existing item</Badge>}
              {(resolvedRoomNeedsChoice || resolvedLocationNeedsChoice) && (
                <Badge variant="brass">Location needs review</Badge>
              )}
            </div>
            <p className="mt-1 text-[0.68rem] text-muted-foreground">
              Suggestion {index + 1}
              {entry.splitOf ? " · split record" : ""}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={entry.edit.quantity <= 1}
          onClick={onSplit}
        >
          <Scissors /> Split one
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor={`voice-name-${entry.key}`}>
          <Input
            id={`voice-name-${entry.key}`}
            value={entry.edit.name}
            maxLength={200}
            onChange={(event) => onEdit({ name: event.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity" htmlFor={`voice-qty-${entry.key}`}>
            <Input
              id={`voice-qty-${entry.key}`}
              type="number"
              min={0}
              max={1_000_000}
              value={entry.edit.quantity}
              onChange={(event) =>
                onEdit({ quantity: Math.max(0, Number(event.target.value) || 0) })
              }
            />
          </Field>
          <Field label="Variant" htmlFor={`voice-variant-${entry.key}`} optional>
            <Input
              id={`voice-variant-${entry.key}`}
              value={entry.edit.variant ?? ""}
              maxLength={160}
              onChange={(event) => onEdit({ variant: event.target.value || null })}
            />
          </Field>
        </div>
      </div>

      {entry.sources.length > 0 && (
        <div className="mt-3 rounded-xl border border-border/60 bg-secondary/20 px-3 py-2.5">
          <p className="text-[0.67rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            Transcript evidence
          </p>
          <ul className="mt-1.5 space-y-1">
            {entry.sources.slice(0, 4).map((source, sourceIndex) => (
              <li key={`${entry.key}-source-${sourceIndex}`} className="text-[0.72rem] leading-relaxed">
                <q className="text-foreground/80">{source.text}</q>
                <span className="ml-1 text-muted-foreground">
                  {source.role === "correction"
                    ? "correction"
                    : source.role === "summary"
                      ? "summary"
                      : source.quantity_explicit
                        ? `stated ${source.quantity}`
                        : "item mention"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Room" htmlFor={`voice-room-${entry.key}`}>
          <Select
            id={`voice-room-${entry.key}`}
            className="mt-2"
            value={entry.roomChoice}
            onChange={(event) => onRoomChange(event.target.value)}
          >
            <option value="">Choose a room</option>
            {rooms.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
            <option value={CREATE}>
              Create room{room?.name ? ` “${room.name}”` : ""}
            </option>
          </Select>
          {entry.roomChoice === CREATE && (
            <Input
              className="mt-2"
              aria-label="New room name"
              value={room?.name ?? ""}
              maxLength={120}
              onChange={(event) =>
                onEdit({
                  room: room
                    ? { ...room, name: event.target.value, text: event.target.value }
                    : createRoomLocation(null),
                })
              }
              placeholder="New room name"
            />
          )}
        </Field>
        <Field label="Container or storage place" htmlFor={`voice-location-${entry.key}`}>
          <Select
            id={`voice-location-${entry.key}`}
            className="mt-2"
            value={entry.locationChoice}
            disabled={!entry.roomChoice}
            onChange={(event) => onLocationChange(event.target.value)}
          >
            <option value="">Room only — no container</option>
            {availableLocations.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.identifier ? `${candidate.identifier} · ` : ""}
                {candidate.name}
              </option>
            ))}
            <option value={CREATE}>
              Create box{location?.name ? ` “${location.name}”` : ""}
            </option>
          </Select>
          {entry.locationChoice === CREATE && (
            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_110px] gap-2">
              <Input
                aria-label="New container name"
                value={location?.name ?? ""}
                maxLength={120}
                onChange={(event) =>
                  onEdit({
                    storage_location: location
                      ? { ...location, name: event.target.value, text: event.target.value }
                      : createStorageLocation(null, room),
                  })
                }
                placeholder="New box name"
              />
              <Select
                aria-label="New container type"
                value={location?.create_kind ?? "box"}
                onChange={(event) =>
                  onEdit({
                    storage_location: location
                      ? { ...location, create_kind: event.target.value as ContainerType }
                      : createStorageLocation(null, room),
                  })
                }
              >
                {CONTAINER_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </Field>
      </div>

      {(room?.evidence || location?.evidence) && (
        <div className="mt-3 space-y-1 text-[0.7rem] leading-relaxed text-muted-foreground">
          {room?.evidence && (
            <p>
              Room evidence: <q>{room.evidence}</q>
            </p>
          )}
          {location?.evidence && (
            <p>
              Location evidence: <q>{location.evidence}</q>
            </p>
          )}
        </div>
      )}

      {strongDuplicate && (
        <div className="mt-4 rounded-xl border border-brass/25 bg-brass-soft/40 p-3.5">
          <p className="text-[0.75rem] font-medium">Possible existing stock</p>
          <ul className="mt-1.5 space-y-1 text-[0.71rem] leading-relaxed text-muted-foreground">
            {entry.duplicateCandidates.slice(0, 3).map((candidate) => (
              <li key={candidate.item_id}>
                <strong className="font-medium text-foreground/80">{candidate.name}</strong>
                {candidate.room_name ? ` · ${candidate.room_name}` : ""}
                {candidate.location_name ? ` · ${candidate.location_name}` : ""} ·{" "}
                {candidate.score}% match
              </li>
            ))}
          </ul>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Select
              aria-label={`Duplicate resolution for ${entry.edit.name}`}
              value={entry.duplicateResolution}
              onChange={(event) =>
                onChange({
                  duplicateResolution: event.target.value as ReviewState["duplicateResolution"],
                })
              }
            >
              <option value="">Choose how to handle this</option>
              <option value="new">Create as new item (adds the quantity)</option>
              <option value="add_quantity">Add this quantity to an existing item</option>
              <option value="skip">Already recorded — skip this suggestion</option>
            </Select>
            {entry.duplicateResolution === "add_quantity" && (
              <Select
                aria-label={`Existing item for ${entry.edit.name}`}
                value={entry.mergeItemId}
                onChange={(event) => onChange({ mergeItemId: event.target.value })}
              >
                <option value="">Choose an existing item</option>
                {entry.duplicateCandidates.map((candidate) => (
                  <option key={candidate.item_id} value={candidate.item_id}>
                    {candidate.name} · {candidate.room_name ?? "no room"}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <p className="mt-2 text-[0.68rem] leading-relaxed text-muted-foreground">
            Housetory never increments an existing quantity silently. Choose whether this
            recording describes new stock, extra quantity, or items already recorded.
          </p>
        </div>
      )}

      {entry.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-[0.71rem] leading-relaxed text-brass">
          {entry.warnings.map((warning, warningIndex) => (
            <li key={`${entry.key}-warning-${warningIndex}`}>{warning}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function NoteWarnings({ warnings }: { warnings: VoiceNote["warnings"] }) {
  if (!warnings.length) return null;
  return (
    <div className="space-y-2">
      {warnings.map((warning, index) => (
        <p
          key={`${warning.type}-${index}`}
          className={cn(
            "rounded-xl border px-3.5 py-2.5 text-[0.73rem] leading-relaxed",
            warning.type === "unsupported_move"
              ? "border-brass/30 bg-brass-soft/50 text-muted-foreground"
              : "border-border/70 bg-secondary/25 text-muted-foreground",
          )}
        >
          {warning.type === "unsupported_move" && (
            <AlertTriangle className="mr-1.5 inline size-3.5 text-brass" />
          )}
          {warning.message}
        </p>
      ))}
    </div>
  );
}

function PartialResult({ result }: { result: VoiceApplyResult }) {
  return (
    <section className="surface border-brass/25 p-5">
      <p className="text-[0.85rem] font-medium">Review partially applied</p>
      <p className="mt-1 text-[0.74rem] text-muted-foreground">
        {result.created} created · {result.added_quantity} added to existing ·{" "}
        {result.skipped} skipped · {result.failed} failed. Fix the remaining suggestions
        and confirm again; successful items are never inserted twice.
      </p>
      {result.failures.length > 0 && (
        <ul className="mt-2 space-y-1 text-[0.72rem] text-destructive">
          {result.failures.map((failure) => (
            <li key={failure.suggestion_id}>{failure.message}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function toReviewState(suggestion: VoiceSuggestion): ReviewState {
  return {
    key: suggestion.id,
    id: suggestion.id,
    splitOf: null,
    include: suggestion.quantity > 0 && suggestion.state === "proposed",
    action: "import",
    edit: {
      id: suggestion.id,
      name: suggestion.name,
      description: suggestion.description,
      quantity: suggestion.quantity,
      variant: suggestion.variant,
      category: suggestion.category,
      brand: suggestion.brand,
      model: suggestion.model,
      serial_number: suggestion.serial_number,
      tags: suggestion.tags,
      notes: suggestion.notes,
      room: suggestion.room,
      storage_location: suggestion.storage_location,
      confidence: suggestion.confidence,
      split_of: null,
    },
    mentionCount: suggestion.mention_count,
    quantityExplicit: suggestion.quantity_explicit,
    sources: suggestion.sources,
    duplicateCandidates: suggestion.duplicate_candidates,
    warnings: suggestion.warnings,
    roomChoice: suggestion.room?.matched_id ?? "",
    locationChoice: suggestion.storage_location?.matched_id ?? "",
    duplicateResolution: "",
    mergeItemId: suggestion.duplicate_candidates[0]?.item_id ?? "",
  };
}

function buildApplyEntry(entry: ReviewState): VoiceApplyEntry {
  return {
    ...entry.edit,
    id: entry.id,
    split_of: entry.splitOf,
    action: entry.action,
    duplicate_resolution:
      entry.duplicateResolution === "" ? null : entry.duplicateResolution,
    merge_item_id:
      entry.duplicateResolution === "add_quantity" ? entry.mergeItemId || null : null,
  };
}

function matchedRoomLocation(room: Room): VoiceLocation {
  return {
    text: room.name,
    entity_type: "room",
    identifier: null,
    status: "matched",
    matched_id: room.id,
    name: room.name,
    room_id: room.id,
    parent_id: room.parent_id,
    suggested_parent_id: null,
    candidates: [],
    evidence: null,
    create: false,
    create_kind: "box",
  };
}

function createRoomLocation(source: VoiceLocation | null): VoiceLocation {
  const name = source?.name ?? source?.text ?? "";
  return {
    text: name,
    entity_type: "room",
    identifier: null,
    status: "missing",
    matched_id: null,
    name,
    room_id: null,
    parent_id: source?.parent_id ?? null,
    suggested_parent_id: null,
    candidates: [],
    evidence: source?.evidence ?? null,
    create: true,
    create_kind: "box",
  };
}

function matchedStorageLocation(location: StorageLocation): VoiceLocation {
  return {
    text: location.name,
    entity_type: "storage_location",
    identifier: location.identifier,
    status: "matched",
    matched_id: location.id,
    name: location.name,
    room_id: location.room_id,
    parent_id: location.parent_id,
    suggested_parent_id: null,
    candidates: [],
    evidence: null,
    create: false,
    create_kind: location.container_type ?? "box",
  };
}

function createStorageLocation(
  source: VoiceLocation | null,
  room: VoiceLocation | null,
): VoiceLocation {
  const name = source?.name ?? source?.text ?? "Box";
  return {
    text: name,
    entity_type: "storage_location",
    identifier: null,
    status: "missing",
    matched_id: null,
    name,
    room_id: room?.matched_id ?? null,
    parent_id: null,
    suggested_parent_id: null,
    candidates: [],
    evidence: source?.evidence ?? null,
    create: true,
    create_kind: source?.create_kind ?? "box",
  };
}

function resultCount(note: VoiceNote, resolution: string): number {
  return note.applied_items.filter(
    (item) => (item as { resolution?: string }).resolution === resolution,
  ).length;
}

function isSupportedAudioFile(file: File): boolean {
  if (/\.(webm|ogg|wav|mp3|m4a|mp4)$/i.test(file.name)) return true;
  return file.type.startsWith("audio/");
}

function extensionForType(mime: string): string {
  const lowered = mime.toLowerCase();
  if (lowered.includes("mp4")) return "m4a";
  if (lowered.includes("ogg")) return "ogg";
  if (lowered.includes("wav")) return "wav";
  if (lowered.includes("mpeg") || lowered.includes("mp3")) return "mp3";
  return "webm";
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function readAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      audio.removeAttribute("src");
      resolve(value);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? Math.round(audio.duration) : null;
      finish(duration && duration > 0 ? duration : null);
    };
    audio.onerror = () => finish(null);
    audio.src = url;
    window.setTimeout(() => finish(null), 2000);
  });
}
