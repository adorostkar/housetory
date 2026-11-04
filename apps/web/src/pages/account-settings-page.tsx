import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, KeyRound, UserRound } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Field, FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
import { PasswordInput } from "@/components/password-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useSession } from "@/lib/queries";
import type { SessionState, User } from "@/lib/types";

const ROLE_LABELS = {
  owner: "Owner",
  member: "Member",
  viewer: "Viewer",
} as const;

export function AccountSettingsPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(session.data?.user?.name ?? "");
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");

  React.useEffect(() => {
    setName(session.data?.user?.name ?? "");
  }, [session.data?.user?.name]);

  const saveName = useMutation({
    mutationFn: () => api.patch<User>("/account", { name: name.trim() }),
    onSuccess: (user) => {
      queryClient.setQueryData<SessionState>(queryKeys.session, (current) =>
        current ? { ...current, user } : current,
      );
      toast.success("Account name updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post<void>("/account/password", {
        current_password: currentPassword,
        new_password: newPassword,
      }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  if (session.isPending) {
    return <Skeleton className="h-72 rounded-2xl" />;
  }
  if (!session.data?.authenticated || !session.data.user) return null;

  const role = session.data.role;
  const passwordMismatch = Boolean(confirmPassword) && newPassword !== confirmPassword;
  const passwordTooShort = Boolean(newPassword) && newPassword.length < 12;

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Account"
        title="Your account"
        description="Your sign-in identity is separate from the household. Household access is granted through membership."
        actions={
          <Button variant="outline" asChild>
            <Link to="/settings">
              <ArrowLeft />
              Settings
            </Link>
          </Button>
        }
      />

      <div className="grid max-w-3xl gap-5">
        <section className="surface p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <UserRound className="size-4 text-muted-foreground" strokeWidth={1.7} />
            <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Profile</h2>
          </div>
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) saveName.mutate();
            }}
          >
            {saveName.error && <FormError message={getApiErrorMessage(saveName.error)} />}
            <Field label="Name" htmlFor="account-name">
              <Input
                id="account-name"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="grid gap-3 text-[0.78rem] sm:grid-cols-2">
              <div>
                <p className="text-muted-foreground">Email</p>
                <p className="mt-1 break-all text-foreground">{session.data.user.email}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Household role</p>
                <p className="mt-1">
                  {role ? (
                    <Badge variant={role === "owner" ? "sage" : "outline"}>
                      {ROLE_LABELS[role]}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">No household access</span>
                  )}
                </p>
              </div>
            </div>
            <Button type="submit" disabled={saveName.isPending || !name.trim()}>
              {saveName.isPending ? <Spinner /> : <Check />}
              Save name
            </Button>
          </form>
        </section>

        <section className="surface p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" strokeWidth={1.7} />
            <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Password</h2>
          </div>
          <p className="mt-1 text-[0.74rem] leading-relaxed text-muted-foreground">
            Changing your password signs out your other sessions. The current session stays
            active.
          </p>
          <form
            className="mt-4 max-w-lg space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                currentPassword &&
                newPassword.length >= 12 &&
                newPassword === confirmPassword
              ) {
                changePassword.mutate();
              }
            }}
          >
            {changePassword.error && (
              <FormError message={getApiErrorMessage(changePassword.error)} />
            )}
            <Field label="Current password" htmlFor="account-current-password">
              <PasswordInput
                id="account-current-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field
              label="New password"
              htmlFor="account-new-password"
              hint="At least 12 characters"
            >
              <PasswordInput
                id="account-new-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
            <Field
              label="Confirm new password"
              htmlFor="account-confirm-password"
              error={
                passwordMismatch
                  ? "The passwords do not match."
                  : passwordTooShort
                    ? "Use at least 12 characters."
                    : undefined
              }
            >
              <PasswordInput
                id="account-confirm-password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              disabled={
                changePassword.isPending ||
                !currentPassword ||
                newPassword.length < 12 ||
                newPassword !== confirmPassword
              }
            >
              {changePassword.isPending ? <Spinner /> : <Check />}
              Update password
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
