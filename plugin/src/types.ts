/**
 * Plugin settings interface and defaults.
 */

/** How to resolve the first full sync when connecting a new device. */
export type InitialSyncStrategy = "pull" | "merge" | "push";

export interface AdvancedSyncSettings {
  /** Unique identifier for this device/client. */
  clientId: string;
  /** Display name for this device. */
  deviceName: string;
  /** Server URL (e.g., ws://192.168.1.100:8443/sync). */
  serverUrl: string;
  /** SHA-256 hash of the server password. */
  serverPasswordHash: string;
  /** Base64-encoded vault salt (received from server). */
  vaultSalt: string;
  /** Whether setup wizard has been completed. */
  setupComplete: boolean;
  /** Auto-connect on plugin load. */
  autoConnect: boolean;
  /** Sync .obsidian/plugins/ directory. */
  syncPlugins: boolean;
  /** Sync .obsidian/ settings (config JSONs). */
  syncSettings: boolean;
  /** Sync workspace.json (default: off). */
  syncWorkspace: boolean;
  /** File/folder patterns to exclude from sync. */
  excludePatterns: string[];
  /** Last known server sequence number. */
  lastSequence: number;
  /** Server ID (to detect server changes). */
  serverId: string;
  /** Whether syncing is enabled (can be toggled from the status bar popup). */
  syncEnabled: boolean;
  /** Strategy for the first full sync on a new device. Reset to "merge" after use. */
  initialSyncStrategy: InitialSyncStrategy;
}

export const DEFAULT_SETTINGS: AdvancedSyncSettings = {
  clientId: "",
  deviceName: "",
  serverUrl: "",
  serverPasswordHash: "",
  vaultSalt: "",
  setupComplete: false,
  autoConnect: true,
  syncPlugins: true,
  syncSettings: true,
  syncWorkspace: false,
  excludePatterns: [],
  lastSequence: 0,
  serverId: "",
  syncEnabled: true,
  initialSyncStrategy: "merge",
};
