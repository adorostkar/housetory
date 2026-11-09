import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import * as React from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { AuthLayout } from "@/components/auth-layout";
import { Field, FormError } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useSession } from "@/lib/queries";
import type { SessionState } from "@/lib/types";

interface LocationState {
  from?: { pathname?: string };
}

export function LoginPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  const login = useMutation({
    mutationFn: () =>
      api.post<SessionState>("/auth/login", {
        email: email.trim(),
        password,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.session, data);
      const state = location.state as LocationState | null;
      const destination = state?.from?.pathname;
      navigate(destination?.startsWith("/") ? destination : "/", { replace: true });
    },
  });

  if (session?.setup_required) return <Navigate to="/setup" replace />;
  if (session?.authenticated) return <Navigate to="/" replace />;

  const fieldErrors = login.error instanceof ApiError ? login.error.fields : undefined;
  const generalError =
    login.error && !fieldErrors ? getApiErrorMessage(login.error) : undefined;

  return (
    <AuthLayout
      title="Welcome back."
      subtitle="Your home is exactly as you left it. Sign in to pick up where you paused."
    >
      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        {generalError && <FormError message={generalError} />}

        <Field label="Email" htmlFor="email" error={fieldErrors?.email}>
          <Input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        <Field label="Password" htmlFor="password" error={fieldErrors?.password}>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Your passphrase"
          />
        </Field>

        <Button type="submit" size="lg" className="mt-2 w-full" disabled={login.isPending}>
          {login.isPending ? <Spinner /> : null}
          {login.isPending ? "Signing in…" : "Sign in"}
          {!login.isPending && <ArrowRight className="ml-auto" />}
        </Button>

        <div className="text-center">
          <Link
            to="/forgot-password"
            className="text-2xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Forgot password?
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
