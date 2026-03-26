function createSenderId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createMessageId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSameOrigin(origin) {
    return origin === window.location.origin
        || (origin === 'null' && window.location.origin === 'null');
}

export function createCrossWindowChannel(channelName, options = {}) {
    const senderId = createSenderId();
    const storageKey = `ModularStudioChannel:${channelName}`;
    const listeners = new Set();
    const processedMids = new Set();
    const targetWindowResolver = typeof options.resolveTargetWindow === 'function'
        ? options.resolveTargetWindow
        : null;
    const broadcastChannel = typeof BroadcastChannel === 'function'
        ? new BroadcastChannel(channelName)
        : null;

    function rememberMessage(mid) {
        if (!mid) return;
        processedMids.add(mid);
        setTimeout(() => processedMids.delete(mid), 10000);
    }

    function normalizeMessage(message) {
        return {
            ...message,
            _channel: channelName,
            _senderId: senderId,
            _mid: message._mid || createMessageId(),
            _sentAt: Date.now()
        };
    }

    function isChannelMessage(message) {
        return !!message
            && typeof message === 'object'
            && typeof message.type === 'string'
            && (!message._channel || message._channel === channelName);
    }

    function deliver(message, meta = {}) {
        if (!isChannelMessage(message)) return;
        if (message._senderId === senderId) return;
        if (message._mid && processedMids.has(message._mid)) return;
        rememberMessage(message._mid);
        listeners.forEach((listener) => listener(message, meta));
    }

    function handleWindowMessage(event) {
        if (!isSameOrigin(event.origin)) return;
        deliver(event.data, { transport: 'postMessage', source: event.source });
    }

    function handleStorageMessage(event) {
        if (event.key !== storageKey || !event.newValue) return;
        try {
            deliver(JSON.parse(event.newValue), { transport: 'storage' });
        } catch (error) {
            console.warn('[CrossWindowChannel] Failed to parse storage message.', error);
        }
    }

    if (broadcastChannel) {
        broadcastChannel.onmessage = (event) => deliver(event.data, { transport: 'broadcast' });
    }
    window.addEventListener('message', handleWindowMessage);
    window.addEventListener('storage', handleStorageMessage);

    return {
        send(message) {
            const payload = normalizeMessage(message);
            rememberMessage(payload._mid);

            if (broadcastChannel) {
                broadcastChannel.postMessage(payload);
            }

            const targetWindow = targetWindowResolver ? targetWindowResolver() : null;
            if (targetWindow && targetWindow !== window && !targetWindow.closed) {
                try {
                    targetWindow.postMessage(payload, window.location.origin);
                } catch (error) {
                    try {
                        targetWindow.postMessage(payload, '*');
                    } catch (postMessageError) {
                        console.warn('[CrossWindowChannel] Failed to post message to target window.', postMessageError);
                    }
                }
            }

            try {
                localStorage.setItem(storageKey, JSON.stringify(payload));
            } catch (error) {
                console.warn('[CrossWindowChannel] Failed to write storage message.', error);
            }

            return payload;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close() {
            listeners.clear();
            window.removeEventListener('message', handleWindowMessage);
            window.removeEventListener('storage', handleStorageMessage);
            if (broadcastChannel) broadcastChannel.close();
        }
    };
}
