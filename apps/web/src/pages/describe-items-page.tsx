import { useMutation } from "@tanstack/react-query";
import { Camera, FileText, Link2, Sparkles } from "lucide-react";
import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { CameraUpload } from "@/components/camera-upload";
import { Field, FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { VoiceRecorder } from "@/components/voice-recorder";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  useAiStatus,
  useLocations,
  useProperties,
  useRecognition,
  useRooms,
  useVoiceConfig,
  useVoiceNote,
} from "@/lib/queries";
import type {
  AiRecognition,
  ImportBatchDetail,
  VoiceNote,
} from "@/lib/types";

export function DescribeItemsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const propertyParam = searchParams.get("property_id") ?? "";
  const roomParam = searchParams.get("room_id") ?? "";
  const locationParam = searchParams.get("location_id") ?? "";
  const propertiesQuery = useProperties();
  const [propertyId, setPropertyId] = React.useState(propertyParam);
  const [roomId, setRoomId] = React.useState(roomParam);
  const [locationId, setLocationId] = React.useState(locationParam);
  const properties = propertiesQuery.data?.items ?? [];
  const roomsQuery = useRooms(propertyId || undefined);
  const locationsQuery = useLocations();
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const [text, setText] = React.useState("");
  const [purchaseDate, setPurchaseDate] = React.useState("");
  const [image, setImage] = React.useState<File | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [recognitionId, setRecognitionId] = React.useState<string | null>(null);
  const recognitionQuery = useRecognition(recognitionId ?? undefined);
  const [voiceNoteId, setVoiceNoteId] = React.useState<string | null>(null);
  const voiceNoteQuery = useVoiceNote(voiceNoteId ?? undefined);
  const transcribedFor = React.useRef<string | null>(null);
  const voiceConfig = useVoiceConfig();
  const transcriptionStatus = useAiStatus("transcription");

  React.useEffect(() => {
    if (propertyId) return;
    const room = rooms.find((entry) => entry.id === roomId);
    if (room?.property_id) setPropertyId(room.property_id);
    else if (properties.length === 1) setPropertyId(properties[0]!.id);
  }, [propertyId, properties, roomId, rooms]);

  const note = voiceNoteQuery.data;
  React.useEffect(() => {
    if (!note || note.status !== "transcribed" || !note.transcript) return;
    if (transcribedFor.current === note.id) return;
    transcribedFor.current = note.id;
    setText(note.transcript);
    toast.success("Transcript ready to edit");
  }, [note]);

  const voiceUpload = useMutation({
    mutationFn: ({ file, duration }: { file: File; duration: number | null }) => {
      const form = new FormData();
      form.append("file", file);
      if (duration != null) form.append("duration_seconds", String(duration));
      if (propertyId) form.append("property_id", propertyId);
      if (roomId) form.append("room_id", roomId);
      if (locationId) form.append("location_id", locationId);
      return api.postForm<VoiceNote>("/voice", form);
    },
    onSuccess: (created) => {
      setVoiceNoteId(created.id);
      transcribedFor.current = null;
    },
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const createTextImport = useMutation({
    mutationFn: (productUrl: string | null) => {
      const form = new FormData();
      if (productUrl) form.append("product_url", productUrl);
      else form.append("text", text.trim());
      if (productUrl && purchaseDate) form.append("purchase_date", purchaseDate);
      if (propertyId) form.append("property_id", propertyId);
      if (roomId) form.append("room_id", roomId);
      if (locationId) form.append("location_id", locationId);
      return api.postForm<ImportBatchDetail>("/imports", form);
    },
    onSuccess: (batch) => navigate(`/imports/${batch.id}`),
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const createRecognition = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("text", text.trim());
      if (propertyId) form.append("property_id", propertyId);
      if (roomId) form.append("room_id", roomId);
      if (locationId) form.append("location_id", locationId);
      return api.postForm<AiRecognition>("/ai/recognitions", form);
    },
    onSuccess: (created) => setRecognitionId(created.id),
    onError: (caught) => setError(getApiErrorMessage(caught)),
  });

  const adaptRecognition = useMutation({
    mutationFn: (id: string) =>
      api.post<ImportBatchDetail>(`/imports/from-recognition/${id}`),
    onSuccess: (batch) => navigate(`/imports/${batch.id}`),
    onError: (caught) => {
      setError(getApiErrorMessage(caught));
      setRecognitionId(null);
    },
  });

  const adaptRecognitionRef = React.useRef(adaptRecognition);
  React.useEffect(() => {
    adaptRecognitionRef.current = adaptRecognition;
  }, [adaptRecognition]);
  const recognition = recognitionQuery.data;
  const recognitionStatus = recognition?.status;
  React.useEffect(() => {
    if (!recognition || adaptRecognitionRef.current.isPending) return;
    if (recognitionStatus === "succeeded") {
      adaptRecognitionRef.current.mutate(recognition.id);
    } else if (recognitionStatus === "failed") {
      setError(recognition.error || "Image recognition failed. Your draft is unchanged.");
      setRecognitionId(null);
    }
  }, [recognition?.id, recognitionStatus]);

  const productUrl = /^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : null;
  const busy =
    createTextImport.isPending ||
    createRecognition.isPending ||
    adaptRecognition.isPending ||
    Boolean(recognitionId);
  const transcribing =
    voiceUpload.isPending ||
    Boolean(note && ["queued", "processing"].includes(note.status));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (image && productUrl) {
      setError("Remove the photo to import a product link, or add a note instead of a URL.");
      return;
    }
    if (image) {
      createRecognition.mutate(image);
      return;
    }
    if (!text.trim()) {
      setError("Describe an item, add a photo or paste one product URL first.");
      return;
    }
    createTextImport.mutate(productUrl);
  };

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Assisted add items"
        title="Describe or show"
        description="Write naturally, speak, paste a product link or add a photo. Everything opens in one review before anything is added."
        backTo="/items"
        backLabel="All items"
      />
      <div className="grid max-w-4xl gap-6">
        <section className="surface p-5 sm:p-6">
          <form className="space-y-5" onSubmit={submit}>
            {error && <FormError message={error} />}
            <Field
              label={productUrl ? "Product link" : "What did you get?"}
              htmlFor="describe-items-text"
              hint="Include quantity, place, purchase date or anything useful."
            >
              <Textarea
                id="describe-items-text"
                className="min-h-44"
                maxLength={2_000_000}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  "Two camping chairs are in the garage.\nOr paste one https://shop.example/product link."
                }
              />
            </Field>
            {productUrl && !image && (
              <Field label="Purchase date" htmlFor="describe-purchase-date" optional>
                <Input
                  id="describe-purchase-date"
                  type="date"
                  max={new Date().toISOString().slice(0, 10)}
                  value={purchaseDate}
                  onChange={(event) => setPurchaseDate(event.target.value)}
                />
              </Field>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-5">
              <CameraUpload
                label={image ? `Photo: ${image.name}` : "Add a photo"}
                busy={createRecognition.isPending}
                onUpload={async (file) => {
                  setImage(file);
                  setError(null);
                }}
              />
              <span className="inline-flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
                <FileText className="size-3.5" />
                Photo and text are reviewed together.
              </span>
              <Button type="submit" className="ml-auto" disabled={busy || transcribing}>
                {busy ? <Spinner /> : productUrl ? <Link2 /> : <Sparkles />}
                {busy ? "Interpreting…" : "Review items"}
              </Button>
            </div>
            {image && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setImage(null)}
                disabled={busy}
              >
                <Camera /> Remove photo
              </Button>
            )}
          </form>
        </section>

        <VoiceRecorder
          config={voiceConfig.data}
          transcriptionReady={Boolean(
            transcriptionStatus.data?.configured && transcriptionStatus.data.available,
          )}
          transcriptionStatus={transcriptionStatus.data}
          uploadPending={voiceUpload.isPending || transcribing}
          properties={properties}
          propertyId={propertyId}
          onPropertyChange={(value) => {
            setPropertyId(value);
            setRoomId("");
            setLocationId("");
          }}
          rooms={rooms}
          defaultRoomId={roomId}
          defaultLocationId={locationId}
          defaultLocations={locations.filter((location) => location.room_id === roomId)}
          onDefaultRoomChange={(value) => {
            setRoomId(value);
            setLocationId("");
          }}
          onDefaultLocationChange={setLocationId}
          onUpload={(file, duration) => voiceUpload.mutate({ file, duration })}
        />
      </div>
    </div>
  );
}
