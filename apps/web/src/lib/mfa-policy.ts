/**
 * Two-step sign-in policy. Diigoo staff can reach every client's setup and,
 * with a grant, their data, so a stolen password alone must not be enough.
 * JENAI_STAFF_MFA=required|optional; required by default in production.
 */
export const STAFF_MFA_REQUIRED =
  (process.env.JENAI_STAFF_MFA ?? (process.env.NODE_ENV === "production" ? "required" : "optional")) === "required";
