import { localParts } from "../dialer/time";

/** Hour of day (0-23) in India, where the working-hours rules are judged. */
export function istHour(at: Date): number {
  return Math.floor(localParts(at, "Asia/Kolkata").minutes / 60);
}
