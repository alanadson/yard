/**
 * Why the workspace could not be opened at boot, read from the backend's
 * error, so the failure screen can give the hint that actually fixes it.
 */
export type BootFailureCause = "olderBuild" | "otherInstance";

/** Matches `persistence::db::migrate` refusing a schema it does not know. */
const NEWER_SCHEMA = /requires a newer Yard version/;

export function bootFailureCause(error: string): BootFailureCause {
  return NEWER_SCHEMA.test(error) ? "olderBuild" : "otherInstance";
}
