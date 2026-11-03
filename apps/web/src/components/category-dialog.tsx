import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
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
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/queries";
import type { Category } from "@/lib/types";
import { cn } from "@/lib/utils";

const COLORS = ["#8A9A82", "#B58B5A", "#8A94A6", "#B07D6E", "#7E8782", "#A48E6C"];

export function CategoryDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (category: Category) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(COLORS[0] ?? null);

  useEffect(() => {
    if (open) {
      setName("");
      setColor(COLORS[0] ?? null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.post<Category>("/categories", {
        name: name.trim(),
        color,
      }),
    onSuccess: (category) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
      onCreated(category);
      toast.success("Category added");
      onOpenChange(false);
    },
  });

  const fieldErrors = create.error instanceof ApiError ? create.error.fields : undefined;
  const generalError = create.error && !fieldErrors ? getApiErrorMessage(create.error) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>
            Group similar things across every room — kitchenware, tools, textiles.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            create.mutate();
          }}
        >
          {generalError && <FormError message={generalError} />}
          <Field label="Category name" htmlFor="category-name" error={fieldErrors?.name}>
            <Input
              id="category-name"
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kitchenware"
            />
          </Field>
          <Field label="Colour" htmlFor="category-color">
            <div className="flex flex-wrap items-center gap-2" id="category-color">
              <button
                type="button"
                onClick={() => setColor(null)}
                className={cn(
                  "size-8 rounded-full border border-border bg-card text-[0.6rem] text-muted-foreground transition-shadow",
                  color === null && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
                aria-label="No colour"
                aria-pressed={color === null}
              >
                —
              </button>
              {COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setColor(swatch)}
                  className={cn(
                    "size-8 rounded-full transition-shadow",
                    color === swatch &&
                      "ring-2 ring-ring ring-offset-2 ring-offset-background",
                  )}
                  style={{ backgroundColor: swatch }}
                  aria-label={`Use colour ${swatch}`}
                  aria-pressed={color === swatch}
                />
              ))}
            </div>
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending && <Spinner />}
              Add category
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
