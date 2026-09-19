import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/ui";
import { getSession } from "@/server/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (await getSession()) redirect(safeNext);
  return (
    <main className="grid min-h-full place-items-center px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 text-center">
          <Logo />
          <p className="mt-2 text-grey">AI calling for your front office</p>
        </div>
        <div className="card card-pad">
          <h1 className="h-display mb-5 text-[22px]">Sign in</h1>
          <LoginForm next={safeNext} />
        </div>
        <p className="mt-5 text-center text-[12.5px] text-grey">
          New to your team&apos;s workspace? Use the invitation link your admin sent you.
        </p>
      </div>
    </main>
  );
}
