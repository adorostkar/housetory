import { LogOut, Mail, Plus } from "lucide-react";
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { AuthLayout } from "@/components/auth-layout";
import { Field, FormError } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { getApiErrorMessage } from "@/lib/api";
import { useCreateHousehold, useLogout, useSession } from "@/lib/queries";

export function NoHouseholdPage() {
  const session = useSession();
  const logout = useLogout();
  const create = useCreateHousehold();
  const navigate = useNavigate();
  const [name, setName] = React.useState("");
  const [propertyName, setPropertyName] = React.useState("Home");

  return (
    <AuthLayout
      title="Start a household."
      subtitle="This account is signed in but is not a member of a household yet. Create one, or open an invitation from an owner."
    >
      <div className="space-y-5 text-[0.78rem] leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 p-4 text-foreground">
          <Mail className="size-4 shrink-0" />
          <span className="min-w-0 break-all">{session.data?.user?.email}</span>
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !propertyName.trim()) return;
            create.mutate(
              { name: name.trim(), property_name: propertyName.trim() },
              {
                onSuccess: () => {
                  toast.success("Household created");
                  navigate("/", { replace: true });
                },
                onError: (error) => toast.error(getApiErrorMessage(error)),
              },
            );
          }}
        >
          {create.error && <FormError message={getApiErrorMessage(create.error)} />}
          <Field label="Household name" htmlFor="no-household-name">
            <Input
              id="no-household-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="My Home"
              required
            />
          </Field>
          <Field label="First property" htmlFor="no-household-property">
            <Input
              id="no-household-property"
              value={propertyName}
              onChange={(event) => setPropertyName(event.target.value)}
              maxLength={120}
              required
            />
          </Field>
          <Button
            type="submit"
            className="w-full"
            disabled={create.isPending || !name.trim() || !propertyName.trim()}
          >
            {create.isPending ? <Spinner /> : <Plus />}
            Create household
          </Button>
        </form>
        <p className="rounded-xl border border-border/70 bg-card/40 p-4">
          Have an invitation? Open the invitation link from your email while signed
          in as the invited address. Invitations are bound to one household, email
          and role.
        </p>
        <Button
          variant="outline"
          className="w-full"
          disabled={logout.isPending}
          onClick={() =>
            logout.mutate(undefined, {
              onSuccess: () => navigate("/login", { replace: true }),
            })
          }
        >
          {logout.isPending ? <Spinner /> : <LogOut />}
          Sign out
        </Button>
      </div>
    </AuthLayout>
  );
}
