import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import * as React from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { AuthLayout } from "@/components/auth-layout";
import { Field, FormError } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, api, getApiErrorMessage } from "@/lib/api";
import { queryKeys, useSession } from "@/lib/queries";
import type { SessionState } from "@/lib/types";

export function SetupPage() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = React.useState({
    name: "",
    email: "",
    password: "",
    household_name: "My Home",
  });

  const setup = useMutation({
    mutationFn: () =>
      api.post<SessionState>("/auth/setup", {
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
        household_name: values.household_name.trim(),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.session, data);
      // Straight into the inventory, where the first item is added.
      navigate("/items", { replace: true });
    },
  });

  if (session?.authenticated) return <Navigate to="/items" replace />;
  if (session && !session.setup_required) return <Navigate to="/login" replace />;

  const fieldErrors = setup.error instanceof ApiError ? setup.error.fields : undefined;
  const generalError =
    setup.error && !fieldErrors ? getApiErrorMessage(setup.error) : undefined;

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setup.mutate();
  };

  return (
    <AuthLayout
      title="Make this home yours."
      subtitle="Two short steps: your account and your home. Then you add your first item."
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {generalError && <FormError message={generalError} />}

        <h2 className="eyebrow">1 · Your account</h2>

        <Field label="Your name" htmlFor="name" error={fieldErrors?.name}>
          <Input
            id="name"
            name="name"
            autoComplete="name"
            autoFocus
            required
            value={values.name}
            onChange={(event) => setValues({ ...values, name: event.target.value })}
            placeholder="Ada Lovelace"
          />
        </Field>

        <Field label="Email" htmlFor="email" error={fieldErrors?.email}>
          <Input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={values.email}
            onChange={(event) => setValues({ ...values, email: event.target.value })}
            placeholder="you@example.com"
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          hint="At least 12 characters"
          error={fieldErrors?.password}
        >
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={values.password}
            onChange={(event) => setValues({ ...values, password: event.target.value })}
            placeholder="A long, memorable passphrase"
          />
        </Field>

        <h2 className="eyebrow pt-2">2 · Your home</h2>

        <Field
          label="Household name"
          htmlFor="household_name"
          hint="The home you keep track of. You can rename it later."
          error={fieldErrors?.household_name}
        >
          <Input
            id="household_name"
            name="household_name"
            autoComplete="organization"
            required
            value={values.household_name}
            onChange={(event) => setValues({ ...values, household_name: event.target.value })}
            placeholder="My Home"
          />
        </Field>

        <Button type="submit" size="lg" className="mt-2 w-full" disabled={setup.isPending}>
          {setup.isPending ? <Spinner /> : null}
          {setup.isPending ? "Preparing your home…" : "Create account and home"}
          {!setup.isPending && <ArrowRight className="ml-auto" />}
        </Button>

        <p className="text-pretty text-center text-2xs leading-relaxed text-muted-foreground">
          You become the owner of this home. This setup runs once. Other people
          join later by invitation.
        </p>
      </form>
    </AuthLayout>
  );
}
