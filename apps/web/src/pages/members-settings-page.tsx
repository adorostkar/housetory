import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Mail,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, FormError } from "@/components/form-field";
import { PageHeader } from "@/components/page-header";
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
  useHouseholdInvitations,
  useHouseholdMembers,
  useSession,
} from "@/lib/queries";
import type {
  HouseholdInvitation,
  HouseholdMember,
  MemberRole,
} from "@/lib/types";
import { formatDate } from "@/lib/utils";

const ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Owner",
  member: "Member",
  viewer: "Viewer",
};

const INVITATION_TONE = {
  pending: "brass",
  accepted: "sage",
  revoked: "outline",
  expired: "outline",
} as const;

export function MembersSettingsPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const membersQuery = useHouseholdMembers();
  const invitationsQuery = useHouseholdInvitations();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<MemberRole>("member");
  const [removeTarget, setRemoveTarget] = React.useState<HouseholdMember | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<HouseholdInvitation | null>(null);
  const isOwner = session.data?.role === "owner";
  const emailConfigured =
    membersQuery.data?.email_configured ?? invitationsQuery.data?.email_configured ?? false;

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.householdMembers });
    void queryClient.invalidateQueries({ queryKey: queryKeys.householdInvitations });
  }, [queryClient]);

  const invite = useMutation({
    mutationFn: () =>
      api.post<HouseholdInvitation>("/household/invitations", {
        email: email.trim(),
        role,
      }),
    onSuccess: () => {
      refresh();
      setInviteOpen(false);
      setEmail("");
      setRole("member");
      toast.success("Invitation sent");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const changeRole = useMutation({
    mutationFn: ({ member, nextRole }: { member: HouseholdMember; nextRole: MemberRole }) =>
      api.patch<HouseholdMember>(`/household/members/${member.user_id}`, {
        role: nextRole,
      }),
    onSuccess: () => {
      refresh();
      toast.success("Member role updated");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const removeMember = useMutation({
    mutationFn: (member: HouseholdMember) =>
      api.delete<void>(`/household/members/${member.user_id}`),
    onSuccess: () => {
      refresh();
      setRemoveTarget(null);
      toast.success("Member removed");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const resend = useMutation({
    mutationFn: (invitation: HouseholdInvitation) =>
      api.post<HouseholdInvitation>(
        `/household/invitations/${invitation.id}/resend`,
      ),
    onSuccess: () => {
      refresh();
      toast.success("Invitation resent");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  const revoke = useMutation({
    mutationFn: (invitation: HouseholdInvitation) =>
      api.delete<void>(`/household/invitations/${invitation.id}`),
    onSuccess: () => {
      refresh();
      setRevokeTarget(null);
      toast.success("Invitation revoked");
    },
    onError: (error) => toast.error(getApiErrorMessage(error)),
  });

  if (!isOwner) {
    return (
      <div className="surface mx-auto max-w-lg p-8 text-center">
        <ShieldCheck className="mx-auto size-8 text-muted-foreground" />
        <h1 className="mt-4 font-display text-3xl tracking-[-0.03em]">Owner only.</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Only a household owner can invite people or change member access.
        </p>
        <Button asChild className="mt-6">
          <Link to="/settings">Back to settings</Link>
        </Button>
      </div>
    );
  }

  const members = membersQuery.data?.members ?? [];
  const invitations = invitationsQuery.data?.items ?? [];

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Household"
        title="Members & invitations"
        description="Accounts are separate from the household. Roles control what each member can do here."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/settings">
                <ArrowLeft />
                Settings
              </Link>
            </Button>
            <Button onClick={() => setInviteOpen(true)} disabled={!emailConfigured}>
              <UserPlus />
              Invite person
            </Button>
          </div>
        }
      />

      {!emailConfigured && (
        <div className="mb-5 rounded-xl border border-brass/25 bg-brass-soft/40 px-4 py-3 text-[0.76rem] leading-relaxed text-muted-foreground">
          Email delivery is not configured, so invitations cannot be sent. Add the SMTP
          settings from <code className="rounded bg-secondary px-1 py-0.5">.env.example</code>{" "}
          and restart the API. Existing login and inventory continue to work.
        </div>
      )}

      <div className="grid max-w-4xl gap-5">
        <section className="surface p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" strokeWidth={1.7} />
            <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Members</h2>
            <Badge variant="outline">{members.length}</Badge>
          </div>
          <p className="mt-1 text-[0.74rem] text-muted-foreground">
            Members can manage inventory. Viewers can browse only. Owners manage people,
            household settings and AI configuration.
          </p>
          {membersQuery.isPending ? (
            <Skeleton className="mt-4 h-40 rounded-xl" />
          ) : membersQuery.isError ? (
            <div className="mt-4">
              <FormError message={getApiErrorMessage(membersQuery.error)} />
            </div>
          ) : (
            <div className="mt-4 divide-y divide-border/60 rounded-xl border border-border/60">
              {members.map((member) => {
                const isSelf = member.user_id === session.data?.user?.id;
                return (
                  <div
                    key={member.user_id}
                    className="flex flex-wrap items-center gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[0.82rem] font-medium">
                        {member.name}
                        {isSelf ? " · you" : ""}
                      </p>
                      <p className="truncate text-[0.7rem] text-muted-foreground">
                        {member.email} · joined {formatDate(member.joined_at)}
                      </p>
                    </div>
                    <Select
                      aria-label={`Role for ${member.name}`}
                      value={member.role}
                      disabled={changeRole.isPending}
                      onChange={(event) =>
                        changeRole.mutate({
                          member,
                          nextRole: event.target.value as MemberRole,
                        })
                      }
                      className="h-9 w-[130px] text-[0.76rem]"
                    >
                      {Object.entries(ROLE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${member.name}`}
                      onClick={() => setRemoveTarget(member)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="surface p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Mail className="size-4 text-muted-foreground" strokeWidth={1.7} />
            <h2 className="font-display text-[1.35rem] tracking-[-0.02em]">Invitations</h2>
          </div>
          <p className="mt-1 text-[0.74rem] text-muted-foreground">
            Invitations are single-use, expire automatically and only work for the invited
            email address.
          </p>
          {invitationsQuery.isPending ? (
            <Skeleton className="mt-4 h-32 rounded-xl" />
          ) : invitationsQuery.isError ? (
            <div className="mt-4">
              <FormError message={getApiErrorMessage(invitationsQuery.error)} />
            </div>
          ) : invitations.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-border/70 px-4 py-8 text-center text-[0.78rem] text-muted-foreground">
              No invitations yet.
            </p>
          ) : (
            <div className="mt-4 divide-y divide-border/60 rounded-xl border border-border/60">
              {invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.82rem] font-medium">
                      {invitation.email}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[0.7rem] text-muted-foreground">
                      <span>{ROLE_LABELS[invitation.role]}</span>
                      <span>·</span>
                      <span>expires {formatDate(invitation.expires_at)}</span>
                    </p>
                  </div>
                  <Badge variant={INVITATION_TONE[invitation.status]}>
                    {invitation.status}
                  </Badge>
                  {(invitation.status === "pending" ||
                    invitation.status === "expired") && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={resend.isPending}
                      onClick={() => resend.mutate(invitation)}
                    >
                      {resend.isPending ? <Spinner /> : <Mail />}
                      Resend
                    </Button>
                  )}
                  {invitation.status !== "accepted" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Revoke invitation for ${invitation.email}`}
                      onClick={() => setRevokeTarget(invitation)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite someone</DialogTitle>
            <DialogDescription>
              They will receive a single-use link. New accounts choose their own password;
              existing accounts must sign in with the invited email first.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (email.trim()) invite.mutate();
            }}
          >
            {invite.error && <FormError message={getApiErrorMessage(invite.error)} />}
            <Field label="Email" htmlFor="invite-email">
              <Input
                id="invite-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="person@example.com"
                required
              />
            </Field>
            <Field label="Role" htmlFor="invite-role">
              <Select
                id="invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value as MemberRole)}
              >
                <option value="member">Member — manage inventory</option>
                <option value="viewer">Viewer — read only</option>
                <option value="owner">Owner — full administration</option>
              </Select>
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setInviteOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={invite.isPending || !email.trim() || !emailConfigured}
              >
                {invite.isPending ? <Spinner /> : <Check />}
                Send invitation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={`Remove ${removeTarget?.name}?`}
        description="Their household access and active sessions for this household are revoked immediately. Their account and any other household memberships are not deleted."
        confirmLabel="Remove member"
        onConfirm={async () => {
          if (removeTarget) await removeMember.mutateAsync(removeTarget);
        }}
      />

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Revoke this invitation?"
        description="The invite link will stop working immediately. You can send a new invitation later."
        confirmLabel="Revoke invitation"
        onConfirm={async () => {
          if (revokeTarget) await revoke.mutateAsync(revokeTarget);
        }}
      />
    </div>
  );
}
