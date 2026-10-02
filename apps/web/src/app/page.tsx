import { redirect } from "next/navigation";
import { editionFrom } from "@jenai/authz";
import { myOrganizations, requireUser } from "@/server/session";

/** Send each person to the right place: Diigoo console, their only workspace, or the picker. */
export default async function Home() {
  const u = await requireUser();
  const orgs = (await myOrganizations(u.id)).filter((o) => o.membershipStatus === "active");
  const clients = orgs.filter((o) => o.kind !== "platform");
  // A police department's own server has no JENAI console.
  const isStaff = orgs.some((o) => o.kind === "platform") && editionFrom(process.env.JENAI_EDITION) === "full";
  if (isStaff && clients.length === 0) redirect("/console");
  if (!isStaff && clients.length === 1) redirect(`/w/${clients[0]!.slug}`);
  redirect("/orgs");
}
