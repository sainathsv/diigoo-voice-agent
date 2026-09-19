"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { exitSupport } from "@/server/actions/support-session";

export function SignOutButton({ className = "btn btn-ghost btn-sm" }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        await exitSupport().catch(() => {});
        await authClient.signOut();
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
