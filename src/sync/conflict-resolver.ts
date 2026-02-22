/**
 * Conflict resolution: Last-write-wins strategy.
 * When timestamps are equal, remote wins (deterministic).
 */

export type ConflictWinner = "local" | "remote";

/**
 * Determine which version wins in a conflict.
 * @param localMtime - Local file modification time (ms)
 * @param remoteMtime - Remote file modification time (ms)
 * @returns Which version should be kept
 */
export function resolveConflict(
  localMtime: number,
  remoteMtime: number
): ConflictWinner {
  if (remoteMtime > localMtime) {
    return "remote";
  }
  if (localMtime > remoteMtime) {
    return "local";
  }
  // Equal timestamps: remote wins (deterministic tie-breaker)
  return "remote";
}
