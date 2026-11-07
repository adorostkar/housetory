import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Download,
  FileDown,
  LayoutTemplate,
  Printer,
  Settings2,
} from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { useContainers, useLabelTemplates } from "@/lib/queries";
import type { LabelGeometry, LabelLayout, LabelPreset } from "@/lib/types";
import { cn, pluralize } from "@/lib/utils";

const CALIBRATION_KEY = "housetory-label-calibration";

interface Calibration {
  offsetX: number;
  offsetY: number;
}

function loadCalibration(): Calibration {
  try {
    const raw = window.localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return { offsetX: 0, offsetY: 0 };
    const parsed = JSON.parse(raw) as Partial<Calibration>;
    return {
      offsetX: Number(parsed.offsetX) || 0,
      offsetY: Number(parsed.offsetY) || 0,
    };
  } catch {
    return { offsetX: 0, offsetY: 0 };
  }
}

function geometryFromPreset(preset: LabelPreset): LabelGeometry {
  return {
    paper_width_mm: preset.paper_width_mm,
    paper_height_mm: preset.paper_height_mm,
    label_width_mm: preset.label_width_mm,
    label_height_mm: preset.label_height_mm,
    columns: preset.columns,
    rows: preset.rows,
    top_margin_mm: preset.top_margin_mm,
    left_margin_mm: preset.left_margin_mm,
    horizontal_pitch_mm: preset.horizontal_pitch_mm,
    vertical_pitch_mm: preset.vertical_pitch_mm,
  };
}

export function LabelsPage() {
  const [searchParams] = useSearchParams();
  const templatesQuery = useLabelTemplates();
  const containersQuery = useContainers({ include_fixed: true, include_owned: true });
  const containers = containersQuery.data?.items ?? [];
  const templates = templatesQuery.data?.items ?? [];
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [initialized, setInitialized] = React.useState(false);
  const [template, setTemplate] = React.useState("L7165");
  const [layout, setLayout] = React.useState<LabelLayout>("standard");
  const [copies, setCopies] = React.useState(1);
  const [startSlot, setStartSlot] = React.useState(0);
  const [calibration, setCalibration] = React.useState<Calibration>(() => loadCalibration());
  const [custom, setCustom] = React.useState<LabelGeometry | null>(null);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const preset = templates.find((entry) => entry.code === template);
  const geometry =
    template === "custom"
      ? custom
      : preset
        ? geometryFromPreset(preset)
        : null;
  const labelsPerSheet = geometry ? geometry.columns * geometry.rows : 8;

  React.useEffect(() => {
    if (initialized || containers.length === 0 || templates.length === 0) return;
    const ids = searchParams.get("ids");
    const roomId = searchParams.get("room_id");
    let chosen = new Set<string>();
    if (ids) chosen = new Set(ids.split(",").filter(Boolean));
    else if (roomId) {
      chosen = new Set(
        containers
          .filter((container) => container.room_id === roomId && container.is_container)
          .map((container) => container.id),
      );
    } else {
      chosen = new Set(containers.filter((container) => container.is_container).map((c) => c.id));
    }
    setSelected(chosen);
    const defaultTemplate = templates.find(
      (entry) => entry.code === (templatesQuery.data?.default ?? "L7165"),
    );
    if (defaultTemplate) {
      setTemplate(defaultTemplate.code);
      setLayout(defaultTemplate.default_layout);
      setCustom(geometryFromPreset(defaultTemplate));
    }
    setInitialized(true);
  }, [initialized, containers, templates, templatesQuery.data?.default, searchParams]);

  React.useEffect(() => {
    window.localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
  }, [calibration]);

  const requestPayload = (record: boolean) => ({
    location_ids: Array.from(selected),
    template,
    layout,
    copies,
    start_slot: startSlot,
    offset_x_mm: calibration.offsetX,
    offset_y_mm: calibration.offsetY,
    record,
    custom: template === "custom" ? custom : null,
  });

  const preview = useMutation({
    mutationFn: () => api.postBlob("/labels/pdf", requestPayload(false)),
    onSuccess: (blob) => {
      setPreviewError(null);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(blob);
      });
    },
    onError: (error) => {
      setPreviewError(getApiErrorMessage(error));
    },
  });

  React.useEffect(() => {
    if (selected.size === 0) {
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }
    const handle = window.setTimeout(() => preview.mutate(), 450);
    return () => window.clearTimeout(handle);
    // The full payload is represented by these stable inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected,
    template,
    layout,
    copies,
    startSlot,
    calibration.offsetX,
    calibration.offsetY,
    custom,
  ]);

  React.useEffect(
    () => () => {
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    },
    [],
  );

  const download = useMutation({
    mutationFn: () => api.postBlob("/labels/pdf", requestPayload(true)),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `housetory-labels-${template}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Label PDF generated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const calibrationDownload = useMutation({
    mutationFn: () =>
      api.postBlob("/labels/calibration.pdf", {
        template,
        custom: template === "custom" ? custom : null,
        offset_x_mm: calibration.offsetX,
        offset_y_mm: calibration.offsetY,
        start_slot: startSlot,
      }),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `housetory-calibration-${template}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Calibration sheet generated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectPreset = (next: LabelPreset) => {
    setTemplate(next.code);
    setLayout(next.default_layout);
    setCustom(geometryFromPreset(next));
    if (startSlot >= next.columns * next.rows) setStartSlot(0);
  };



  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Printable labels"
        title="Labels"
        description="Preview and print A4 adhesive labels with the permanent identifier, optional display name and a live QR code. Print at 100% / Actual size."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/containers">Containers</Link>
            </Button>
            <Button
              disabled={download.isPending || selected.size === 0 || template === "custom" && !custom}
              onClick={() => download.mutate()}
            >
              {download.isPending ? <Spinner /> : <FileDown />}
              Download PDF
            </Button>
          </>
        }
      />

      {containersQuery.data?.qr_warning && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-brass/25 bg-brass-soft/45 px-4 py-3 text-[0.75rem] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brass" />
          <span>{containersQuery.data.qr_warning}</span>
        </div>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          <section className="surface p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <LayoutTemplate className="size-4 text-muted-foreground" />
              <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Template</h2>
            </div>
            {templatesQuery.isPending ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-20 rounded-xl" />
                ))}
              </div>
            ) : (
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {templates.map((entry) => (
                  <button
                    key={entry.code}
                    type="button"
                    onClick={() => selectPreset(entry)}
                    className={cn(
                      "rounded-xl border px-3.5 py-3 text-left transition-colors",
                      template === entry.code
                        ? "border-sage/50 bg-sage-soft/35"
                        : "border-border/70 hover:bg-secondary/30",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[0.8rem] font-medium">{entry.name}</span>
                      {entry.manufacturer_code && (
                        <Badge variant="outline">{entry.manufacturer_code}</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-[0.68rem] text-muted-foreground">
                      {entry.description}
                    </p>
                    <p className="mt-1 text-[0.66rem] text-muted-foreground">
                      {entry.columns} × {entry.rows} = {entry.columns * entry.rows} per A4
                    </p>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setTemplate("custom");
                    setCustomOpen(true);
                    if (!custom && preset) setCustom(geometryFromPreset(preset));
                  }}
                  className={cn(
                    "rounded-xl border px-3.5 py-3 text-left transition-colors",
                    template === "custom"
                      ? "border-sage/50 bg-sage-soft/35"
                      : "border-dashed border-border/70 hover:bg-secondary/30",
                  )}
                >
                  <span className="text-[0.8rem] font-medium">Custom geometry</span>
                  <p className="mt-1 text-[0.68rem] text-muted-foreground">
                    Paper, label size, margins, rows, columns and pitch.
                  </p>
                </button>
              </div>
            )}

            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="label-layout" className="text-[0.75rem] font-medium">
                  Layout
                </label>
                <Select
                  id="label-layout"
                  value={layout}
                  onChange={(event) => setLayout(event.target.value as LabelLayout)}
                  className="mt-1.5"
                >
                  <option value="compact">Compact</option>
                  <option value="standard">Standard</option>
                  <option value="detailed">Detailed</option>
                </Select>
              </div>
              <div>
                <label htmlFor="label-copies" className="text-[0.75rem] font-medium">
                  Copies per container
                </label>
                <Input
                  id="label-copies"
                  type="number"
                  min={1}
                  max={100}
                  value={copies}
                  onChange={(event) =>
                    setCopies(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
                  }
                  className="mt-1.5"
                />
              </div>
              <div>
                <label htmlFor="label-start" className="text-[0.75rem] font-medium">
                  First empty position
                </label>
                <Select
                  id="label-start"
                  value={startSlot}
                  onChange={(event) => setStartSlot(Number(event.target.value))}
                  className="mt-1.5"
                >
                  {Array.from({ length: labelsPerSheet }).map((_, index) => (
                    <option key={index} value={index}>
                      Position {index + 1}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <p className="text-[0.72rem] font-medium text-muted-foreground">
                  Partially used sheet preview
                </p>
                <p className="text-[0.66rem] text-muted-foreground">
                  Positions before {startSlot + 1} stay blank
                </p>
              </div>
              <div
                className="mt-2 grid gap-1 rounded-xl border border-border/60 bg-secondary/20 p-2"
                style={{ gridTemplateColumns: `repeat(${geometry?.columns ?? 2}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: labelsPerSheet }).map((_, index) => {
                  const used = index < startSlot;
                  const printable = index >= startSlot && index < startSlot + selected.size * copies;
                  return (
                    <button
                      key={index}
                      type="button"
                      onClick={() => setStartSlot(index)}
                      className={cn(
                        "flex h-9 items-center justify-center rounded border text-[0.62rem] tabular-nums",
                        index === startSlot
                          ? "border-primary bg-primary text-primary-foreground"
                          : used
                            ? "border-border/50 bg-border/25 text-muted-foreground line-through"
                            : printable
                              ? "border-sage/40 bg-sage-soft/50 text-foreground"
                              : "border-border/60 text-muted-foreground",
                      )}
                      title={`Start at position ${index + 1}`}
                    >
                      {index + 1}
                    </button>
                  );
                })}
              </div>
            </div>

            {template === "custom" && customOpen && custom && (
              <div className="mt-5 rounded-xl border border-border/60 p-4">
                <p className="text-[0.78rem] font-medium">Custom label geometry</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["paper_width_mm", "Paper width (mm)"],
                      ["paper_height_mm", "Paper height (mm)"],
                      ["label_width_mm", "Label width (mm)"],
                      ["label_height_mm", "Label height (mm)"],
                      ["columns", "Columns"],
                      ["rows", "Rows"],
                      ["top_margin_mm", "Top margin (mm)"],
                      ["left_margin_mm", "Left margin (mm)"],
                      ["horizontal_pitch_mm", "Horizontal pitch (mm)"],
                      ["vertical_pitch_mm", "Vertical pitch (mm)"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key}>
                      <label htmlFor={`custom-${key}`} className="text-[0.68rem] text-muted-foreground">
                        {label}
                      </label>
                      <Input
                        id={`custom-${key}`}
                        type="number"
                        step={key === "columns" || key === "rows" ? 1 : 0.1}
                        value={custom[key]}
                        onChange={(event) =>
                          setCustom({
                            ...custom,
                            [key]: Number(event.target.value),
                          })
                        }
                        className="mt-1 h-8 text-[0.75rem]"
                      />
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[0.66rem] text-muted-foreground">
                  The server validates that every label fits inside the paper.
                </p>
              </div>
            )}
          </section>

          <section className="surface p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <Printer className="size-4 text-muted-foreground" />
              <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Preview</h2>
              <Badge variant="outline">{pluralize(selected.size * copies, "label")}</Badge>
            </div>
            {previewError && (
              <div className="mt-3">
                <FormError message={previewError} />
              </div>
            )}
            <div className="mt-4 overflow-hidden rounded-xl border border-border/70 bg-secondary/20">
              {preview.isPending && !previewUrl ? (
                <div className="flex h-[520px] items-center justify-center gap-2 text-[0.8rem] text-muted-foreground">
                  <Spinner />
                  Building preview…
                </div>
              ) : previewUrl ? (
                <iframe
                  title="Label sheet preview"
                  src={previewUrl}
                  className="h-[520px] w-full bg-white"
                />
              ) : (
                <div className="flex h-[520px] items-center justify-center px-6 text-center text-[0.8rem] text-muted-foreground">
                  Select at least one container to preview a label sheet.
                </div>
              )}
            </div>
            {preview.isPending && previewUrl && (
              <p className="mt-2 flex items-center gap-1.5 text-[0.68rem] text-muted-foreground">
                <Spinner /> Refreshing preview…
              </p>
            )}
          </section>
        </div>

        <aside className="space-y-5 xl:sticky xl:top-8">
          <section className="surface p-4 sm:p-5">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              Containers on this sheet
            </h2>
            <div className="mt-3 max-h-[320px] space-y-1 overflow-y-auto pr-1">
              {containersQuery.isPending ? (
                <p className="py-6 text-center text-[0.75rem] text-muted-foreground">
                  Loading…
                </p>
              ) : containers.length === 0 ? (
                <p className="py-6 text-center text-[0.75rem] text-muted-foreground">
                  No containers yet.
                </p>
              ) : (
                containers.map((container) => (
                  <label
                    key={container.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-[0.74rem] transition-colors hover:bg-secondary/40",
                      selected.has(container.id) && "bg-secondary/35",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(container.id)}
                      onChange={() => toggle(container.id)}
                      className="mt-0.5 size-3.5 accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {container.identifier ?? container.name}
                      </span>
                      <span className="block truncate text-[0.64rem] text-muted-foreground">
                        {container.name !== container.identifier ? container.name : "Unnamed"} ·{" "}
                        {container.total_item_count} items
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() =>
                  setSelected(new Set(containers.filter((entry) => entry.is_container).map((entry) => entry.id)))
                }
              >
                Select all
              </Button>
              <Button variant="ghost" size="sm" className="flex-1" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          </section>

          <section className="surface p-4 sm:p-5">
            <h2 className="flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
              <Settings2 className="size-3.5" /> Calibration
            </h2>
            <p className="mt-2 text-[0.7rem] leading-relaxed text-muted-foreground">
              Print the calibration sheet on plain paper, hold it against a label sheet,
              then adjust the offsets until the outlines align. Settings are saved in this
              browser.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="offset-x" className="text-[0.68rem] text-muted-foreground">
                  Horizontal (mm)
                </label>
                <Input
                  id="offset-x"
                  type="number"
                  step="0.1"
                  min={-15}
                  max={15}
                  value={calibration.offsetX}
                  onChange={(event) =>
                    setCalibration((current) => ({
                      ...current,
                      offsetX: Number(event.target.value) || 0,
                    }))
                  }
                  className="mt-1 h-8 text-[0.75rem]"
                />
              </div>
              <div>
                <label htmlFor="offset-y" className="text-[0.68rem] text-muted-foreground">
                  Vertical (mm)
                </label>
                <Input
                  id="offset-y"
                  type="number"
                  step="0.1"
                  min={-15}
                  max={15}
                  value={calibration.offsetY}
                  onChange={(event) =>
                    setCalibration((current) => ({
                      ...current,
                      offsetY: Number(event.target.value) || 0,
                    }))
                  }
                  className="mt-1 h-8 text-[0.75rem]"
                />
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={calibrationDownload.isPending}
                onClick={() => calibrationDownload.mutate()}
              >
                {calibrationDownload.isPending ? <Spinner /> : <Download />}
                Download calibration sheet
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCalibration({ offsetX: 0, offsetY: 0 })}
              >
                Reset offsets
              </Button>
            </div>
          </section>

          <section className="surface p-4 text-[0.7rem] leading-relaxed text-muted-foreground">
            <p className="flex items-center gap-1.5 font-medium text-foreground/80">
              <Check className="size-3.5 text-sage" />
              Printer checklist
            </p>
            <p className="mt-2">
              Use A4 label sheets, choose <strong className="text-foreground/80">100%</strong> or{" "}
              <strong className="text-foreground/80">Actual size</strong>, and disable “Fit to
              page”. The PDF page is exactly A4.
            </p>
            <p className="mt-2">
              QR codes are generated locally as vectors. The permanent identifier and
              optional display name are drawn with embedded DejaVu fonts.
            </p>
            <p className="mt-2">
              Labels never print item names, counts, contents, or the current room. The QR
              always opens the current authenticated container page, so moved or changed
              contents do not make the printed label wrong.
            </p>
          </section>
        </aside>
      </div>

      {containers.length === 0 && !containersQuery.isPending && (
        <div className="mt-6">
          <EmptyState
            title="Create a container before printing."
            description="Housetory assigns a permanent identifier and QR code automatically, even when you do not give the box a name."
            actionLabel="Create a container"
            actionTo="/containers"
          />
        </div>
      )}
    </div>
  );
}
