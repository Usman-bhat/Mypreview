"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CdpClient = void 0;
const node_events_1 = require("node:events");
const ws_1 = __importDefault(require("ws"));
class CdpClient extends node_events_1.EventEmitter {
    websocketUrl;
    pendingRequests = new Map();
    socket;
    nextId = 1;
    constructor(websocketUrl) {
        super();
        this.websocketUrl = websocketUrl;
    }
    async connect() {
        if (this.socket) {
            return;
        }
        await new Promise((resolve, reject) => {
            const socket = new ws_1.default(this.websocketUrl);
            this.socket = socket;
            socket.once("open", () => {
                resolve();
            });
            socket.once("error", (error) => {
                reject(error);
            });
            socket.on("message", (data) => {
                this.handleMessage(data.toString());
            });
            socket.on("close", () => {
                this.emit("close");
                for (const [, pending] of this.pendingRequests) {
                    pending.reject(new Error(`CDP connection closed while waiting for ${pending.method}.`));
                }
                this.pendingRequests.clear();
            });
        });
    }
    async close() {
        if (!this.socket) {
            return;
        }
        await new Promise((resolve) => {
            const socket = this.socket;
            if (!socket) {
                resolve();
                return;
            }
            this.socket = undefined;
            socket.once("close", () => resolve());
            socket.close();
        });
    }
    send(method, params) {
        if (!this.socket || this.socket.readyState !== ws_1.default.OPEN) {
            return Promise.reject(new Error(`CDP socket is not open for ${method}.`));
        }
        const id = this.nextId++;
        const payload = JSON.stringify({
            id,
            method,
            params,
        });
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, {
                resolve: (value) => resolve(value),
                reject,
                method,
            });
            this.socket?.send(payload, (error) => {
                if (error) {
                    this.pendingRequests.delete(id);
                    reject(error);
                }
            });
        });
    }
    handleMessage(rawMessage) {
        const message = JSON.parse(rawMessage);
        if (typeof message.id === "number") {
            const pending = this.pendingRequests.get(message.id);
            if (!pending) {
                return;
            }
            this.pendingRequests.delete(message.id);
            if (message.error) {
                pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
                return;
            }
            pending.resolve(message.result);
            return;
        }
        if (message.method) {
            this.emit(message.method, message.params);
        }
    }
}
exports.CdpClient = CdpClient;
//# sourceMappingURL=cdpClient.js.map