/**
 * Public API for other SillyTavern extensions: `globalThis.STMultiplayer`.
 *
 * Lets an extension (Phone Trigger, for one) find out who is in the room and
 * exchange its own messages with them over the room's encrypted channel.
 * Messages are opaque to Multiplayer and are never written to the chat.
 *
 *   const mp = globalThis.STMultiplayer;
 *   const off = mp.on('myext.ping', ({ data, from, name, role }) => { ... });
 *   await mp.send('myext.ping', { hello: 1 }, { to: peerId });   // or 'host', or omit for everyone else
 *
 * Events on `document`:
 *   stmp:ready   — the API was installed (detail: the API)
 *   stmp:roster  — the room changed: connection, players or personas (detail: { peers })
 *
 * Channel names should be namespaced (`ext.thing`), at most 64 characters.
 * A message is limited to 512 KiB on the wire.
 */

import { EXT, PROTOCOL_REVISION } from './protocol.js';

export const API_VERSION = 1;

/**
 * @param {import('./session.js').MultiplayerSession} session
 * @returns {() => void} uninstall
 */
export function installExtensionApi(session) {
    /** @type {Map<string, Set<Function>>} */
    const channels = new Map();
    /** @type {Set<Function>} */
    const rosterListeners = new Set();

    const peers = () => {
        if (!session.connected) return [];
        const personas = new Map(session.personaList().map(persona => [persona.peerId, persona]));
        return (session.peers ?? []).map(peer => {
            const persona = personas.get(peer.id) ?? null;
            return {
                id: peer.id,
                name: peer.name,
                role: peer.role,
                isMe: peer.id === session.peerId,
                persona: persona
                    ? { name: persona.name ?? null, description: persona.description ?? '', ownerId: persona.ownerId ?? null }
                    : null,
            };
        });
    };

    const notifyRoster = () => {
        const list = peers();
        for (const fn of rosterListeners) {
            try { fn(list); } catch (error) { console.error('[Multiplayer] roster listener failed', error); }
        }
        document.dispatchEvent(new CustomEvent('stmp:roster', { detail: { peers: list } }));
    };

    const onExt = event => {
        const message = event.detail;
        const set = channels.get(message?.channel);
        if (!set) return;
        for (const fn of [...set]) {
            try {
                const result = fn(message);
                if (result && typeof result.catch === 'function') {
                    result.catch(error => console.error(`[Multiplayer] ${message.channel} handler failed`, error));
                }
            } catch (error) {
                console.error(`[Multiplayer] ${message.channel} handler failed`, error);
            }
        }
    };

    session.addEventListener('ext', onExt);
    session.addEventListener('roster', notifyRoster);
    session.addEventListener('personas', notifyRoster);
    session.addEventListener('status', notifyRoster);

    const api = Object.freeze({
        version: API_VERSION,
        protocol: PROTOCOL_REVISION,
        maxBytes: EXT.MAX_BYTES,
        isConnected: () => session.connected,
        /** In a room and in its shared chat (the host's transcript), not some local chat. */
        inSession: () => Boolean(session.connected && session.activeCardId && session.inSessionChat()),
        /** @returns {'host'|'client'|null} */
        role: () => (session.connected ? session.role : null),
        selfId: () => (session.connected ? session.peerId : null),
        hostId: () => peers().find(peer => peer.role === 'host')?.id ?? null,
        peers,
        /**
         * @param {string} channel
         * @param {any} data JSON-serialisable
         * @param {{ to?: string|null }} [opts] a peer id, 'host', or nothing for everyone else
         */
        send: (channel, data, opts = {}) => session.sendExt(channel, data, opts?.to ?? null),
        /** @returns {() => void} unsubscribe */
        on(channel, fn) {
            if (typeof channel !== 'string' || typeof fn !== 'function') return () => {};
            if (!channels.has(channel)) channels.set(channel, new Set());
            channels.get(channel).add(fn);
            return () => channels.get(channel)?.delete(fn);
        },
        /** @returns {() => void} unsubscribe */
        onRoster(fn) {
            if (typeof fn !== 'function') return () => {};
            rosterListeners.add(fn);
            return () => rosterListeners.delete(fn);
        },
    });

    globalThis.STMultiplayer = api;
    document.dispatchEvent(new CustomEvent('stmp:ready', { detail: api }));

    return () => {
        session.removeEventListener('ext', onExt);
        session.removeEventListener('roster', notifyRoster);
        session.removeEventListener('personas', notifyRoster);
        session.removeEventListener('status', notifyRoster);
        channels.clear();
        rosterListeners.clear();
        if (globalThis.STMultiplayer === api) delete globalThis.STMultiplayer;
    };
}
