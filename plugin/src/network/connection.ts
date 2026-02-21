/**
 * High-level connection lifecycle manager.
 * Orchestrates: Discovery → Connect → Auth → Initial Sync.
 */

import type { App } from "obsidian";
import { MessageType, PROTOCOL_VERSION } from "@vault-sync/shared/protocol";
import type {
  ProtocolMessage,
  AuthOkMessage,
  AuthFailMessage,
  SyncResponseMessage,
  FileChangedMessage,
  FileRemovedMessage,
  FileDownloadResponseMessage,
  FileUploadAckMessage,
} from "@vault-sync/shared/protocol";
import type { SyncState } from "@vault-sync/shared/types";
import { WsClient } from "./ws-client";
import type { AdvancedSyncSettings } from "../types";

export type ConnectionStateCallback = (state: SyncState, error?: string) => void;
export type SyncResponseCallback = (msg: SyncResponseMessage) => void;
export type FileChangedCallback = (msg: FileChangedMessage) => void;
export type FileRemovedCallback = (msg: FileRemovedMessage) => void;
export type FileDownloadCallback = (msg: FileDownloadResponseMessage) => void;
export type FileUploadAckCallback = (msg: FileUploadAckMessage) => void;
export type BinaryDataCallback = (data: ArrayBuffer) => void;
export type VaultSaltCallback = (salt: string, serverId: string) => void;

export class ConnectionManager {
  private wsClient: WsClient;
  private settings: AdvancedSyncSettings;
  private state: SyncState = "disconnected";

  // Callbacks
  onStateChange: ConnectionStateCallback = () => {};
  onSyncResponse: SyncResponseCallback = () => {};
  onFileChanged: FileChangedCallback = () => {};
  onFileRemoved: FileRemovedCallback = () => {};
  onFileDownload: FileDownloadCallback = () => {};
  onFileUploadAck: FileUploadAckCallback = () => {};
  onBinaryData: BinaryDataCallback = () => {};
  onVaultSalt: VaultSaltCallback = () => {};

  constructor(settings: AdvancedSyncSettings) {
    this.settings = settings;
    this.wsClient = new WsClient(
      (msg) => this.handleMessage(msg),
      (data) => this.onBinaryData(data),
      (wsState) => this.handleWsState(wsState)
    );
  }

  get currentState(): SyncState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.wsClient.isConnected;
  }

  /** Connect to the server. */
  connect(): void {
    if (!this.settings.serverUrl) return;
    this.setState("connecting");
    this.wsClient.connect(this.settings.serverUrl);
  }

  /** Disconnect from the server. */
  disconnect(): void {
    this.wsClient.disconnect();
    this.setState("disconnected");
  }

  /** Send a protocol message. */
  send(msg: ProtocolMessage): void {
    this.wsClient.send(msg);
  }

  /** Send binary data (file blob). */
  sendBinary(data: ArrayBuffer): void {
    this.wsClient.sendBinary(data);
  }

  /** Request sync from server. */
  requestSync(lastSequence: number): void {
    this.send({
      type: MessageType.SYNC_REQUEST,
      lastSequence,
    });
  }

  private handleWsState(wsState: "open" | "closed" | "error"): void {
    switch (wsState) {
      case "open":
        this.setState("authenticating");
        // Send auth message
        this.send({
          type: MessageType.AUTH,
          clientId: this.settings.clientId,
          deviceName: this.settings.deviceName,
          passwordHash: this.settings.serverPasswordHash,
          protocolVersion: PROTOCOL_VERSION,
        });
        break;
      case "closed":
        if (this.state !== "disconnected") {
          this.setState("disconnected");
        }
        break;
      case "error":
        this.setState("error", "Connection error");
        break;
    }
  }

  private handleMessage(msg: ProtocolMessage): void {
    switch (msg.type) {
      case MessageType.AUTH_OK: {
        const authOk = msg as AuthOkMessage;
        this.onVaultSalt(authOk.vaultSalt, authOk.serverId);
        this.setState("syncing");
        break;
      }
      case MessageType.AUTH_FAIL: {
        const authFail = msg as AuthFailMessage;
        this.setState("error", authFail.reason);
        this.wsClient.disconnect();
        break;
      }
      case MessageType.SYNC_RESPONSE:
        this.onSyncResponse(msg as SyncResponseMessage);
        break;
      case MessageType.FILE_CHANGED:
        this.onFileChanged(msg as FileChangedMessage);
        break;
      case MessageType.FILE_REMOVED:
        this.onFileRemoved(msg as FileRemovedMessage);
        break;
      case MessageType.FILE_DOWNLOAD_RESPONSE:
        this.onFileDownload(msg as FileDownloadResponseMessage);
        break;
      case MessageType.FILE_UPLOAD_ACK:
        this.onFileUploadAck(msg as FileUploadAckMessage);
        break;
      case MessageType.PONG:
        // Keepalive response, no action needed
        break;
      default:
        break;
    }
  }

  private setState(state: SyncState, error?: string): void {
    this.state = state;
    this.onStateChange(state, error);
  }
}
