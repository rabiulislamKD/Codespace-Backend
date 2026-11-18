/**
 * UWB (Universal Workspace Bridge) Remote Connector
 * 
 * This module runs on remote servers (Render, GitHub Codespaces, VPS, Docker, local)
 * and connects to the Android UWB bridge via WebSocket to provide file system access
 * to the user's selected Android folder.
 * 
 * Usage:
 *   const { createUWBConnector } = require('uwb-connector');
 *   
 *   const connector = await createUWBConnector({
 *     androidBridgeUrl: 'ws://192.168.x.x:8080/uws',
 *     deviceToken: 'dev_abc123...',
 *     clientId: 'render-server-1'
 *   });
 *   
 *   // Now use like local fs
 *   const files = await connector.listFiles('.');
 *   const content = await connector.readFile('package.json');
 *   await connector.writeFile('new-file.ts', 'console.log("hello")');
 */

'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');

class UWBRemoteConnector extends EventEmitter {
    constructor(options = {}) {
        super();
        this.androidBridgeUrl = options.androidBridgeUrl || 'ws://localhost:8080/uws';
        this.deviceToken = options.deviceToken || '';
        this.clientId = options.clientId || `remote-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        this.workspaceRoot = options.workspaceRoot || '/workspace';
        
        this.ws = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.baseReconnectDelay = options.baseReconnectDelay || 1000;
        this.isConnecting = false;
        this.isIntentionalClose = false;
        this.sessionToken = null;
        this.operationQueue = [];
        this.isOnline = false;
    }

    async connect() {
        if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
            return;
        }

        this.isIntentionalClose = false;
        this.isConnecting = true;

        // First, get a session token using the device token
        if (!this.sessionToken) {
            await this.authenticate();
        }

        return new Promise((resolve, reject) => {
            const url = `${this.androidBridgeUrl}?token=${encodeURIComponent(this.sessionToken)}&clientId=${encodeURIComponent(this.clientId)}`;
            
            try {
                this.ws = new WebSocket(url);
                
                this.ws.on('open', () => {
                    console.log('[UWB] Connected to Android bridge');
                    this.isConnecting = false;
                    this.reconnectAttempts = 0;
                    this.isOnline = true;
                    this.emit('open');
                    this.processQueue();
                    resolve();
                });

                this.ws.on('message', (data) => {
                    this.handleMessage(data.toString());
                });

                this.ws.on('close', (code, reason) => {
                    console.log('[UWB] Disconnected:', code, reason.toString());
                    this.isConnecting = false;
                    this.isOnline = false;
                    this.emit('close', code, reason);
                    this.rejectPending(new Error('WebSocket closed'));
                    if (!this.isIntentionalClose) {
                        this.scheduleReconnect();
                    }
                });

                this.ws.on('error', (error) => {
                    console.error('[UWB] Error:', error.message);
                    this.isConnecting = false;
                    this.emit('error', error);
                });

            } catch (e) {
                this.isConnecting = false;
                reject(e);
            }
        });
    }

    async authenticate() {
        // Create a temporary HTTP connection to get session token
        // In production, this would be done via a separate auth endpoint
        // For now, we assume the device token works directly as session token
        // The Android bridge accepts device tokens for session creation
        this.sessionToken = this.deviceToken;
    }

    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[UWB] Max reconnect attempts reached');
            this.emit('maxReconnectAttempts');
            return;
        }
        
        const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        console.log(`[UWB] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        
        setTimeout(() => {
            this.connect().catch(() => {});
        }, delay);
    }

    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            if (message.id !== undefined) {
                const pending = this.pendingRequests.get(message.id);
                if (pending) {
                    this.pendingRequests.delete(message.id);
                    if (message.error) {
                        const error = new Error(message.error.message || 'UWB Error');
                        error.code = message.error.code;
                        error.data = message.error.data;
                        pending.reject(error);
                    } else {
                        pending.resolve(message.result);
                    }
                }
            } else if (message.method) {
                // Handle notifications
                this.emit('notification', message.method, message.params);
            }
        } catch (e) {
            console.warn('[UWB] Failed to parse message:', e.message);
        }
    }

    rejectPending(error) {
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }

    generateRequestId() {
        return `req_${++this.requestId}_${Date.now()}`;
    }

    call(method, params = {}) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // Queue the operation for when we reconnect
            return new Promise((resolve, reject) => {
                this.operationQueue.push({ method, params, resolve, reject });
            });
        }

        const id = this.generateRequestId();
        const message = {
            jsonrpc: '2.0',
            id: id,
            method: method,
            params: params
        };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(message));
            
            // Timeout after 60 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 60000);
        });
    }

    processQueue() {
        while (this.operationQueue.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
            const op = this.operationQueue.shift();
            this.call(op.method, op.params).then(op.resolve).catch(op.reject);
        }
    }

    disconnect() {
        this.isIntentionalClose = true;
        this.isOnline = false;
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
    }

    // File system operations (fs-compatible API)
    
    async listFiles(path, options = {}) {
        const result = await this.call('list_files', { path, ...options });
        return result.entries || [];
    }

    async readFile(path, options = {}) {
        const result = await this.call('read_file', { path, ...options });
        if (options.encoding === 'base64' && result.encoding === 'base64') {
            return Buffer.from(result.content, 'base64');
        }
        return result.content;
    }

    async writeFile(path, content, options = {}) {
        const params = { path, ...options };
        if (Buffer.isBuffer(content)) {
            params.content = content.toString('base64');
            params.encoding = 'base64';
        } else {
            params.content = content;
        }
        return await this.call('write_file', params);
    }

    async createFile(path, content, options = {}) {
        const params = { path, ...options };
        if (content !== undefined) {
            if (Buffer.isBuffer(content)) {
                params.content = content.toString('base64');
                params.encoding = 'base64';
            } else {
                params.content = content;
            }
        }
        return await this.call('create_file', params);
    }

    async createDirectory(path, options = {}) {
        return await this.call('create_directory', { path, ...options });
    }

    async renameFile(from, to, options = {}) {
        return await this.call('rename_file', { from, to, ...options });
    }

    async deleteFile(path, options = {}) {
        return await this.call('delete_file', { path, ...options });
    }

    async searchFiles(path, pattern, options = {}) {
        const result = await this.call('search_files', { path, pattern, ...options });
        return result.matches || [];
    }

    async getFileMetadata(path) {
        return await this.call('get_file_metadata', { path });
    }

    async streamFile(path, options = {}) {
        return await this.call('stream_file', { path, ...options });
    }

    // Watch operations
    async watchChanges(path, options = {}) {
        return await this.call('watch_changes', { path, ...options });
    }

    async unwatch(watcherId) {
        return await this.call('unwatch', { watcherId });
    }

    // Batch operations
    async batchOperations(operations, options = {}) {
        return await this.call('batch_operations', { operations, ...options });
    }

    // Auth
    async refreshSession() {
        const result = await this.call('auth_refresh', { sessionToken: this.sessionToken });
        this.sessionToken = result.sessionToken;
        return result;
    }

    async revokeSession() {
        return await this.call('auth_revoke', { sessionToken: this.sessionToken });
    }

    // Bridge info
    async getBridgeInfo() {
        return await this.call('bridge_info');
    }

    // Ping
    async ping() {
        return await this.call('ping', { t: Date.now() });
    }

    // Status
    isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    getReadyState() {
        return this.ws ? this.ws.readyState : WebSocket.CLOSED;
    }
}

async function createUWBConnector(options) {
    const connector = new UWBRemoteConnector(options);
    await connector.connect();
    return connector;
}

module.exports = {
    createUWBConnector,
    UWBRemoteConnector
};

// Also export for ES modules
if (typeof exports !== 'undefined') {
    exports.createUWBConnector = createUWBConnector;
    exports.UWBRemoteConnector = UWBRemoteConnector;
}