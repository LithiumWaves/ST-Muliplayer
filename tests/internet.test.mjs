/**
 * Internet play without a VPN: what changes once the relay's port is reachable
 * from the whole internet, and what changes when the host is a phone.
 *
 * Covers the room lock and its rejoin tickets, the room-wide handshake breaker,
 * releasing an idle router mapping, IPv6 connection codes, and the Android
 * fallbacks for port mapping (no interface list, no multicast).
 *
 * Run with:  node tests/internet.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { Relay, localAddresses, globalIPv6Addresses, isGlobalIPv6 } = await import(path.join(root, 'server/lib/relay.js'));
const portmap = await import(path.join(root, 'server/lib/portmap.js'));
const { SecureSocket } = await import(path.join(root, 'lib/transport.js'));
const protocol = await import(path.join(root, 'lib/protocol.js'));
const serverProtocol = await import(path.join(root, 'server/lib/protocol.js'));
const { fromBase64 } = await import(path.join(root, 'lib/crypto.js'));
const { cleanHostInput } = await import(path.join(root, 'lib/ui.js'));

const { LIMITS, OP, REJECT_REASON, decodeConnectionCode, encodeConnectionCode, connectionUrl, classifyAddress } = protocol;

let nextPort = 19400;
const PORT = () => nextPort++;
let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`  ✗ ${name}\n      ${error.stack?.split('\n').slice(0, 3).join('\n      ')}`);
        failed += 1;
    }
}

const silent = () => {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function waitFor(target, type, ms = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            target.removeEventListener(type, handler);
            reject(new Error(`Timed out waiting for "${type}"`));
        }, ms);
        const handler = event => {
            clearTimeout(timer);
            target.removeEventListener(type, handler);
            resolve(event.detail);
        };
        target.addEventListener(type, handler);
    });
}

/** Resolves with the first payload carrying `op`. */
function nextOp(socket, op, ms = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No "${op}" arrived`)), ms);
        const handler = event => {
            if (event.detail.payload?.op !== op) return;
            clearTimeout(timer);
            socket.removeEventListener('message', handler);
            resolve(event.detail.payload);
        };
        socket.addEventListener('message', handler);
    });
}

async function boot() {
    const relay = new Relay({ log: silent });
    const info = await relay.start({ port: PORT(), bindLan: false, roomName: 'internet', requireParity: false });
    const psk = fromBase64(info.psk);
    const host = new SecureSocket({ url: `ws://127.0.0.1:${info.port}/`, psk, hostToken: info.hostToken, autoReconnect: false });
    const welcome = nextOp(host, OP.WELCOME);
    await host.connect();
    await welcome;
    host.send({ op: OP.ROSTER, name: 'Host', hostToken: info.hostToken });
    return { relay, info, psk, host };
}

/** Connects a client; resolves with {socket, welcome} or {socket, rejected}. */
async function dial(info, psk, existing = null) {
    const socket = existing ?? new SecureSocket({ url: `ws://127.0.0.1:${info.port}/`, psk, autoReconnect: false });
    const outcome = Promise.race([
        nextOp(socket, OP.WELCOME).then(welcome => ({ welcome })),
        waitFor(socket, 'rejected').then(rejected => ({ rejected })),
    ]);
    await socket.connect();
    return { socket, ...(await outcome) };
}

async function shutdown(relay, ...sockets) {
    for (const socket of sockets) {
        try { socket?.close('test over'); } catch { /* ignore */ }
    }
    await relay.stop();
    await sleep(60);
}

console.log('\nProtocol constants');

await test('browser and relay agree on the new reject reason and limits', () => {
    assert.equal(protocol.PROTOCOL_REVISION, serverProtocol.PROTOCOL_REVISION);
    assert.equal(REJECT_REASON.ROOM_LOCKED, serverProtocol.REJECT_REASON.ROOM_LOCKED);
    for (const key of ['GLOBAL_FAILURE_LIMIT', 'GLOBAL_FAILURE_WINDOW_MS', 'GLOBAL_BREAKER_MS', 'MAX_TICKETS', 'IDLE_UNMAP_MS']) {
        assert.equal(LIMITS[key], serverProtocol.LIMITS[key], key);
        assert.ok(LIMITS[key] > 0, key);
    }
});

await test('the room key carries at least 128 bits, since the code is the only password', () => {
    assert.ok(protocol.PSK_LENGTH * 8 >= 128);
});

console.log('\nRoom lock');

await test('a locked room refuses a newcomer who has the right code', async () => {
    const { relay, info, psk, host } = await boot();
    relay.setLocked(true);
    const { socket, rejected, welcome } = await dial(info, psk);
    assert.equal(welcome, undefined, 'should not have been welcomed');
    assert.equal(rejected.reason, REJECT_REASON.ROOM_LOCKED);
    assert.equal(socket.autoReconnect, false, 'a locked room is not worth retrying');
    await shutdown(relay, host, socket);
});

await test('a player admitted before the lock can still reconnect with their ticket', async () => {
    const { relay, info, psk, host } = await boot();
    const first = await dial(info, psk);
    assert.ok(first.welcome?.ticket, 'welcome carries a rejoin ticket');
    assert.equal(first.socket.rejoinTicket, first.welcome.ticket);

    relay.setLocked(true);
    // Simulate the phone going to sleep: the socket dies, the object survives.
    const closed = waitFor(first.socket, 'close');
    for (const peer of relay.peers.values()) {
        if (peer.role !== 'host') peer.socket.terminate();
    }
    await closed;

    const again = await dial(info, psk, first.socket);
    assert.ok(again.welcome, `expected readmission, got ${JSON.stringify(again.rejected)}`);
    assert.equal(again.welcome.ticket, first.welcome.ticket, 'the same ticket is kept');
    await shutdown(relay, host, first.socket);
});

await test('a forged ticket does not open a locked room', async () => {
    const { relay, info, psk, host } = await boot();
    relay.setLocked(true);
    const socket = new SecureSocket({ url: `ws://127.0.0.1:${info.port}/`, psk, autoReconnect: false });
    socket.rejoinTicket = Buffer.alloc(18, 1).toString('base64');
    const { rejected } = await dial(info, psk, socket);
    assert.equal(rejected?.reason, REJECT_REASON.ROOM_LOCKED);
    await shutdown(relay, host, socket);
});

await test('the host can always reconnect to a locked room', async () => {
    const { relay, info, psk, host } = await boot();
    relay.setLocked(true);
    host.close('bye');
    await sleep(100);
    const again = new SecureSocket({ url: `ws://127.0.0.1:${info.port}/`, psk, hostToken: info.hostToken, autoReconnect: false });
    const { welcome } = await dial(info, psk, again);
    assert.equal(welcome?.role, 'host');
    await shutdown(relay, again);
});

await test('rotating the code clears the lock\'s guest list', async () => {
    const { relay, info, psk, host } = await boot();
    const first = await dial(info, psk);
    assert.ok(relay.tickets.size >= 1);
    relay.rotate();
    assert.equal(relay.tickets.size, 0);
    await shutdown(relay, host, first.socket);
});

console.log('\nRoom-wide breaker');

await test('many failed handshakes trip the breaker, but loopback (the host) is exempt', async () => {
    const { relay, info, host } = await boot();
    const wrong = new Uint8Array(16).fill(9);
    // Spread failures across "addresses" by driving the private counter directly
    // through repeated bad dials; loopback is one address, so clear its per-IP
    // block between attempts to emulate a distributed guesser.
    for (let i = 0; i < LIMITS.GLOBAL_FAILURE_LIMIT; i++) {
        const { socket } = await dial(info, wrong);
        socket.close('done');
        relay.offenders.clear();
    }
    assert.ok(relay.breakerUntil > Date.now(), 'breaker should be active');
    assert.equal(relay.status().breakerActive, true);

    // The host's own browser connects over loopback and must still get in.
    const again = new SecureSocket({ url: `ws://127.0.0.1:${info.port}/`, psk: fromBase64(info.psk), autoReconnect: false });
    const { welcome } = await dial(info, fromBase64(info.psk), again);
    assert.ok(welcome, 'loopback still admitted while the breaker is active');
    await shutdown(relay, host, again);
});

console.log('\nIdle router mapping');

await test('the router port is released after the room sits empty, and can be reopened', async () => {
    const relay = new Relay({ log: silent });
    let closed = 0, opened = 0;
    relay.portMapper = {
        open: async () => { opened += 1; return { ok: true, method: 'NAT-PMP', externalIp: '203.0.113.7', externalPort: 1 }; },
        close: async () => { closed += 1; },
    };
    await relay.start({ port: PORT(), bindLan: false, roomName: 'idle', requireParity: false, autoMap: false });
    relay.portMapping = { ok: true, method: 'NAT-PMP', externalIp: '203.0.113.7' };

    relay.emptySince = Date.now() - LIMITS.IDLE_UNMAP_MS + 60000;
    relay.sweep();
    assert.equal(relay.portMapping.ok, true, 'not idle long enough yet');

    relay.emptySince = Date.now() - LIMITS.IDLE_UNMAP_MS - 1;
    relay.sweep();
    assert.equal(relay.portMapping.ok, false);
    assert.equal(relay.portMapping.idleClosed, true);
    assert.equal(closed, 1);

    relay.bindLan = true;
    const mapping = await relay.reopenMapping();
    assert.equal(mapping.ok, true);
    assert.equal(opened, 1);
    await relay.stop();
});

console.log('\nIPv6');

await test('IPv6 connection codes round-trip and produce a bracketed URL', () => {
    const psk = new Uint8Array(16).fill(3);
    for (const [input, expected] of [
        ['2001:db8::1', '2001:db8::1'],
        ['[2a02:8070:1:2:3:4:5:6]', '2a02:8070:1:2:3:4:5:6'],
        ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8::ff00:42:8329'],
    ]) {
        const decoded = decodeConnectionCode(encodeConnectionCode({ host: input, port: 8899, psk }));
        assert.equal(decoded.host, expected);
        assert.equal(connectionUrl(decoded), `ws://[${expected}]:8899/`);
    }
    assert.throws(() => encodeConnectionCode({ host: '1::2::3', port: 1, psk }), /IPv6/);
});

await test('IPv6 addresses are classified for the warnings', () => {
    assert.equal(classifyAddress('2001:db8::1'), 'public');
    assert.equal(classifyAddress('fd00::1'), 'lan');
    assert.equal(classifyAddress('fe80::1'), 'lan');
    assert.equal(classifyAddress('::1'), 'loopback');
    assert.equal(isGlobalIPv6('2a00::1'), true);
    assert.equal(isGlobalIPv6('fe80::1'), false);
});

await test('typed addresses keep IPv6 literals and drop schemes and ports', () => {
    assert.equal(cleanHostInput('http://example.com:8899/x'), 'example.com');
    assert.equal(cleanHostInput('203.0.113.5:8899'), '203.0.113.5');
    assert.equal(cleanHostInput('[2001:db8::1]:8899'), '2001:db8::1');
    assert.equal(cleanHostInput('2001:db8::1'), '2001:db8::1');
});

await test('listening beyond loopback is dual-stack where IPv6 exists', async () => {
    const relay = new Relay({ log: silent });
    await relay.start({ port: PORT(), bindLan: true, roomName: 'dual', autoMap: false });
    assert.ok(['::', '0.0.0.0'].includes(relay.status().boundTo));
    await relay.stop();
});

console.log('\nAndroid (Termux) fallbacks');

const deniedOs = { networkInterfaces() { const error = new Error('uv_interface_addresses'); error.code = 'EACCES'; throw error; } };

await test('an interface list that throws does not break address discovery', () => {
    assert.deepEqual(portmap.safeNetworkInterfaces(deniedOs), {});
    assert.deepEqual(localAddresses(deniedOs), []);
    assert.deepEqual(globalIPv6Addresses(deniedOs), []);
});

await test('with no interfaces, common router addresses are tried', () => {
    const candidates = portmap.__testing.candidateGateways(null, []);
    for (const gateway of portmap.COMMON_GATEWAYS) assert.ok(candidates.includes(gateway), gateway);
});

await test('a typed router address goes first and replaces the guesses', () => {
    const candidates = portmap.__testing.candidateGateways('192.168.8.1', []);
    assert.deepEqual(candidates, ['192.168.8.1']);
});

await test('a typed router address must be a private IPv4', () => {
    assert.equal(portmap.normaliseGateway(' 192.168.1.1 '), '192.168.1.1');
    assert.equal(portmap.normaliseGateway('8.8.8.8'), null, 'never a public host');
    assert.equal(portmap.normaliseGateway('127.0.0.1'), null);
    assert.equal(portmap.normaliseGateway('router.lan'), null);
    assert.equal(portmap.normaliseGateway('192.168.1.300'), null);
});

await test('UPnP is probed directly at likely description URLs when multicast finds nothing', () => {
    const locations = portmap.__testing.directIgdLocations(['192.168.1.1']);
    assert.ok(locations.includes('http://192.168.1.1:5000/rootDesc.xml'));
    assert.ok(locations.every(url => url.startsWith('http://192.168.1.1:')));
});

await test('the route trick finds a local address without listing interfaces', async () => {
    const address = await portmap.routeLocalAddress('127.0.0.1');
    assert.equal(address, '127.0.0.1');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
