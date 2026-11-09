import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, Mail } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { AuthLayout } from "@/components/auth-layout";
import { Field, FormError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";

export function ForgotPasswordPage() {
  const [email, setEmail] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const request = useMutation({
    mutationFn: () =>
      api.post<{ message: string }>("/auth/password-reset/request", {
        email: email.trim(),
      }),
    onSuccess: () => setSubmitted(true),
  });

  return (
    <AuthLayout
      title="Reset your password."
      subtitle="Enter your account email. The response is the same whether or not an account exists."
    >
      {submitted ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-sage/25 bg-sage-soft/40 p-4 text-xs leading-relaxed text-muted-foreground">
            If an account exists for that email, a reset link has been sent. The link is
            single-use and expires automatically.
          </div>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            If this installation has not configured email delivery, contact the household
            owner. Login and inventory continue to work while email is unconfigured.
          </p>
          <Button asChild variant="outline" className="w-full">
            <Link to="/login">
              <ArrowLeft />
              Back to sign in
            </Link>
          </Button>
        </div>
      ) : (
        <form
          className="space-y-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim()) request.mutate();
          }}
        >
          {request.error && <FormError message={getApiErrorMessage(request.error)} />}
          <Field label="Email" htmlFor="forgot-email">
            <Input
              id="forgot-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </Field>
          <Button type="submit" className="w-full" disabled={request.isPending || !email.trim()}>
            {request.isPending ? <Spinner /> : <Mail />}
            Send reset link
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <Link to="/login">
              <ArrowLeft />
              Back to sign in
            </Link>
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
