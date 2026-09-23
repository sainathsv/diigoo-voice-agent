import "server-only";
/**
 * Invitations live in @jenai/db so the console and the command line share one
 * implementation: token hashing is security-relevant and must not drift.
 */
export { INVITE_DAYS, hashToken, inviteUrl, createInvitation } from "@jenai/db";
