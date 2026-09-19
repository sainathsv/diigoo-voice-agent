import type { Metadata } from "next";
import { PageHead, Section } from "@/components/ui";
import { requirePlatform } from "@/server/platform/context";
import { NewClientForm } from "./new-client-form";

export const metadata: Metadata = { title: "New client" };

export default async function NewClientPage() {
  await requirePlatform("platform:clients.manage");
  return (
    <>
      <PageHead title="New client" sub="Creates the workspace in onboarding, its first branch, the 10-step go-live checklist and the Owner's invitation. Nothing goes live until every check passes." />
      <Section title="Client details">
        <NewClientForm />
      </Section>
    </>
  );
}
