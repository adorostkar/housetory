import { LogOut, Mail } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLogout, useSession } from "@/lib/queries";

export function NoHouseholdPage() {
  const session = useSession();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <AuthLayout
      title="Account not linked."
      subtitle="This account is signed in, but it does not have access to a household yet."
    >
      <div className="space-y-4 text-[0.78rem] leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 p-4 text-foreground">
          <Mail className="size-4 shrink-0" />
          <span className="min-w-0 break-all">{session.data?.user?.email}</span>
        </p>
        <p>
          Ask a household owner for an invitation, then open the invitation link from your
          email. Accepting it attaches this account to the household without creating a
          second account.
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
