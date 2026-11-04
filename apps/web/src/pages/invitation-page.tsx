import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, LogOut, Mail, ShieldCheck } from "lucide-react";
import * as React from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { AuthLayout } from "@/components/auth-layout";
import { Field, FormError } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, getApiErrorMessage } from "@/lib/api";
import {
  queryKeys,
  useInvitation,
  useLogout,
  useSession,
} from "@/lib/queries";
import type { SessionState } from "@/lib/types";
import { formatDate } from "@/lib/utils";

const ROLE_LABELS = {
  owner: "Owner",
  member: "Member",
  viewer: "Viewer",
} as const;

export function InvitationPage() {
  const { token } = useParams();
  const invitation = useInvitation(token);
  const session = useSession();
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");

  const accept = useMutation({
    mutationFn: () =>
      api.post<SessionState>(`/invitations/${encodeURIComponent(token ?? "")}/accept`, {
        ...(invitation.data?.account_exists ? {} : { name: name.trim(), password }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.session, data);
      toast.success("Invitation accepted");
      navigate("/", { replace: true });
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const invitationError = invitation.isError
    ? getApiErrorMessage(invitation.error)
    : null;
  if (invitation.isPending) {
    return (
      <AuthLayout title="Checking invitation…" subtitle="One moment.">
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </AuthLayout>
    );
  }
  if (invitationError || !invitation.data) {
    return (
      <AuthLayout
        title="Invitation unavailable."
        subtitle="This link may be invalid, expired, revoked or already used."
      >
        <div className="space-y-4">
          <FormError message={invitationError ?? "This invitation link is not valid."} />
          <Button asChild className="w-full">
            <Link to="/login">Back to sign in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const data = invitation.data;
  const currentUser = session.data?.user;
  const emailMatches =
    Boolean(currentUser) &&
    currentUser!.email.toLowerCase() === data.email.toLowerCase();
  const accountExists = data.account_exists;
  const loggedIn = Boolean(session.data?.authenticated && currentUser);
  const needsAccount = !accountExists && !loggedIn;
  const passwordMismatch = Boolean(confirmPassword) && password !== confirmPassword;
  const passwordTooShort = Boolean(password) && password.length < 12;
  const loginHref = `/login`;

  const signOut = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.setQueryData(queryKeys.session, (current: SessionState | undefined) =>
          current
            ? {
                ...current,
                authenticated: false,
                user: null,
                household: null,
                role: null,
              }
            : current,
        );
      },
    });
  };

  return (
    <AuthLayout
      title="You’re invited."
      subtitle={`Join ${data.household_name} on Housetory.`}
    >
      <div className="space-y-5">
        <div className="rounded-xl border border-border/70 bg-card/60 p-4 text-[0.78rem] leading-relaxed text-muted-foreground">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <Mail className="size-4" />
            {data.email}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{ROLE_LABELS[data.role]}</Badge>
            <span>Expires {formatDate(data.expires_at)}</span>
          </p>
          <p className="mt-2">
            {data.role === "viewer"
              ? "Viewers can browse and search the household but cannot change inventory."
              : data.role === "owner"
                ? "Owners can manage people, household settings and AI configuration."
                : "Members can create and manage ordinary inventory."}
          </p>
        </div>

        {loggedIn && !emailMatches && (
          <div className="space-y-3">
            <p className="text-[0.78rem] leading-relaxed text-muted-foreground">
              You are signed in as <strong className="text-foreground">{currentUser!.email}</strong>.
              This invitation belongs to <strong className="text-foreground">{data.email}</strong>.
              Sign out and use the invited email.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={signOut}
              disabled={logout.isPending}
            >
              {logout.isPending ? <Spinner /> : <LogOut />}
              Sign out
            </Button>
          </div>
        )}

        {!loggedIn && accountExists && (
          <div className="space-y-3">
            <p className="text-[0.78rem] leading-relaxed text-muted-foreground">
              An account already exists for this email. Sign in as{" "}
              <strong className="text-foreground">{data.email}</strong> to accept.
            </p>
            <Button asChild className="w-full">
              <Link to={loginHref} state={{ from: location }}>
                Sign in to accept
                <ArrowRight className="ml-auto" />
              </Link>
            </Button>
          </div>
        )}

        {(emailMatches || needsAccount) && (
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (needsAccount) {
                if (!name.trim() || password.length < 12 || password !== confirmPassword) {
                  return;
                }
              }
              accept.mutate();
            }}
          >
            {accept.error && <FormError message={getApiErrorMessage(accept.error)} />}
            {needsAccount && (
              <>
                <Field label="Your name" htmlFor="invite-name">
                  <Input
                    id="invite-name"
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Your name"
                    required
                  />
                </Field>
                <Field
                  label="Choose a password"
                  htmlFor="invite-password"
                  hint="At least 12 characters"
                  error={
                    passwordMismatch
                      ? "The passwords do not match."
                      : passwordTooShort
                        ? "Use at least 12 characters."
                        : undefined
                  }
                >
                  <PasswordInput
                    id="invite-password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    minLength={12}
                  />
                </Field>
                <Field label="Confirm password" htmlFor="invite-confirm-password">
                  <PasswordInput
                    id="invite-confirm-password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    minLength={12}
                  />
                </Field>
              </>
            )}
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={
                accept.isPending ||
                (needsAccount &&
                  (!name.trim() || password.length < 12 || password !== confirmPassword))
              }
            >
              {accept.isPending ? <Spinner /> : <Check />}
              Accept invitation
            </Button>
          </form>
        )}

        {!loggedIn && !accountExists && (
          <p className="text-center text-[0.7rem] leading-relaxed text-muted-foreground">
            Already have an account with another Housetory household?{" "}
            <Link to={loginHref} state={{ from: location }} className="underline underline-offset-4">
              Sign in first
            </Link>
            .
          </p>
        )}

        <p className="flex items-start gap-2 text-[0.68rem] leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          Invitations are single-use and only work for the invited email. Housetory never
          creates inventory automatically.
        </p>
      </div>
    </AuthLayout>
  );
}
