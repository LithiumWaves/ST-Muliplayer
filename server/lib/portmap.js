/**
 * Automatic port mapping — asks the router to open the port itself.
 *
 * Why this exists
 * --------------
 * Two machines behind home routers cannot accept inbound connections from each
 * other, which is the entire reason cross-network play is awkward. The usual
 * answers all push work onto the user: log into the router and forward a port,
 * or install a mesh VPN on both machines. Both are real setup loops.
 *
 * Routers have supported being asked politely for decades. This module does that
 * over the two protocols consumer routers actually implement:
 *
 *   NAT-PMP (RFC 6886) — tiny binary UDP protocol, one packet each way. Tried
 *     first because it is fast and unambiguous. Apple gear and anything running
 *     a modern OpenWrt/pfSense build speaks it.
 *
 *   UPnP IGD — SSDP discovery, then SOAP over HTTP. Uglier, but it is what most
 *     consumer routers ship with enabled by default.
 *
 * Everything here uses only Node builtins: `dgram` for NAT-PMP and SSDP, `http`
 * for the SOAP calls. No dependency to install, nothing for the user to sign up
 * for, and no third-party service in the path.
 *
 * What it cannot do
 * -----------------
 * If the ISP puts the customer behind carrier-grade NAT, the router has no
 * public address to map and no protocol can change that. That case is detected
 * (the "external" address comes back private) and reported honestly rather than
 * left to fail as a timeout.
 */

import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import { URL } from 'node:url';

const LOG = '[Multiplayer portmap]';

/** Mapping lifetime, refreshed well before it lapses. */
const LEASE_SECONDS = 3600;
const RENEW_MARGIN_MS = 600_000; // renew 10 minutes early

/**
 * Hard ceiling on discovery. Hosting waits for this, so it has to stay short
 * enough that a router which simply is not there does not feel like a hang.
 */
const DISCOVERY_BUDGET_MS = 2600;

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const NATPMP_PORT = 5351;

const DESCRIPTION = 'SillyTavern Multiplayer';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Gateways that consumer routers ship with. Used only when this machine cannot
 * list its own interfaces, which is the normal state of affairs on Android:
 * since Android 11 the netlink call behind `os.networkInterfaces()` is denied to
 * apps such as Termux, so there is nothing to derive a gateway from.
 */
export const COMMON_GATEWAYS = Object.freeze([
    '192.168.1.1', '192.168.0.1', '10.0.0.1', '192.168.1.254',
    '192.168.86.1', '192.168.68.1', '192.168.50.1', '10.0.0.138',
]);

/** A dotted-quad IPv4 in a private range, or null. Used to vet a typed router address. */
export function normaliseGateway(value) {
    const text = String(value ?? '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return null;
    if (text.split('.').some(octet => Number(octet) > 255)) return null;
    // Only ever talk to a router on the local network, never a public host.
    return isPrivateIPv4(text) && !text.startsWith('127.') && !text.startsWith('0.') ? text : null;
}

/**
 * `os.networkInterfaces()`, but never throwing. Android denies the underlying
 * call to Termux and it surfaces as an EACCES exception, which used to take
 * hosting down with it.
 */
export function safeNetworkInterfaces(osModule = os) {
    try {
        return osModule.networkInterfaces() ?? {};
    } catch {
        return {};
    }
}

/** Local IPv4 interfaces, with the subnet mask, so we can guess gateways. */
function localInterfaces(osModule = os) {
    const found = [];
    for (const entries of Object.values(safeNetworkInterfaces(osModule))) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                found.push({ address: entry.address, netmask: entry.netmask });
            }
        }
    }
    return found;
}

/**
 * Candidate gateway addresses for NAT-PMP.
 *
 * Node has no API for the routing table and shelling out to `ip route` /
 * `route print` is platform-specific and brittle. The network address plus one,
 * and the broadcast address minus one, covers essentially every home router.
 */
function candidateGateways(preferred = null, interfaces = localInterfaces()) {
    const candidates = new Set();
    const typed = normaliseGateway(preferred);
    if (typed) candidates.add(typed);
    for (const { address, netmask } of interfaces) {
        const ip = address.split('.').map(Number);
        const mask = String(netmask ?? '255.255.255.0').split('.').map(Number);
        if (ip.length !== 4 || mask.length !== 4) continue;

        const network = ip.map((octet, i) => octet & mask[i]);
        const broadcast = ip.map((octet, i) => (octet & mask[i]) | (~mask[i] & 0xff));

        candidates.add([...network.slice(0, 3), network[3] + 1].join('.'));
        candidates.add([...broadcast.slice(0, 3), broadcast[3] - 1].join('.'));
    }
    // Nothing to derive from (Android), and nothing typed: fall back to the
    // addresses routers ship with. A wrong guess only costs one UDP packet.
    if (interfaces.length === 0 && !typed) {
        for (const gateway of COMMON_GATEWAYS) candidates.add(gateway);
    }
    return [...candidates];
}

export function isPrivateIPv4(address) {
    const octets = String(address ?? '').split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return true;
    const [a, b] = octets;
    return a === 10
        || a === 127
        || a === 0
        || (a === 192 && b === 168)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 169 && b === 254)
        || (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT
}

/** The local address on the same subnet as `gateway`, for NewInternalClient. */
function localAddressFacing(gateway) {
    const target = String(gateway ?? '').split('.').slice(0, 3).join('.');
    for (const { address } of localInterfaces()) {
        if (address.split('.').slice(0, 3).join('.') === target) return address;
    }
    return localInterfaces()[0]?.address ?? null;
}

/**
 * The local address the kernel would use to reach `gateway`, found without
 * listing interfaces: "connecting" a UDP socket only picks a route, it sends
 * nothing, and the socket's own address is then the answer. This is what makes
 * UPnP usable on Android, where the interface list is unavailable.
 */
export function routeLocalAddress(gateway, timeoutMs = 500) {
    return new Promise(resolve => {
        let socket;
        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { socket?.close(); } catch { /* already closed */ }
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        try {
            socket = dgram.createSocket('udp4');
            socket.on('error', () => finish(null));
            socket.connect(NATPMP_PORT, gateway, () => {
                try {
                    const { address } = socket.address();
                    finish(address && address !== '0.0.0.0' ? address : null);
                } catch {
                    finish(null);
                }
            });
        } catch {
            finish(null);
        }
    });
}

/** Interface list first, routing trick second. */
async function internalClientFor(gateway) {
    const target = String(gateway ?? '').split('.').slice(0, 3).join('.');
    for (const { address } of localInterfaces()) {
        if (address.split('.').slice(0, 3).join('.') === target) return address;
    }
    return (await routeLocalAddress(gateway)) ?? localInterfaces()[0]?.address ?? null;
}

/**
 * This machine's LAN address, for showing the host what to forward a port to.
 * Works on Android too, via {@link routeLocalAddress}.
 */
export async function detectLanAddress({ gateway = null } = {}) {
    const listed = localInterfaces().find(({ address }) => isPrivateIPv4(address));
    if (listed) return listed.address;
    for (const candidate of candidateGateways(gateway, [])) {
        const address = await routeLocalAddress(candidate);
        if (address && isPrivateIPv4(address)) return address;
    }
    return null;
}

// ---------------------------------------------------------------------------
// NAT-PMP (RFC 6886)
// ---------------------------------------------------------------------------

/** Sends one NAT-PMP request and waits for the matching reply. */
function natpmpRequest(gateway, payload, expectedOpcode, timeoutMs = 1200) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closed */ }
            error ? reject(error) : resolve(value);
        };

        const timer = setTimeout(() => finish(new Error('NAT-PMP timed out')), timeoutMs);

        socket.on('error', error => finish(error));
        socket.on('message', message => {
            if (message.length < 8) return finish(new Error('NAT-PMP reply too short'));
            if (message[0] !== 0) return finish(new Error('Unsupported NAT-PMP version'));
            if (message[1] !== expectedOpcode) return; // not our reply; keep waiting
            const result = message.readUInt16BE(2);
            if (result !== 0) return finish(new Error(`NAT-PMP refused the request (result ${result})`));
            finish(null, message);
        });

        socket.send(payload, NATPMP_PORT, gateway, error => {
            if (error) finish(error);
        });
    });
}

async function natpmpExternalAddress(gateway) {
    const reply = await natpmpRequest(gateway, Buffer.from([0, 0]), 128);
    if (reply.length < 12) throw new Error('NAT-PMP address reply too short');
    return Array.from(reply.subarray(8, 12)).join('.');
}

async function natpmpMap(gateway, port, lifetimeSeconds) {
    const request = Buffer.alloc(12);
    request[0] = 0;                              // version
    request[1] = 2;                              // opcode 2 = map TCP
    request.writeUInt16BE(0, 2);                 // reserved
    request.writeUInt16BE(port, 4);              // internal port
    request.writeUInt16BE(port, 6);              // suggested external port
    request.writeUInt32BE(lifetimeSeconds, 8);   // 0 deletes the mapping

    const reply = await natpmpRequest(gateway, request, 130);
    if (reply.length < 16) throw new Error('NAT-PMP mapping reply too short');
    return {
        internalPort: reply.readUInt16BE(8),
        externalPort: reply.readUInt16BE(10),
        lifetime: reply.readUInt32BE(12),
    };
}

/**
 * Probes every candidate gateway at once.
 *
 * Sequentially, each unreachable candidate costs a full timeout, and hosting
 * blocked for seconds before the connection code appeared. Concurrently the
 * whole attempt costs one timeout regardless of how many candidates there are.
 */
async function tryNatpmp(port, log, preferred = null) {
    const attempts = candidateGateways(preferred).map(async gateway => {
        const externalIp = await natpmpExternalAddress(gateway);
        const mapping = await natpmpMap(gateway, port, LEASE_SECONDS);
        log('info', `${LOG} NAT-PMP mapped ${mapping.externalPort} via ${gateway}`);
        return {
            method: 'NAT-PMP',
            gateway,
            externalIp,
            externalPort: mapping.externalPort,
            lifetime: mapping.lifetime,
        };
    });
    if (attempts.length === 0) return null;
    // First success wins; if every candidate rejects, resolve to null.
    return Promise.any(attempts).catch(() => null);
}

// ---------------------------------------------------------------------------
// UPnP IGD
// ---------------------------------------------------------------------------

/** Multicast M-SEARCH, collecting IGD LOCATION URLs. */
function ssdpDiscover(timeoutMs = 2000) {
    return new Promise(resolve => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const locations = new Set();

        const search = target => Buffer.from(
            'M-SEARCH * HTTP/1.1\r\n'
            + `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n`
            + 'MAN: "ssdp:discover"\r\n'
            + 'MX: 1\r\n'
            + `ST: ${target}\r\n\r\n`,
        );

        const finish = () => {
            try { socket.close(); } catch { /* already closed */ }
            resolve([...locations]);
        };

        socket.on('error', finish);
        socket.on('message', message => {
            const match = /^location:\s*(\S+)/im.exec(message.toString('utf8'));
            if (match) locations.add(match[1].trim());
        });

        socket.bind(() => {
            try { socket.setBroadcast(true); } catch { /* not fatal */ }
            for (const target of [
                'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
                'urn:schemas-upnp-org:service:WANIPConnection:1',
                'urn:schemas-upnp-org:service:WANPPPConnection:1',
            ]) {
                socket.send(search(target), SSDP_PORT, SSDP_ADDRESS, () => {});
            }
            setTimeout(finish, timeoutMs);
        });
    });
}

/**
 * Minimal HTTP fetch with a hard size and time cap.
 *
 * The URL comes from an SSDP reply, which means it comes from whatever is on the
 * local network. It is validated as a private HTTP address before we touch it,
 * so a hostile device on the LAN cannot use this to make the SillyTavern process
 * fetch arbitrary URLs.
 */
function fetchXml(url, { method = 'GET', body = null, headers = {}, timeoutMs = 3000, maxBytes = 256 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            return reject(new Error('Malformed device URL'));
        }
        if (parsed.protocol !== 'http:') return reject(new Error('Refusing a non-HTTP device URL'));
        if (!isPrivateIPv4(parsed.hostname)) return reject(new Error('Refusing a device URL outside the local network'));

        const request = http.request({
            hostname: parsed.hostname,
            port: parsed.port || 80,
            path: `${parsed.pathname}${parsed.search}`,
            method,
            headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
            timeout: timeoutMs,
        }, response => {
            let size = 0;
            const chunks = [];
            response.on('data', chunk => {
                size += chunk.length;
                if (size > maxBytes) {
                    request.destroy();
                    return reject(new Error('Device response too large'));
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });

        request.on('timeout', () => { request.destroy(); reject(new Error('Device request timed out')); });
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

const WAN_SERVICES = [
    'urn:schemas-upnp-org:service:WANIPConnection:2',
    'urn:schemas-upnp-org:service:WANIPConnection:1',
    'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

/**
 * Finds a WAN connection service in a device description.
 *
 * Matching with regexes rather than pulling in an XML parser: the surface is one
 * well-known document shape, the input is size-capped, and the extracted control
 * URL is re-validated as a private HTTP address before use.
 */
function findWanService(xml, locationUrl) {
    for (const serviceType of WAN_SERVICES) {
        const index = xml.indexOf(serviceType);
        if (index < 0) continue;
        // controlURL appears inside the same <service> block, after serviceType.
        const tail = xml.slice(index, index + 2000);
        const match = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(tail);
        if (!match) continue;
        try {
            return { serviceType, controlUrl: new URL(match[1], locationUrl).toString() };
        } catch {
            continue;
        }
    }
    return null;
}

function soapEnvelope(serviceType, action, args) {
    const body = Object.entries(args)
        .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
        .join('');
    return '<?xml version="1.0"?>'
        + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        + `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body>`
        + '</s:Envelope>';
}

function escapeXml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' }[char]
    ));
}

async function soapCall(service, action, args) {
    const envelope = soapEnvelope(service.serviceType, action, args);
    const response = await fetchXml(service.controlUrl, {
        method: 'POST',
        body: envelope,
        headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            'SOAPAction': `"${service.serviceType}#${action}"`,
            'Connection': 'close',
        },
    });
    if (response.status !== 200) {
        const detail = /<errorDescription>([^<]+)<\/errorDescription>/i.exec(response.body);
        throw new Error(detail ? detail[1] : `Router returned HTTP ${response.status} for ${action}`);
    }
    return response.body;
}

/**
 * Where routers commonly serve their UPnP device description. Used when SSDP
 * multicast finds nothing, which is usual on Android: Wi-Fi drivers drop
 * multicast for apps that do not hold a MulticastLock, and Termux cannot take one.
 */
const IGD_PORTS = [1900, 5000, 49152, 2869, 52869];
const IGD_PATHS = ['/rootDesc.xml', '/igd.xml', '/gatedesc.xml', '/description.xml', '/DeviceDescription.xml'];

function directIgdLocations(gateways) {
    const locations = [];
    for (const gateway of gateways.slice(0, 3)) {
        for (const port of IGD_PORTS) {
            for (const path of IGD_PATHS) locations.push(`http://${gateway}:${port}${path}`);
        }
    }
    return locations;
}

/** Probes the likely description URLs concurrently; returns those that answered. */
async function probeIgdLocations(gateways) {
    const results = await Promise.all(directIgdLocations(gateways).map(async location => {
        try {
            const description = await fetchXml(location, { timeoutMs: 900 });
            return description.status === 200 && findWanService(description.body, location) ? location : null;
        } catch {
            return null;
        }
    }));
    return results.filter(Boolean);
}

/** SSDP first; if multicast is filtered, ask likely gateways directly. */
async function discoverIgd(preferred = null, ssdpTimeoutMs = 1200) {
    const found = await ssdpDiscover(ssdpTimeoutMs).catch(() => []);
    if (found.length) return found;
    const typed = normaliseGateway(preferred);
    const gateways = typed ? [typed] : candidateGateways(null).slice(0, 3);
    return probeIgdLocations(gateways);
}

async function tryUpnp(port, log, preferred = null) {
    const locations = await discoverIgd(preferred);
    if (locations.length === 0) return null;

    for (const location of locations) {
        try {
            const description = await fetchXml(location);
            const service = findWanService(description.body, location);
            if (!service) continue;

            const internalClient = await internalClientFor(new URL(location).hostname);
            if (!internalClient) continue;

            await soapCall(service, 'AddPortMapping', {
                NewRemoteHost: '',
                NewExternalPort: port,
                NewProtocol: 'TCP',
                NewInternalPort: port,
                NewInternalClient: internalClient,
                NewEnabled: 1,
                NewPortMappingDescription: DESCRIPTION,
                NewLeaseDuration: LEASE_SECONDS,
            });

            let externalIp = null;
            try {
                const body = await soapCall(service, 'GetExternalIPAddress', {});
                externalIp = /<NewExternalIPAddress>\s*([^<]*?)\s*<\/NewExternalIPAddress>/i.exec(body)?.[1] ?? null;
            } catch {
                // The mapping is what matters; the address is a bonus.
            }

            log('info', `${LOG} UPnP mapped port ${port} via ${new URL(location).hostname}`);
            return {
                method: 'UPnP', gateway: new URL(location).hostname, externalIp, externalPort: port, service, internalClient,
            };
        } catch (error) {
            log('info', `${LOG} ${location}: ${error.message}`);
        }
    }
    return null;
}

async function upnpDelete(service, port) {
    await soapCall(service, 'DeletePortMapping', {
        NewRemoteHost: '',
        NewExternalPort: port,
        NewProtocol: 'TCP',
    });
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Holds one mapping and keeps it alive.
 *
 * The lease is deliberately time-limited and renewed rather than permanent: if
 * SillyTavern is killed without running its exit hook, the hole in the router
 * closes on its own within the hour instead of staying open indefinitely.
 */
export class PortMapper {
    constructor({ log = () => {} } = {}) {
        this.log = log;
        /** @type {null | {method: string, gateway: string, externalIp: string|null, externalPort: number}} */
        this.mapping = null;
        this.port = 0;
        this._renewTimer = null;
        this._service = null;
        this._internalClient = null;
    }

    /**
     * Attempts to open `port` on the router.
     * @returns {Promise<{ok: boolean, method?: string, externalIp?: string|null,
     *   externalPort?: number, reason?: string, cgnat?: boolean}>}
     */
    async open(port, { gateway = null } = {}) {
        this.port = port;
        await this.close();

        // NAT-PMP and UPnP are tried together rather than in sequence: a router
        // speaks at most one of them, and waiting out the first protocol's
        // timeout before starting the second doubled the delay before hosting
        // could report a code. A hard overall budget keeps that bounded even if
        // a router accepts a connection and then stalls.
        const attempt = (async () => {
            const [natpmp, upnp] = await Promise.all([
                tryNatpmp(port, this.log, gateway).catch(() => null),
                tryUpnp(port, this.log, gateway).catch(() => null),
            ]);
            return natpmp ?? upnp;
        })();

        const result = await Promise.race([
            attempt,
            new Promise(resolve => setTimeout(() => resolve(null), DISCOVERY_BUDGET_MS)),
        ]);

        if (!result) {
            return {
                ok: false,
                reason: 'The router did not respond to NAT-PMP or UPnP. It may have automatic port '
                    + 'mapping disabled, or there may be a second router between this machine and the internet. '
                    + 'On Android, try typing your router\'s address in "Router address", or forward the port by hand.',
            };
        }

        this._service = result.service ?? null;
        this._internalClient = result.internalClient ?? null;
        this.mapping = {
            method: result.method,
            gateway: result.gateway,
            externalIp: result.externalIp ?? null,
            externalPort: result.externalPort,
        };

        // A private "external" address means the ISP is running carrier-grade
        // NAT. The mapping succeeded on this router, but there is a second layer
        // of NAT above it that cannot be asked for anything.
        const cgnat = Boolean(result.externalIp) && isPrivateIPv4(result.externalIp);
        if (cgnat) {
            return {
                ok: false,
                cgnat: true,
                method: result.method,
                externalIp: result.externalIp,
                externalPort: result.externalPort,
                reason: `The router reports its public address as ${result.externalIp}, which is itself a private `
                    + 'address — your ISP is using carrier-grade NAT, and no port forward can get through that. '
                    + 'Mobile data is almost always like this, so host from home Wi-Fi/broadband. If home internet '
                    + 'is CGNAT too, ask the ISP for a public IPv4 address, or try the IPv6 address shown in the panel.',
            };
        }

        this.#scheduleRenewal();
        return {
            ok: true,
            method: result.method,
            externalIp: result.externalIp ?? null,
            externalPort: result.externalPort,
        };
    }

    #scheduleRenewal() {
        clearTimeout(this._renewTimer);
        const delay = Math.max(60_000, LEASE_SECONDS * 1000 - RENEW_MARGIN_MS);
        this._renewTimer = setTimeout(async () => {
            if (!this.mapping) return;
            try {
                if (this.mapping.method === 'NAT-PMP') {
                    await natpmpMap(this.mapping.gateway, this.port, LEASE_SECONDS);
                } else if (this._service) {
                    await soapCall(this._service, 'AddPortMapping', {
                        NewRemoteHost: '',
                        NewExternalPort: this.mapping.externalPort,
                        NewProtocol: 'TCP',
                        NewInternalPort: this.port,
                        NewInternalClient: this._internalClient ?? localAddressFacing(this.mapping.gateway),
                        NewEnabled: 1,
                        NewPortMappingDescription: DESCRIPTION,
                        NewLeaseDuration: LEASE_SECONDS,
                    });
                }
                this.log('info', `${LOG} renewed the ${this.mapping.method} mapping`);
            } catch (error) {
                this.log('warn', `${LOG} could not renew the mapping: ${error.message}`);
            }
            this.#scheduleRenewal();
        }, delay);
        this._renewTimer.unref?.();
    }

    /** Removes the mapping. Safe to call when nothing is mapped. */
    async close() {
        clearTimeout(this._renewTimer);
        const mapping = this.mapping;
        this.mapping = null;
        if (!mapping) return;

        try {
            if (mapping.method === 'NAT-PMP') {
                await natpmpMap(mapping.gateway, this.port, 0);
            } else if (this._service) {
                await upnpDelete(this._service, mapping.externalPort);
            }
            this.log('info', `${LOG} removed the ${mapping.method} mapping`);
        } catch (error) {
            // The lease expires on its own, so this is not worth escalating.
            this.log('info', `${LOG} could not remove the mapping cleanly: ${error.message}`);
        }
        this._service = null;
    }
}

/**
 * Asks the router for its public address without creating a mapping.
 *
 * Separate from {@link PortMapper.open} because the two can fail independently:
 * plenty of routers will answer "what is my WAN address" while refusing to add a
 * port mapping, and in that case the user still needs the address so they can
 * forward the port by hand. Answering from the router keeps this entirely on the
 * local network — no external lookup service involved.
 *
 * @returns {Promise<{ok: boolean, address?: string, method?: string, cgnat?: boolean, reason?: string}>}
 */
export async function queryExternalAddress({ log = () => {}, gateway = null } = {}) {
    // NAT-PMP first: one UDP packet, no mapping side effects.
    const natpmpAttempts = candidateGateways(gateway).map(async gateway => ({
        address: await natpmpExternalAddress(gateway),
        method: 'NAT-PMP',
    }));

    let found = natpmpAttempts.length
        ? await Promise.any(natpmpAttempts).catch(() => null)
        : null;

    if (!found) {
        // UPnP GetExternalIPAddress is read-only too.
        const locations = await discoverIgd(gateway, 1500).catch(() => []);
        for (const location of locations) {
            try {
                const description = await fetchXml(location);
                const service = findWanService(description.body, location);
                if (!service) continue;
                const body = await soapCall(service, 'GetExternalIPAddress', {});
                const address = /<NewExternalIPAddress>\s*([^<]*?)\s*<\/NewExternalIPAddress>/i.exec(body)?.[1];
                if (address) {
                    found = { address, method: 'UPnP' };
                    break;
                }
            } catch (error) {
                log('info', `${LOG} ${location}: ${error.message}`);
            }
        }
    }

    if (!found?.address) {
        return { ok: false, reason: 'The router would not report its public address over NAT-PMP or UPnP.' };
    }

    if (isPrivateIPv4(found.address)) {
        return {
            ok: false,
            cgnat: true,
            address: found.address,
            method: found.method,
            reason: `The router reports ${found.address}, which is a private address — your ISP is using `
                + 'carrier-grade NAT, so this is not reachable from the internet.',
        };
    }

    return { ok: true, address: found.address, method: found.method };
}

export const __testing = {
    candidateGateways,
    directIgdLocations,
    findWanService,
    soapEnvelope,
    escapeXml,
    localInterfaces,
};
