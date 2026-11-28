import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Pencil, ShieldAlert, Sparkles } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { FormError } from "@/components/form-field";
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
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useAiStatus,
  useLocations,
  useProperties,
  useReviewSchedule,
  useRooms,
} from "@/lib/queries";
import type {
  ReviewSchedule,
  ReviewScheduleFrequency,
  ReviewScheduleScope,
  ReviewScheduleState,
  ReviewScheduleSummary,
} from "@/lib/types";
import { flattenLocations, locationLabel, locationPath, roomPath } from "@/lib/utils";

const SCOPE_LABELS: Record<ReviewScheduleScope, string> = {
  household: "Whole household",
  property: "Property",
  room: "Room",
  container: "Container or place",
};

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const STATE_BADGES: Record<
  ReviewScheduleState,
  { label: string; variant: "sage" | "brass" | "outline" | "destructive" }
> = {
  not_configured: { label: "Off", variant: "outline" },
  disabled: { label: "Off", variant: "outline" },
  scheduled: { label: "Scheduled", variant: "sage" },
  consent_needed: { label: "Consent needed", variant: "brass" },
  ai_not_configured: { label: "AI not configured", variant: "brass" },
  attention: { label: "Needs attention", variant: "destructive" },
};

interface ScheduleForm {
  enabled: boolean;
  scopeType: ReviewScheduleScope;
  scopeId: string;
  frequency: ReviewScheduleFrequency;
  timezone: string;
  weekday: number;
  monthlyDay: number;
  localHour: number;
  maxItems: number;
  maxRunsPerDay: number;
  includeAi: boolean;
  aiConsent: boolean;
}

function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function formFromSchedule(schedule: ReviewSchedule | null | undefined): ScheduleForm {
  return {
    enabled: schedule?.enabled ?? false,
    scopeType: schedule?.scope_type ?? "household",
    scopeId: schedule?.scope_id ?? "",
    frequency: schedule?.frequency ?? "weekly",
    timezone: schedule?.timezone ?? browserTimezone(),
    weekday: schedule?.weekday ?? 0,
    monthlyDay: schedule?.monthly_day ?? 1,
    localHour: schedule?.local_hour ?? 9,
    maxItems: schedule?.max_items ?? 200,
    maxRunsPerDay: schedule?.max_runs_per_day ?? 1,
    includeAi: schedule?.include_ai ?? false,
    aiConsent: Boolean(schedule?.include_ai && schedule?.ai_consent_valid),
  };
}

export function describeSchedule(
  schedule: ReviewScheduleSummary | null | undefined,
): string {
  if (!schedule || !schedule.enabled) return "Automatic review is off.";
  const time = `${String(schedule.local_hour).padStart(2, "0")}:00`;
  const cadence =
    schedule.frequency === "weekly"
      ? `${WEEKDAYS[schedule.weekday] ?? "Monday"} at ${time}`
      : `day ${schedule.monthly_day} of each month at ${time}`;
  return `${schedule.frequency === "weekly" ? "Weekly on" : "Monthly on"} ${cadence} · ${schedule.timezone}`;
}

function scheduledTimestamp(value: string | null, timeZone?: string) {
  if (!value) return "not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function ScheduleStatus({
  schedule,
  compact = false,
}: {
  schedule: ReviewScheduleSummary | null | undefined;
  compact?: boolean;
}) {
  if (!schedule || !schedule.configured) return null;
  return (
    <div className="mt-2 space-y-1 text-2xs leading-relaxed text-muted-foreground">
      {schedule.enabled && (
        <>
          <p>
            <span className="font-medium text-foreground/85">Schedule:</span>{" "}
            {describeSchedule(schedule)}
          </p>
          <p>
            <span className="font-medium text-foreground/85">Next:</span>{" "}
            {scheduledTimestamp(schedule.next_due_at, schedule.timezone)}
          </p>
        </>
      )}
      <p>
        <span className="font-medium text-foreground/85">Last run:</span>{" "}
        {schedule.last_run_status === "never"
          ? "never"
          : `${schedule.last_run_status} · ${scheduledTimestamp(
              schedule.last_run_at,
              schedule.timezone,
            )}`}
      </p>
      {schedule.last_run_detail && (
        <p className="break-words rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-2xs">
          {schedule.last_run_detail}
        </p>
      )}
      {schedule.enabled && schedule.include_ai && (
        <p className="break-words">
          <span className="font-medium text-foreground/85">AI:</span>{" "}
          {schedule.ai_consent_valid
            ? `consented for ${schedule.assistant_provider_label ?? "the current Assistant route"}${
                schedule.assistant_model ? ` · ${schedule.assistant_model}` : ""
              }`
            : "consent needs renewal before scheduled AI can run"}
        </p>
      )}
      {!compact && schedule.enabled && (
        <p className="text-2xs">
          Offline rules are bounded to {schedule.max_items} item
          {schedule.max_items === 1 ? "" : "s"} per run; up to{" "}
          {schedule.max_runs_per_day} scheduled run
          {schedule.max_runs_per_day === 1 ? "" : "s"} per local day. A scheduled AI
          run makes at most {schedule.provider_request_cap} provider request.
        </p>
      )}
      {schedule.state === "attention" && schedule.state_detail && (
        <p className="flex items-start gap-1.5 rounded-lg border border-destructive/20 bg-destructive/[0.05] px-2.5 py-2 text-2xs text-destructive">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{schedule.state_detail}</span>
        </p>
      )}
    </div>
  );
}

function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  aiReady,
  aiLabel,
  aiModel,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule: ReviewSchedule | null;
  aiReady: boolean;
  aiLabel: string;
  aiModel: string | null;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<ScheduleForm>(() =>
    formFromSchedule(schedule),
  );
  const [error, setError] = React.useState<string | null>(null);
  const propertiesQuery = useProperties();
  const roomsQuery = useRooms();
  const locationsQuery = useLocations();
  const properties = propertiesQuery.data?.items ?? [];
  const rooms = roomsQuery.data?.items ?? [];
  const locations = locationsQuery.data?.items ?? [];
  const flatLocations = flattenLocations(locations);

  React.useEffect(() => {
    if (!open) return;
    setForm(formFromSchedule(schedule));
    setError(null);
  }, [open, schedule]);

  const save = useMutation({
    mutationFn: (payload: ScheduleForm) =>
      api.put<ReviewSchedule>("/inventory-review/schedule", {
        enabled: payload.enabled,
        scope_type: payload.scopeType,
        scope_id: payload.scopeType === "household" ? null : payload.scopeId || null,
        frequency: payload.frequency,
        timezone: payload.timezone.trim(),
        weekday: payload.weekday,
        monthly_day: payload.monthlyDay,
        local_hour: payload.localHour,
        max_items: payload.maxItems,
        max_runs_per_day: payload.maxRunsPerDay,
        include_ai: payload.includeAi,
        ai_consent: payload.includeAi ? payload.aiConsent : false,
      }),
    onSuccess: () => {
      toast.success("Scheduled review settings saved.");
      setError(null);
      onOpenChange(false);
      onSaved();
    },
    onError: (saveError) => {
      const message = getApiErrorMessage(saveError);
      setError(message);
      toast.error(message);
    },
  });

  const submit = () => {
    setError(null);
    if (form.enabled && form.scopeType !== "household" && !form.scopeId) {
      setError(`Choose the ${SCOPE_LABELS[form.scopeType].toLowerCase()} to review.`);
      return;
    }
    if (form.includeAi && !aiReady) {
      setError(
        "The household Assistant task is not configured. Turn AI off to schedule offline rules only, or configure the Assistant task first.",
      );
      return;
    }
    if (form.includeAi && !form.aiConsent) {
      setError(
        "Scheduled AI needs separate explicit consent. Leave AI off to schedule offline rules only.",
      );
      return;
    }
    save.mutate(form);
  };

  const timezoneOptions = React.useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Scheduled inventory review</DialogTitle>
          <DialogDescription>
            Runs create the same persistent suggestions as a manual review. They never
            apply, rename, move or merge inventory automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-background/35 p-3.5 text-xs">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={form.enabled}
              onChange={(event) =>
                setForm((current) => ({ ...current, enabled: event.target.checked }))
              }
              aria-label="Enable scheduled review"
            />
            <span>
              <span className="font-medium">
                Enable scheduled review (offline rules)
              </span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                Off by default. Disabling stops future dispatch; a run already queued
                is cancelled and a run already in progress may finish. Opening this
                screen or enabling offline scheduling never calls AI.
              </span>
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-2xs">
              <span className="field-label">Scope</span>
              <Select
                aria-label="Schedule scope type"
                value={form.scopeType}
                onChange={(event) => {
                  const scopeType = event.target.value as ReviewScheduleScope;
                  setForm((current) => ({
                    ...current,
                    scopeType,
                    scopeId: "",
                  }));
                }}
              >
                {(Object.keys(SCOPE_LABELS) as ReviewScheduleScope[]).map((scope) => (
                  <option key={scope} value={scope}>
                    {SCOPE_LABELS[scope]}
                  </option>
                ))}
              </Select>
            </label>
            <div className="space-y-1.5 text-2xs">
              <span className="field-label">Scope detail</span>
              {form.scopeType === "household" ? (
                <p className="rounded-lg border border-border/60 bg-background/35 px-3 py-2 text-2xs text-muted-foreground">
                  Every active item in this household.
                </p>
              ) : form.scopeType === "property" ? (
                <Select
                  aria-label="Property schedule scope"
                  value={form.scopeId}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, scopeId: event.target.value }))
                  }
                >
                  <option value="">Choose a property</option>
                  {properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </Select>
              ) : form.scopeType === "room" ? (
                <Select
                  aria-label="Room schedule scope"
                  value={form.scopeId}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, scopeId: event.target.value }))
                  }
                >
                  <option value="">Choose a room</option>
                  {rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {[room.property?.name, ...roomPath(rooms, room.id).map((entry) => entry.name)]
                        .filter(Boolean)
                        .join(" / ")}
                    </option>
                  ))}
                </Select>
              ) : (
                <Select
                  aria-label="Container schedule scope"
                  value={form.scopeId}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, scopeId: event.target.value }))
                  }
                >
                  <option value="">Choose a container or place</option>
                  {flatLocations.map(({ location }) => (
                    <option key={location.id} value={location.id}>
                      {[
                        location.identifier
                          ? `${location.identifier} · ${location.name}`
                          : location.name,
                        ...locationPath(locations, location.id)
                          .slice(0, -1)
                          .map((entry) => locationLabel(entry)),
                      ]
                        .filter(Boolean)
                        .join(" / ")}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            <label className="space-y-1.5 text-2xs">
              <span className="field-label">Frequency</span>
              <Select
                aria-label="Schedule frequency"
                value={form.frequency}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    frequency: event.target.value as ReviewScheduleFrequency,
                  }))
                }
              >
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </label>
            {form.frequency === "weekly" ? (
              <label className="space-y-1.5 text-2xs">
                <span className="field-label">Day</span>
                <Select
                  aria-label="Weekly day"
                  value={form.weekday}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      weekday: Number(event.target.value),
                    }))
                  }
                >
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </Select>
              </label>
            ) : (
              <label className="space-y-1.5 text-2xs">
                <span className="field-label">Day of month</span>
                <Select
                  aria-label="Monthly day"
                  value={form.monthlyDay}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      monthlyDay: Number(event.target.value),
                    }))
                  }
                >
                  {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                    <option key={day} value={day}>
                      {day}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label className="space-y-1.5 text-2xs">
              <span className="field-label">Local hour</span>
              <Select
                aria-label="Schedule hour"
                value={form.localHour}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    localHour: Number(event.target.value),
                  }))
                }
              >
                {Array.from({ length: 24 }, (_, hour) => hour).map((hour) => (
                  <option key={hour} value={hour}>
                    {String(hour).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1.5 text-2xs">
              <span className="field-label">Timezone</span>
              <Input
                aria-label="Schedule timezone"
                value={form.timezone}
                list="review-schedule-timezones"
                onChange={(event) =>
                  setForm((current) => ({ ...current, timezone: event.target.value }))
                }
                placeholder="Europe/London"
              />
              <datalist id="review-schedule-timezones">
                {timezoneOptions.map((timezone) => (
                  <option key={timezone} value={timezone} />
                ))}
              </datalist>
            </label>
            <label className="space-y-1.5 text-2xs">
              <span className="field-label">Maximum items per run</span>
              <Input
                aria-label="Maximum items per run"
                type="number"
                min={1}
                max={500}
                value={form.maxItems}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    maxItems: Math.max(
                      1,
                      Math.min(500, Number(event.target.value) || 1),
                    ),
                  }))
                }
              />
              <span className="text-2xs text-muted-foreground">
                Server hard cap: 500. New and recently changed items are prioritised;
                older items rotate in on later runs.
              </span>
            </label>
            <label className="space-y-1.5 text-2xs">
              <span className="field-label">Maximum scheduled runs per day</span>
              <Select
                aria-label="Maximum scheduled runs per day"
                value={form.maxRunsPerDay}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    maxRunsPerDay: Number(event.target.value),
                  }))
                }
              >
                {[1, 2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </Select>
              <span className="text-2xs text-muted-foreground">
                Hard server cap: 4. Manual reviews are not counted against this cap.
              </span>
            </label>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/35 p-3.5">
            <div className="flex items-start gap-2.5 text-xs">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-brass" />
              <div className="min-w-0">
                <p className="font-medium">Optional scheduled AI</p>
                <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                  Offline rules are always the base of a scheduled run. This separate
                  option adds one bounded organisation pass using the existing household
                  Assistant task.
                </p>
                <p className="mt-1 break-words text-2xs text-muted-foreground">
                  Current Assistant route:{" "}
                  <strong className="font-medium text-foreground/85">{aiLabel}</strong>
                  {aiModel ? ` · ${aiModel}` : ""}
                  {!aiReady ? " · not configured" : ""}
                </p>
              </div>
            </div>
            <label className="mt-3 flex items-start gap-2.5 text-2xs">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={form.includeAi}
                disabled={!aiReady}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    includeAi: event.target.checked,
                    aiConsent: event.target.checked ? current.aiConsent : false,
                  }))
                }
                aria-label="Include scheduled AI-assisted organisation"
              />
              <span>
                Include AI-assisted category and tag suggestions in scheduled runs
                <span className="mt-0.5 block text-2xs leading-relaxed text-muted-foreground">
                  {aiReady
                    ? "Requires the separate consent below. If the provider, endpoint or model changes, AI is skipped until consent is reconfirmed."
                    : "Configure the Assistant task first. Offline-only scheduling remains available."}
                </span>
              </span>
            </label>
            {form.includeAi && (
              <div className="mt-3 rounded-xl border border-brass/25 bg-brass-soft/35 p-3">
                <label className="flex items-start gap-2.5 text-2xs">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={form.aiConsent}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        aiConsent: event.target.checked,
                      }))
                    }
                    aria-label="Confirm scheduled AI consent"
                  />
                  <span className="min-w-0 break-words">
                    I consent to scheduled AI using this provider
                    <span className="mt-1 block text-2xs leading-relaxed text-muted-foreground">
                      One bounded request per scheduled run sends at most 40 items that
                      need a category or tags. Only item names, descriptions, brand/model,
                      current category/tag names and existing household category/tag names
                      from the selected scope are sent to{" "}
                      <strong className="font-medium text-foreground/80">{aiLabel}</strong>
                      {aiModel ? ` (${aiModel})` : ""}. No photos, locations, receipts,
                      prices, loans, private notes, borrower data or other households are
                      sent. The provider may charge usage or cost; Housetory does not
                      estimate it. Consent is tied to this provider, endpoint and model.
                    </span>
                  </span>
                </label>
                {schedule?.ai_consent_reason && !schedule.ai_consent_valid && (
                  <p className="mt-2 flex items-start gap-1.5 text-2xs text-brass">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>{schedule.ai_consent_reason}</span>
                  </p>
                )}
              </div>
            )}
            <p className="mt-2 text-2xs text-muted-foreground">
              Provider request cap: 1 per scheduled run. AI consent is independent of
              on-demand review and of the provider-level cloud consent.
            </p>
          </div>

          {error && <FormError message={error} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : <CalendarClock />}
            {save.isPending ? "Saving…" : "Save schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewSchedulePanel({
  isOwner,
  schedule: summarySchedule,
  onChanged,
  embedded = false,
}: {
  isOwner: boolean;
  schedule: ReviewScheduleSummary | null | undefined;
  onChanged?: () => void;
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const scheduleQuery = useReviewSchedule(isOwner);
  const aiStatus = useAiStatus("assistant", { refetchOnMount: false });
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const fullSchedule = scheduleQuery.data ?? null;
  const view = isOwner
    ? fullSchedule ?? summarySchedule ?? null
    : summarySchedule ?? null;
  const badge = STATE_BADGES[(view?.state ?? "not_configured") as ReviewScheduleState];
  const aiReady = Boolean(aiStatus.data?.configured);
  const aiLabel =
    aiStatus.data?.provider_label ??
    aiStatus.data?.provider ??
    view?.assistant_provider_label ??
    "the household Assistant task";
  const aiModel = aiStatus.data?.model ?? view?.assistant_model ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.reviewSchedule });
    void queryClient.invalidateQueries({ queryKey: queryKeys.reviewSummary });
    void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
    void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatusSummary });
    onChanged?.();
  };

  return (
    <section
      className={
        embedded
          ? "border-t border-border/60 pt-4"
          : "surface mb-5 p-4 sm:p-5"
      }
      aria-labelledby="review-schedule-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Inventory care schedule
          </p>
          <h2
            id="review-schedule-heading"
            className="mt-1 flex items-center gap-2 font-display text-[1.25rem] tracking-[-0.02em]"
          >
            <CalendarClock className="size-4 text-muted-foreground" strokeWidth={1.7} />
            Scheduled review
          </h2>
          <p className="mt-1 max-w-2xl text-2xs leading-relaxed text-muted-foreground">
            Optional weekly or monthly review. Off by default; scheduled runs only create
            persistent suggestions and never change inventory automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {isOwner && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDialogOpen(true)}
              disabled={scheduleQuery.isPending}
            >
              {scheduleQuery.isPending ? <Spinner /> : <Pencil />}
              {view?.configured ? "Edit schedule" : "Set up schedule"}
            </Button>
          )}
        </div>
      </div>

      {isOwner && scheduleQuery.isPending ? (
        <Skeleton className="mt-3 h-16 rounded-xl" />
      ) : isOwner && scheduleQuery.isError ? (
        <div className="mt-3">
          <FormError message={getApiErrorMessage(scheduleQuery.error)} />
        </div>
      ) : (
        <>
          <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
            {view?.state_detail ?? "No scheduled review has been configured. Automatic review is off."}
          </p>
          <ScheduleStatus schedule={view} />
          {!view?.configured && isOwner && (
            <p className="mt-2 text-2xs text-muted-foreground">
              Set up a schedule to run offline inventory rules automatically. Enabling a
              schedule does not enable AI or make any provider call.
            </p>
          )}
          {view?.include_ai && view.enabled && !view.ai_consent_valid && (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-brass/25 bg-brass-soft/35 px-3 py-2 text-2xs text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-brass" />
              <span>
                Scheduled AI will be skipped and offline rules will still run until the
                owner reconfirms consent for the current Assistant route.
              </span>
            </p>
          )}
          {!isOwner && (
            <p className="mt-2 text-2xs text-muted-foreground">
              Only the household owner can change the schedule or AI consent. All
              members can see whether a run is scheduled.
            </p>
          )}
        </>
      )}

      {isOwner && (
        <ScheduleDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          schedule={fullSchedule}
          aiReady={aiReady}
          aiLabel={aiLabel}
          aiModel={aiModel}
          onSaved={refresh}
        />
      )}
    </section>
  );
}
