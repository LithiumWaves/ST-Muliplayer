/**
 * Extension-message routing (ext.message) against a real relay.
 *
 * This is the channel other extensions (Phone Trigger) use for player-to-player
 * mail, calls, D-Mails and time leaps. It must reach exactly who it is
 * addressed to, carry the real sender, and never become chat traffic.
 *
 * Run with:  node tests/ext.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { Relay } = await import(path.join(root, 'server/lib/relay.js'));
const { SecureSocket } = await import(path.join(root, 'lib/transport.js'));
const { LIMITS, OP, OOC, decodeConnectionCode, encodeConnectionCode } = await import(path.join(root, 'lib/protocol.js'));
const { fromBase64 } = await import(path.join(root, 'lib/crypto.js'));

assert.ok(typeof globalThis.WebSocket === 'function',
    'This test needs a global WebSocket (Node 20+).');

/** Fresh port per case, so one slow teardown cannot cascade into the next. */
let nextPort = 19400;
const PORT = () => nextPort++;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`  \u2717 ${name}\n      ${error.stack?.split('\n').slice(0, 3).join('\n      ')}`);
        failed += 1;
    }
}

const silent = () => {};

/** Waits for a named event, or rejects after `ms`. */
function waitFor(target, type, ms = 5000, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            target.removeEventListener(type, handler);
            reject(new Error(`Timed out waiting for "${type}"`));
        }, ms);
        const handler = event => {
            if (!predicate(event.detail)) return;
            clearTimeout(timer);
            target.removeEventListener(type, handler);
            resolve(event.detail);
        };
        target.addEventListener(type, handler);
    });
}

/** Collects every application payload a socket receives. */
function collect(socket) {
    const seen = [];
    socket.addEventListener('message', event => seen.push(event.detail.payload));
    seen.waitForOp = (op, ms = 5000) => new Promise((resolve, reject) => {
        const existing = seen.find(payload => payload?.op === op);
        if (existing) return resolve(existing);
        const started = Date.now();
        const poll = setInterval(() => {
            const found = seen.find(payload => payload?.op === op);
            if (found) {
                clearInterval(poll);
                resolve(found);
            } else if (Date.now() - started > ms) {
                clearInterval(poll);
                reject(new Error(`No "${op}" arrived. Saw: ${seen.map(p => p?.op).join(', ') || '(nothing)'}`));
            }
        }, 20);
    });
    return seen;
}

/** Waits until at least `count` payloads with `op` have arrived. */
function waitForCount(seen, op, count, ms = 5000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
            const found = seen.filter(payload => payload?.op === op);
            if (found.length >= count) {
                clearInterval(poll);
                resolve(found);
            } else if (Date.now() - started > ms) {
                clearInterval(poll);
                reject(new Error(`Only ${found.length}/${count} "${op}" arrived`));
            }
        }, 20);
    });
}

const manifestReport = extensions => ({
    strictness: 'manifest',
    hash: extensions.map(e => `${e.id}@${e.version}`).sort().join('|'),
    extensions,
});

const HOST_EXTENSIONS = [
    { id: 'Extension-A', displayName: 'A', version: '1.2.0', commit: '', branch: 'main', remoteUrl: 'https://example.test/a.git' },
    { id: 'Extension-B', displayName: 'B', version: '0.9.1', commit: '', branch: 'main', remoteUrl: 'https://example.test/b.git' },
];

/** Brings up a relay and connects a host peer that has cleared parity. */
async function bootRoom({ requireParity = true, maxPeers = 4 } = {}) {
    const relay = new Relay({ log: silent });
    const info = await relay.start({
        port: PORT(), bindLan: false, roomName: 'test room', maxPeers, requireParity,
        parityStrictness: 'manifest',
    });

    const psk = fromBase64(info.psk);
    const host = new SecureSocket({
        url: `ws://127.0.0.1:${info.port}/`,
        psk,
        hostToken: info.hostToken,
        autoReconnect: false,
    });
    const hostSeen = collect(host);

    const opened = waitFor(host, 'open');
    await host.connect();
    await opened;

    const welcome = await hostSeen.waitForOp(OP.WELCOME);
    host.send({ op: OP.ROSTER, name: 'TheHost', hostToken: info.hostToken });

    if (requireParity) {
        await hostSeen.waitForOp(OP.PARITY_CHALLENGE);
        host.send({ op: OP.PARITY_REPORT, report: manifestReport(HOST_EXTENSIONS) });
    }

    // The host is only usable once the relay confirms admission: that is the
    // signal the extension uses to attach its chat bridge and publish cards.
    await hostSeen.waitForOp(OP.PARITY_RESULT);
    await hostSeen.waitForOp(OP.ROSTER);

    return { relay, info, psk, host, hostSeen, welcome };
}

/** Connects a client peer with a chosen extension set. */
async function joinClient({ info, psk, extensions = HOST_EXTENSIONS, name = 'Guest' }) {
    const client = new SecureSocket({
        url: `ws://127.0.0.1:${info.port}/`,
        psk,
        autoReconnect: false,
    });
    const seen = collect(client);
    const rejections = [];
    client.addEventListener('rejected', event => rejections.push(event.detail));

    const opened = waitFor(client, 'open');
    await client.connect();
    await opened;

    await seen.waitForOp(OP.WELCOME);
    client.send({ op: OP.ROSTER, name });

    const challenge = await seen.waitForOp(OP.PARITY_CHALLENGE).catch(() => null);
    if (challenge) client.send({ op: OP.PARITY_REPORT, report: manifestReport(extensions) });

    return { client, seen, rejections };
}

async function shutdown(relay, ...sockets) {
    for (const socket of sockets) {
        try { socket?.close('test over'); } catch { /* ignore */ }
    }
    await relay.stop();
    // Let the OS release the port between cases.
    await new Promise(resolve => setTimeout(resolve, 60));
}

async function room3() {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    const b = await joinClient({ ...room, name: 'PlayerB' });
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);
    const idA = a.seen.find(p => p?.op === OP.WELCOME).peerId;
    const idB = b.seen.find(p => p?.op === OP.WELCOME).peerId;
    const idHost = room.welcome.peerId;
    return { room, a, b, idA, idB, idHost };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 200));
const ext = seen => seen.filter(p => p?.op === OP.EXT_MESSAGE);

console.log('\nExtension messages');

await test('a client can address one other client, stamped with its identity', async () => {
    const { room, a, b, idA, idB } = await room3();
    a.client.send({ op: OP.EXT_MESSAGE, channel: 'pt.mail', data: { subject: 'hi' }, to: idB });
    const got = await b.seen.waitForOp(OP.EXT_MESSAGE);
    assert.equal(got.channel, 'pt.mail');
    assert.deepEqual(got.data, { subject: 'hi' });
    assert.equal(got.from, idA);
    assert.equal(got.name, 'PlayerA');
    assert.equal(got.role, 'client');
    await settle();
    assert.equal(ext(room.hostSeen).length, 0, 'a targeted message leaked to the host');
    assert.equal(ext(a.seen).length, 0, 'a message echoed to its sender');
    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('"host" reaches the host only', async () => {
    const { room, a, b, idA } = await room3();
    a.client.send({ op: OP.EXT_MESSAGE, channel: 'pt.dmail.request', data: { body: 'x' }, to: 'host' });
    const got = await room.hostSeen.waitForOp(OP.EXT_MESSAGE);
    assert.equal(got.from, idA);
    await settle();
    assert.equal(ext(b.seen).length, 0);
    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('no "to" reaches everyone but the sender', async () => {
    const { room, a, b, idHost } = await room3();
    room.host.send({ op: OP.EXT_MESSAGE, channel: 'pt.dmail.applied', data: { to: '1.0' } });
    const gotA = await a.seen.waitForOp(OP.EXT_MESSAGE);
    const gotB = await b.seen.waitForOp(OP.EXT_MESSAGE);
    assert.equal(gotA.from, idHost);
    assert.equal(gotA.role, 'host');
    assert.equal(gotB.channel, 'pt.dmail.applied');
    await settle();
    assert.equal(ext(room.hostSeen).length, 0);
    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('a forged "from" is overwritten by the relay', async () => {
    const { room, a, b, idA, idB, idHost } = await room3();
    a.client.send({ op: OP.EXT_MESSAGE, channel: 'pt.mail', data: {}, to: idB, from: idHost, name: 'TheHost', role: 'host' });
    const got = await b.seen.waitForOp(OP.EXT_MESSAGE);
    assert.equal(got.from, idA);
    assert.equal(got.name, 'PlayerA');
    assert.equal(got.role, 'client');
    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('an unknown recipient drops the message instead of broadcasting it', async () => {
    const { room, a, b } = await room3();
    a.client.send({ op: OP.EXT_MESSAGE, channel: 'pt.mail', data: {}, to: 'nobody' });
    await settle();
    assert.equal(ext(b.seen).length, 0);
    assert.equal(ext(room.hostSeen).length, 0);
    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('messages without a channel, or with an over-long one, are dropped', async () => {
    const { room, a, b } = await room3();
    a.client.send({ op: OP.EXT_MESSAGE, data: {} });
    a.client.send({ op: OP.EXT_MESSAGE, channel: 'x'.repeat(65), data: {} });
    await settle();
    assert.equal(ext(b.seen).length, 0);
    assert.equal(ext(room.hostSeen).length, 0);
    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('extension messages never appear as chat traffic', async () => {
    const { room, a, b, idB } = await room3();
    a.client.send({ op: OP.EXT_MESSAGE, channel: 'pt.call.line', data: { text: 'hello' }, to: idB });
    await b.seen.waitForOp(OP.EXT_MESSAGE);
    await settle();
    const chatOps = new Set([OP.CHAT_APPEND, OP.CHAT_TURN, OP.CHAT_STATE]);
    assert.equal(b.seen.some(p => chatOps.has(p?.op)), false);
    assert.equal(room.hostSeen.some(p => chatOps.has(p?.op)), false);
    await shutdown(room.relay, room.host, a.client, b.client);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
