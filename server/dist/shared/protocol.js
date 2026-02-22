"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISCOVERY_PORT = exports.DEFAULT_PORT = exports.PROTOCOL_VERSION = exports.MessageType = void 0;
/** All message types in the sync protocol. */
var MessageType;
(function (MessageType) {
    // Authentication
    MessageType["AUTH"] = "AUTH";
    MessageType["AUTH_OK"] = "AUTH_OK";
    MessageType["AUTH_FAIL"] = "AUTH_FAIL";
    // Sync
    MessageType["SYNC_REQUEST"] = "SYNC_REQUEST";
    MessageType["SYNC_RESPONSE"] = "SYNC_RESPONSE";
    // File operations
    MessageType["FILE_UPLOAD"] = "FILE_UPLOAD";
    MessageType["FILE_UPLOAD_ACK"] = "FILE_UPLOAD_ACK";
    MessageType["FILE_DOWNLOAD"] = "FILE_DOWNLOAD";
    MessageType["FILE_DOWNLOAD_RESPONSE"] = "FILE_DOWNLOAD_RESPONSE";
    MessageType["FILE_CHANGED"] = "FILE_CHANGED";
    MessageType["FILE_REMOVED"] = "FILE_REMOVED";
    MessageType["FILE_DELETE"] = "FILE_DELETE";
    // Keep-alive
    MessageType["PING"] = "PING";
    MessageType["PONG"] = "PONG";
    // Web UI
    MessageType["UI_SUBSCRIBE"] = "UI_SUBSCRIBE";
    MessageType["UI_EVENT"] = "UI_EVENT";
    // Client management
    MessageType["CLIENT_LIST"] = "CLIENT_LIST";
    MessageType["CLIENT_KICK"] = "CLIENT_KICK";
})(MessageType || (exports.MessageType = MessageType = {}));
/** Current protocol version. */
exports.PROTOCOL_VERSION = 2;
/** Default server port. */
exports.DEFAULT_PORT = 8443;
/** UDP discovery port. */
exports.DISCOVERY_PORT = 21547;
