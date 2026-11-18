/**
 * UWB (Universal Workspace Bridge) JavaScript Connector
 * Connects to the Android UWB bridge via WebSocket for file operations.
 * This allows remote AI agents to access Android files through the UWB protocol.
 */

const UWBConnector = (function() {
    'use strict';

    let ws = null;
    let wsUrl = '';
    let sessionToken = '';
    let clientId = 'web-client-' + Math.random().toString(36).slice(2, 10);
    let requestId = 0;
    const pendingRequests = new Map();
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const baseReconnectDelay = 1000;
    let onMessageCallback = null;
    let onOpenCallback = null;
    let onCloseCallback = null;
    let onErrorCallback = null;
    let isConnecting = false;
    let isIntentionalClose = false;

    // Message handlers
    const messageHandlers = new Map();

    function generateRequestId() {
        return 'req_' + (++requestId) + '_' + Date.now();
    }

    function sendMessage(message) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    function handleResponse(message) {
        const id = message.id;
        const pending = pendingRequests.get(id);
        if (pending) {
            pendingRequests.delete(id);
            if (message.error) {
                const error = new Error(message.error.message || 'UWB Error');
                error.code = message.error.code;
                error.data = message.error.data;
                pending.reject(error);
            } else {
                pending.resolve(message.result);
            }
        }
    }

    function handleNotification(message) {
        // Handle server notifications (file_changed, etc.)
        if (onMessageCallback) {
            onMessageCallback(message.method, message.params);
        }
    }

    function onWebSocketMessage(event) {
        try {
            const message = JSON.parse(event.data);
            if (message.id !== undefined) {
                handleResponse(message);
            } else if (message.method) {
                handleNotification(message);
            }
        } catch (e) {
            console.warn('UWB: Failed to parse message', e);
        }
    }

    function onWebSocketOpen() {
        console.log('UWB: WebSocket connected');
        isConnecting = false;
        reconnectAttempts = 0;
        if (onOpenCallback) onOpenCallback();
    }

    function onWebSocketClose(event) {
        console.log('UWB: WebSocket closed', event.code, event.reason);
        isConnecting = false;
        // Reject all pending requests
        for (const [id, pending] of pendingRequests) {
            pending.reject(new Error('WebSocket closed'));
        }
        pendingRequests.clear();
        if (onCloseCallback) onCloseCallback(event);
        if (!isIntentionalClose) {
            scheduleReconnect();
        }
    }

    function onWebSocketError(event) {
        console.error('UWB: WebSocket error', event);
        isConnecting = false;
        if (onErrorCallback) onErrorCallback(event);
    }

    function scheduleReconnect() {
        if (reconnectAttempts >= maxReconnectAttempts) {
            console.error('UWB: Max reconnect attempts reached');
            return;
        }
        const delay = Math.min(baseReconnectDelay * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;
        console.log(`UWB: Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        reconnectTimer = setTimeout(() => {
            connect(wsUrl, sessionToken, clientId);
        }, delay);
    }

    function connect(url, token, clientIdParam) {
        if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) {
            return Promise.resolve();
        }

        isIntentionalClose = false;
        isConnecting = true;
        wsUrl = url;
        sessionToken = token;
        clientId = clientIdParam || clientId;

        const fullUrl = `${url}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`;

        return new Promise((resolve, reject) => {
            try {
                ws = new WebSocket(fullUrl);
                ws.binaryType = 'arraybuffer';

                ws.onopen = () => {
                    onWebSocketOpen();
                    resolve();
                };

                ws.onmessage = onWebSocketMessage;
                ws.onclose = onWebSocketClose;
                ws.onerror = (event) => {
                    onWebSocketError(event);
                    // onerror fires before onclose, so we don't reject here
                };
            } catch (e) {
                isConnecting = false;
                reject(e);
            }
        });
    }

    function disconnect() {
        isIntentionalClose = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (ws) {
            ws.close(1000, 'Client disconnect');
            ws = null;
        }
    }

    function call(method, params = {}) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('UWB WebSocket not connected'));
        }

        const id = generateRequestId();
        const message = {
            jsonrpc: '2.0',
            id: id,
            method: method,
            params: params
        };

        return new Promise((resolve, reject) => {
            pendingRequests.set(id, { resolve, reject });
            if (!sendMessage(message)) {
                pendingRequests.delete(id);
                reject(new Error('Failed to send message'));
            }
            // Timeout after 60 seconds
            setTimeout(() => {
                if (pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 60000);
        });
    }

    // UWP Protocol methods
    const api = {
        connect: connect,
        disconnect: disconnect,
        call: call,

        // File operations
        listFiles: (path, options = {}) => call('list_files', { path, ...options }),
        readFile: (path, options = {}) => call('read_file', { path, ...options }),
        writeFile: (path, content, options = {}) => call('write_file', { path, content, ...options }),
        createFile: (path, content, options = {}) => call('create_file', { path, content, ...options }),
        createDirectory: (path, options = {}) => call('create_directory', { path, ...options }),
        renameFile: (from, to, options = {}) => call('rename_file', { from, to, ...options }),
        deleteFile: (path, options = {}) => call('delete_file', { path, ...options }),
        searchFiles: (path, pattern, options = {}) => call('search_files', { path, pattern, ...options }),
        getFileMetadata: (path) => call('get_file_metadata', { path }),
        streamFile: (path, options = {}) => call('stream_file', { path, ...options }),

        // Watch
        watchChanges: (path, options = {}) => call('watch_changes', { path, ...options }),
        unwatch: (watcherId) => call('unwatch', { watcherId }),

        // Batch
        batchOperations: (operations, options = {}) => call('batch_operations', { operations, ...options }),

        // Auth
        authSession: (deviceToken, clientIdParam) => call('auth_session', { deviceToken, clientId: clientIdParam }),
        authRefresh: (sessionToken) => call('auth_refresh', { sessionToken }),
        authRevoke: (sessionToken) => call('auth_revoke', { sessionToken }),

        // Bridge info
        getBridgeInfo: () => call('bridge_info'),

        // Ping
        ping: (t) => call('ping', { t }),

        // Event callbacks
        onMessage: (callback) => { onMessageCallback = callback; },
        onOpen: (callback) => { onOpenCallback = callback; },
        onClose: (callback) => { onCloseCallback = callback; },
        onError: (callback) => { onErrorCallback = callback; },

        // Status
        isConnected: () => ws && ws.readyState === WebSocket.OPEN,
        getReadyState: () => ws ? ws.readyState : WebSocket.CLOSED,
    };

    return api;
})();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UWBConnector;
}