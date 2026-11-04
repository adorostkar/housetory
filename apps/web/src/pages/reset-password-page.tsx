import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, KeyRound } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";

import { AuthLayout } from "@/components/auth-layout";
import { Field, FormError } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";

export function ResetPasswordPage() {
  const { token } = useParams();
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [complete, setComplete] = React.useState(false);
  const status = useQuery({
    queryKey: ["password-reset", token ?? ""],
    queryFn: () =>
      api.get<{ valid: boolean; expires_at: string | null }>(
        `/auth/password-reset/${encodeURIComponent(token ?? "")}`,
      ),
    enabled: Boolean(token),
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: () =>
      api.post<{ message: string }>("/auth/password-reset/confirm", {
        token,
        password,
      }),
    onSuccess: () => {
      setComplete(true);
      toast.success("Password reset");
    },
  });

  const mismatch = Boolean(confirmPassword) && password !== confirmPassword;
  const tooShort = Boolean(password) && password.length < 12;

  if (status.isPending) {
    return (
      <AuthLayout title="Checking reset link…" subtitle="One moment.">
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </AuthLayout>
    );
  }
  if (!token || status.isError || !status.data?.valid) {
    return (
      <AuthLayout
        title="Reset link unavailable."
        subtitle="This link may be invalid, expired or already used."
      >
        <div className="space-y-4">
          <FormError
            message={
              status.isError
                ? getApiErrorMessage(status.error)
                : "Request a new password reset link."
            }
          />
          <Button asChild className="w-full">
            <Link to="/forgot-password">Request a new link</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }
  if (complete) {
    return (
      <AuthLayout
        title="Password updated."
        subtitle="Existing sessions were signed out. Use the new password to sign in."
      >
        <Button asChild className="w-full">
          <Link to="/login">
            <Check />
            Sign in
          </Link>
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password."
      subtitle="This single-use link expires automatically. Resetting signs out existing sessions."
    >
      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (password.length >= 12 && password === confirmPassword) {
            confirm.mutate();
          }
        }}
      >
        {confirm.error && <FormError message={getApiErrorMessage(confirm.error)} />}
        <Field
          label="New password"
          htmlFor="reset-password"
          hint="At least 12 characters"
          error={tooShort ? "Use at least 12 characters." : undefined}
        >
          <PasswordInput
            id="reset-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={12}
          />
        </Field>
        <Field
          label="Confirm new password"
          htmlFor="reset-confirm-password"
          error={mismatch ? "The passwords do not match." : undefined}
        >
          <PasswordInput
            id="reset-confirm-password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            minLength={12}
          />
        </Field>
        <Button
          type="submit"
          className="w-full"
          disabled={
            confirm.isPending ||
            password.length < 12 ||
            password !== confirmPassword
          }
        >
          {confirm.isPending ? <Spinner /> : <KeyRound />}
          Update password
        </Button>
        <Button asChild variant="ghost" className="w-full">
          <Link to="/login">
            <ArrowLeft />
            Back to sign in
          </Link>
        </Button>
      </form>
    </AuthLayout>
  );
}
