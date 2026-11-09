import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  ChevronDown,
  ImagePlus,
  Link2,
  MapPin,
  Mic,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { FormError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { formatDuration, useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { api, getApiErrorMessage } from "@/lib/api";
import { appendOrigin, itemOrigin } from "@/lib/navigation";
import {
  queryKeys,
  useAiStatus,
  useLocations,
  useProperties,
  useRecognition,
  useRooms,
  useVoiceConfig,
  useVoiceNote,
} from "@/lib/queries";
import type { AiRecognition, ImportBatchDetail, VoiceNote } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface SmartAddContext {
  propertyId?: string;
  roomId?: string;
  locationId?: string;
  roomName?: string;
  locationName?: string;
}

export type InputKind = "empty" | "text" | "link" | "photo" | "photo-note" | "conflict";

const LINK_PATTERN = /^https?:\/\/\S+$/;

export function detectInputKind(text: string, hasPhoto: boolean): InputKind {
  const trimmed = text.trim();
  const isLink = LINK_PATTERN.test(trimmed);
  if (hasPhoto) {
    if (isLink) return "conflict";
    return trimmed ? "photo-note" : "photo";
  }
  if (isLink) return "link";
  return trimmed ? "text" : "empty";
}

const KIND_LABEL: Record<InputKind, string | null> = {
  empty: null,
  text: "Text",
  link: "Link",
  photo: "Photo",
  "photo-note": "Photo + note",
  conflict: null,
};

export const CONFLICT_MESSAGE = "A link can't be read together with a photo — remove one.";
export const VOICE_NOT_CONFIGURED = "Voice needs transcription — set up in AI settings";
export const VOICE_HAS_CONTENT = "Voice is sent on its own — clear the box to record.";

function firstImage(files: FileList | File[] | null | undefined): File | null {
  return Array.from(files ?? []).find((file) => file.type.startsWith("image/")) ?? null;
}

function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

const iconButton =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45 aria-disabled:opacity-45";

/**
 * One input for adding items: describe them, paste a product link, attach a
 * photo or record a voice note. Everything ends in the import review.
 */
export function SmartAddInput({
  context,
  layout,
  onBusyChange,
  onFinish,
  escapeRef,
}: {
  context?: SmartAddContext;
  layout: "dialog" | "sheet";
  onBusyChange: (busy: boolean) => void;
  /** Closes the surface regardless of the busy lock, before navigating away. */
  onFinish: () => void;
  /** Lets the surrounding dialog route Escape to nested UI first. */
  escapeRef: React.MutableRefObject<(() => boolean) | null>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const libraryRef = React.useRef<HTMLInputElement>(null);
  const chipRef = React.useRef<HTMLButtonElement>(null);
  const pickerRef = React.useRef<HTMLDivElement>(null);
  const ids = React.useId();

  const [propertyId, setPropertyId] = React.useState(context?.propertyId ?? "");
  const [roomId, setRoomId] = React.useState(context?.roomId ?? "");
  const [locationId, setLocationId] = React.useState(context?.locationId ?? "");
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const propertiesQuery = useProperties();
  const roomsQuery = useRooms(propertyId || undefined);
  const locationsQuery = useLocations();
  const properties = propertiesQuery.data?.items ?? [];
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];

  const [text, setText] = React.useState("");
  const [photo, setPhoto] = React.useState<File | null>(null);
  const photoUrl = useObjectUrl(photo);
  const [dragging, setDragging] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [micHint, setMicHint] = React.useState<string | null>(null);
  const [recognitionId, setRecognitionId] = React.useState<string | null>(null);
  const recognitionQuery = useRecognition(recognitionId ?? undefined);
  const [voiceNoteId, setVoiceNoteId] = React.useState<string | null>(null);
  const voiceNoteQuery = useVoiceNote(voiceNoteId ?? undefined);
  const importedNoteRef = React.useRef<string | null>(null);
  const voiceConfig = useVoiceConfig();
  const transcriptionStatus = useAiStatus("transcription");
  const voiceReady = Boolean(
    transcriptionStatus.data?.configured && transcriptionStatus.data.available,
  );
  const maxSeconds = voiceConfig.data?.max_duration_seconds ?? 120;

  React.useEffect(() => {
    if (propertyId) return;
    const room = rooms.find((entry) => entry.id === roomId);
    if (room?.property_id) setPropertyId(room.property_id);
    else if (properties.length === 1) setPropertyId(properties[0]!.id);
  }, [propertyId, properties, roomId, rooms]);

  React.useEffect(() => {
    if (roomId || !locationId) return;
    const place = locations.find((entry) => entry.id === locationId);
    if (place) setRoomId(place.room_id);
  }, [roomId, locationId, locations]);

  const appendContext = (form: FormData) => {
    if (propertyId) form.append("property_id", propertyId);
    if (roomId) form.append("room_id", roomId);
    if (locationId) form.append("location_id", locationId);
  };

  const finishAt = (path: string) => {
    onFinish();
    navigate(path);
  };

  const createTextImport = useMutation({
    mutationFn: (input: { text: string } | { productUrl: string }) => {
      const form = new FormData();
      if ("productUrl" in input) form.append("product_url", input.productUrl);
      else form.append("text", input.text);
      appendContext(form);
      return api.postForm<ImportBatchDetail>("/imports", form);
    },
    onSuccess: (batch) => finishAt(`/imports/${batch.id}`),
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const createRecognition = useMutation({
    mutationFn: ({ file, note }: { file: File; note: string }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("text", note);
      appendContext(form);
      return api.postForm<AiRecognition>("/ai/recognitions", form);
    },
    onSuccess: (created) => setRecognitionId(created.id),
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const adaptRecognition = useMutation({
    mutationFn: (id: string) =>
      api.post<ImportBatchDetail>(`/imports/from-recognition/${id}`),
    onSuccess: (batch) => finishAt(`/imports/${batch.id}`),
    onError: (caught) => {
      setError(getApiErrorMessage(caught));
      setRecognitionId(null);
    },
  });

  const voiceUpload = useMutation({
    mutationFn: ({ file, duration }: { file: File; duration: number }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("duration_seconds", String(duration));
      appendContext(form);
      return api.postForm<VoiceNote>("/voice", form);
    },
    onSuccess: (created) => {
      queryClient.setQueryData(queryKeys.voiceNote(created.id), created);
      importedNoteRef.current = null;
      setVoiceNoteId(created.id);
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const recorder = useVoiceRecorder({
    maxSeconds,
    onRecorded: (file, duration) => {
      setError(null);
      voiceUpload.mutate({ file, duration });
    },
  });

  const mutationsRef = React.useRef({ adaptRecognition, createTextImport });
  React.useEffect(() => {
    mutationsRef.current = { adaptRecognition, createTextImport };
  });

  const recognition = recognitionQuery.data;
  const recognitionStatus = recognition?.status;
  React.useEffect(() => {
    if (!recognition || mutationsRef.current.adaptRecognition.isPending) return;
    if (recognitionStatus === "succeeded") {
      mutationsRef.current.adaptRecognition.mutate(recognition.id);
    } else if (recognitionStatus === "failed") {
      setError(recognition.error || "Image recognition failed. Your draft is unchanged.");
      setRecognitionId(null);
    }
  }, [recognition?.id, recognitionStatus]);

  const note = voiceNoteQuery.data;
  React.useEffect(() => {
    if (!note || note.id !== voiceNoteId) return;
    if (note.status === "transcribed" && note.transcript) {
      if (importedNoteRef.current === note.id) return;
      importedNoteRef.current = note.id;
      const transcript = note.transcript;
      mutationsRef.current.createTextImport.mutate(
        { text: transcript },
        {
          onError: () => {
            setText(transcript);
            setVoiceNoteId(null);
          },
        },
      );
    } else if (note.status === "failed" || note.status === "cancelled") {
      setError(note.transcript_error || "The recording could not be transcribed. Try again.");
      setVoiceNoteId(null);
    }
  }, [note, voiceNoteId]);

  const kind = detectInputKind(text, Boolean(photo));
  const transcribing = voiceUpload.isPending || Boolean(voiceNoteId);
  const submitting =
    createTextImport.isPending ||
    createRecognition.isPending ||
    adaptRecognition.isPending ||
    Boolean(recognitionId);
  const busy = transcribing || submitting;
  const inputLocked = busy || recorder.recording;

  React.useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  React.useEffect(() => {
    escapeRef.current = () => {
      if (pickerOpen) {
        closePicker();
        return true;
      }
      if (recorder.recording) {
        recorder.cancel();
        return true;
      }
      return false;
    };
  });
  React.useEffect(() => () => void (escapeRef.current = null), [escapeRef]);

  React.useEffect(() => {
    if (!pickerOpen || layout !== "dialog") return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || chipRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pickerOpen, layout]);

  const micBlocked = !voiceReady
    ? VOICE_NOT_CONFIGURED
    : text.trim() || photo
      ? VOICE_HAS_CONTENT
      : null;
  React.useEffect(() => {
    if (micHint && micHint !== micBlocked) setMicHint(null);
  }, [micBlocked, micHint]);

  const attach = (file: File | null) => {
    if (!file || inputLocked) return;
    setPhoto(file);
    setError(null);
  };

  const submit = () => {
    if (inputLocked) return;
    setError(null);
    if (kind === "empty" || kind === "conflict") return;
    const trimmed = text.trim();
    if (photo) createRecognition.mutate({ file: photo, note: trimmed });
    else if (kind === "link") createTextImport.mutate({ productUrl: trimmed });
    else createTextImport.mutate({ text: trimmed });
  };

  const closePicker = () => {
    setPickerOpen(false);
    window.setTimeout(() => chipRef.current?.focus(), 0);
  };

  const room = rooms.find((entry) => entry.id === roomId);
  const place = locations.find((entry) => entry.id === locationId);
  const property = properties.find((entry) => entry.id === propertyId);
  const roomLabel =
    (roomId && roomId === context?.roomId ? context.roomName : undefined) ?? room?.name;
  const placeLabel =
    (locationId && locationId === context?.locationId ? context.locationName : undefined) ??
    (place ? place.identifier || place.name : undefined);
  const contextLabel =
    [roomLabel, placeLabel].filter(Boolean).join(" · ") ||
    (roomId || locationId
      ? "Selected place"
      : properties.length > 1 && property
        ? property.name
        : "No place yet");
  const placeOptions = locations.filter((entry) => entry.room_id === roomId);

  const manualHref = (() => {
    const params = new URLSearchParams();
    if (propertyId) params.set("property_id", propertyId);
    if (roomId) params.set("room_id", roomId);
    if (locationId) params.set("location_id", locationId);
    const query = params.toString();
    const originLabel = [context?.roomName, context?.locationName]
      .filter(Boolean)
      .join(" · ");
    const origin = context
      ? itemOrigin(`${location.pathname}${location.search}`, originLabel || "add-items source")
      : null;
    return appendOrigin(query ? `/items/new?${query}` : "/items/new", origin);
  })();

  const picker = (
    <div
      ref={pickerRef}
      id={`${ids}-picker`}
      role="group"
      aria-label="Where are these items?"
      className={cn(
        "space-y-3 rounded-2xl border border-border/80 bg-popover p-3.5",
        layout === "dialog" && "absolute left-0 top-full z-20 mt-2 w-80 max-w-full shadow-lift",
      )}
    >
      {properties.length > 1 && (
        <label className="block space-y-1.5">
          <span className="field-label">Property</span>
          <Select
            value={propertyId}
            onChange={(event) => {
              setPropertyId(event.target.value);
              setRoomId("");
              setLocationId("");
            }}
          >
            <option value="">Choose a property</option>
            {properties.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      <label className="block space-y-1.5">
        <span className="field-label">Room</span>
        <Select
          value={roomId}
          onChange={(event) => {
            setRoomId(event.target.value);
            setLocationId("");
          }}
        >
          <option value="">No room</option>
          {rooms.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="block space-y-1.5">
        <span className="field-label">Place</span>
        <Select
          value={locationId}
          disabled={!roomId}
          onChange={(event) => setLocationId(event.target.value)}
        >
          <option value="">{roomId ? "Anywhere in the room" : "Choose a room first"}</option>
          {placeOptions.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.identifier ? `${entry.identifier} · ` : ""}
              {entry.name}
            </option>
          ))}
        </Select>
      </label>
      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          variant="ghost"
          className="h-11"
          onClick={() => {
            setPropertyId("");
            setRoomId("");
            setLocationId("");
          }}
        >
          Clear
        </Button>
        <Button className="h-11" onClick={closePicker}>
          Done
        </Button>
      </div>
    </div>
  );

  const chipLabel = KIND_LABEL[kind];
  const showInlinePicker = layout === "sheet" && pickerOpen;

  return (
    <div className="grid gap-4">
      <div className="relative">
        <button
          ref={chipRef}
          type="button"
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? `${ids}-picker` : undefined}
          aria-label={`Place: ${contextLabel}. Change`}
          disabled={busy}
          onClick={() => setPickerOpen((open) => !open)}
          className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-sage/25 bg-sage-soft/40 px-3.5 text-sm text-foreground/90 transition-colors hover:bg-sage-soft/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-45 lg:text-xs"
        >
          <MapPin className="size-4 shrink-0 text-sage" aria-hidden="true" />
          <span className="truncate">{contextLabel}</span>
          <ChevronDown
            className={cn("size-4 shrink-0 transition-transform", pickerOpen && "rotate-180")}
            aria-hidden="true"
          />
        </button>
        {pickerOpen && layout === "dialog" && picker}
      </div>

      {showInlinePicker ? (
        picker
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {error && <FormError message={error} />}
          <div
            className={cn(
              "rounded-2xl border border-input/90 bg-card/65 transition-[border-color,box-shadow] focus-within:border-ring/50 focus-within:ring-4 focus-within:ring-ring/10",
              dragging && "border-ring/60 ring-4 ring-ring/15",
              kind === "conflict" && "border-destructive/50",
            )}
            onDragOver={(event) => {
              if (inputLocked || !Array.from(event.dataTransfer.types).includes("Files")) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              setDragging(false);
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              const file = firstImage(event.dataTransfer.files);
              if (file) attach(file);
              else setError("Only a photo can be attached here.");
            }}
          >
            <label htmlFor={`${ids}-text`} className="sr-only">
              Describe items or paste a product link
            </label>
            <textarea
              ref={textareaRef}
              id={`${ids}-text`}
              autoFocus
              rows={4}
              maxLength={2_000_000}
              value={text}
              disabled={inputLocked}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              onPaste={(event) => {
                const file = firstImage(event.clipboardData?.files);
                if (!file) return;
                event.preventDefault();
                attach(file);
              }}
              placeholder={
                "Two camping chairs in the garage…\nor paste one product link, or add a photo."
              }
              className="block min-h-28 w-full resize-none rounded-t-2xl bg-transparent px-4 pb-2 pt-3.5 text-base leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 lg:text-[0.95rem]"
            />

            {photo && (
              <div className="px-3 pb-2">
                <span className="inline-flex max-w-full items-center gap-2 rounded-xl border border-border/80 bg-secondary/40 py-1 pl-1 pr-1">
                  {photoUrl ? (
                    <img
                      src={photoUrl}
                      alt=""
                      className="size-9 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <Camera className="ml-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="truncate text-sm">{photo.name || "Photo"}</span>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label="Remove photo"
                    disabled={inputLocked}
                    onClick={() => setPhoto(null)}
                  >
                    <X className="size-4" />
                  </button>
                </span>
              </div>
            )}

            {recorder.recording ? (
              <div
                role="group"
                aria-label="Recording voice note"
                className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2"
              >
                <span className="size-2.5 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
                <span className="text-sm tabular-nums lg:text-xs">
                  <span className="sr-only">Recording </span>
                  {formatDuration(recorder.elapsed)} / {formatDuration(maxSeconds)}
                </span>
                <div className="ml-auto flex gap-1.5">
                  <Button className="h-11" onClick={recorder.stop}>
                    <Square /> Stop
                  </Button>
                  <Button variant="ghost" className="h-11" onClick={recorder.cancel}>
                    <X /> Cancel
                  </Button>
                </div>
              </div>
            ) : transcribing ? (
              <div
                role="status"
                className="flex items-center gap-2 border-t border-border/60 px-4 py-3 text-sm text-muted-foreground lg:text-xs"
              >
                <Spinner /> Transcribing your voice note…
              </div>
            ) : (
              <div className="flex items-center gap-1 border-t border-border/60 px-1.5 py-1">
                <button
                  type="button"
                  className={iconButton}
                  aria-label="Take photo"
                  title="Take photo"
                  disabled={inputLocked}
                  onClick={() => cameraRef.current?.click()}
                >
                  <Camera className="size-[1.1rem]" />
                </button>
                <button
                  type="button"
                  className={iconButton}
                  aria-label="Choose photo"
                  title="Choose photo"
                  disabled={inputLocked}
                  onClick={() => libraryRef.current?.click()}
                >
                  <ImagePlus className="size-[1.1rem]" />
                </button>
                <button
                  type="button"
                  className={iconButton}
                  aria-label="Record voice note"
                  title={micBlocked ?? "Record voice note"}
                  aria-disabled={micBlocked || inputLocked ? true : undefined}
                  aria-describedby={micBlocked ? `${ids}-mic-reason` : undefined}
                  onClick={() => {
                    if (inputLocked) return;
                    if (micBlocked) {
                      setMicHint(micBlocked);
                      return;
                    }
                    setMicHint(null);
                    void recorder.start();
                  }}
                >
                  <Mic className="size-[1.1rem]" />
                </button>
                {micBlocked && (
                  <span id={`${ids}-mic-reason`} className="sr-only">
                    {micBlocked}
                  </span>
                )}
                <div aria-live="polite" className="ml-auto pr-2">
                  {chipLabel && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-foreground/80 lg:text-2xs">
                      {kind === "link" && <Link2 className="size-3.5" aria-hidden="true" />}
                      {(kind === "photo" || kind === "photo-note") && (
                        <Camera className="size-3.5" aria-hidden="true" />
                      )}
                      {chipLabel}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="smart-add-camera"
            onChange={(event) => {
              attach(firstImage(event.target.files));
              event.target.value = "";
            }}
          />
          <input
            ref={libraryRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="smart-add-library"
            onChange={(event) => {
              attach(firstImage(event.target.files));
              event.target.value = "";
            }}
          />

          <div aria-live="polite" className="empty:hidden">
            {kind === "conflict" && (
              <p className="text-sm leading-snug text-destructive lg:text-xs">
                {CONFLICT_MESSAGE}
              </p>
            )}
            {recorder.error && (
              <p className="text-sm leading-snug text-destructive lg:text-xs">
                {recorder.error}
              </p>
            )}
            {micHint && (
              <p className="text-sm leading-snug text-muted-foreground lg:text-xs">
                {micHint === VOICE_NOT_CONFIGURED ? (
                  <>
                    Voice needs transcription —{" "}
                    <Link
                      to="/settings/ai"
                      onClick={onFinish}
                      className="underline underline-offset-4"
                    >
                      set up in AI settings
                    </Link>
                  </>
                ) : (
                  micHint
                )}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Link
              to={manualHref}
              onClick={onFinish}
              className="order-2 inline-flex min-h-11 items-center justify-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:order-1 lg:text-xs"
            >
              or fill in the form yourself
            </Link>
            <Button
              type="submit"
              className="order-1 h-11 sm:order-2"
              disabled={kind === "empty" || kind === "conflict" || inputLocked}
              aria-keyshortcuts="Control+Enter Meta+Enter"
            >
              {submitting ? <Spinner /> : kind === "link" ? <Link2 /> : <Sparkles />}
              {submitting ? "Interpreting…" : "Review items"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
