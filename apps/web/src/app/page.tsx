import { redirect } from "next/navigation";
import { myOrganizations, requireUser } from "@/server/session";

/** Send each person to the right place: Diigoo console, their only workspace, or the picker. */
export default async function Home() {
  const u = await requireUser();
  const orgs = (await myOrganizations(u.id)).filter((o) => o.membershipStatus === "active");
  const clients = orgs.filter((o) => o.kind !== "platform");
  const isStaff = orgs.some((o) => o.kind === "platform");
  if (isStaff && clients.length === 0) redirect("/console");
  if (!isStaff && clients.length === 1) redirect(`/w/${clients[0]!.slug}`);
  redirect("/orgs");
}
