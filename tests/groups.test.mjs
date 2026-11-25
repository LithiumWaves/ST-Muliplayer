/**
 * SillyTavern group chats in a room.
 *
 * Host side: an open group becomes the room session only when every member is
 * shared, the announcement carries members as portable card ids, and editing
 * the group re-announces it without dropping the transcript.
 *
 * Client side: exactly one local mirror group per host group, reused across
 * repeated and concurrent announcements, updated in place when members change,
 * recovered by its marker when the receipt is lost; group messages map each
 * speaker back to the local stub so portraits line up.
 *
 * Run with:  node tests/groups.test.mjs
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, json, clone } from './helpers/storage.mjs';
import { MultiplayerSession } from '../lib/session.js';
import { ChatBridge } from '../lib/chat.js';
import {
    MirrorGroupStore, describeHostGroup, groupRevision, hostGroupSessionId, isGroupSessionId,
} from '../lib/groups.js';
import { OP, encodeConnectionCode } from '../lib/protocol.js';

const psk = new Uint8Array(16).fill(5);
const code = encodeConnectionCode({ host: '127.0.0.1', port: 24990, psk });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

class FakeSocket extends EventTarget {
    constructor(options) { super(); Object.assign(this, options); this.sent = []; this.opened = false; }
    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    async connect() { this.opened = true; this.emit('open', {}); }
    async send(payload) { if (!this.opened) return false; this.sent.push(payload); return true; }
    close() { this.opened = false; }
    message(payload) { this.emit('message', { payload }); }
}

/** Adds SillyTavern's group endpoints to the storage mock. */
function withGroups(env) {
    const groups = new Map();
    let nextId = 1000;
    env.context.groups = [];
    env.groupCalls = [];
    const baseFetch = env.fetch;
    const refresh = env.context.getCharacters;
    env.context.getCharacters = async () => {
        await refresh();
        env.context.groups = clone([...groups.values()]);
    };
    env.groupDisk = groups;
    env.fetch = async (url, options = {}) => {
        const path = String(url);
        if (path === '/api/groups/create') {
            const body = JSON.parse(options.body);
            env.groupCalls.push({ path, body });
            if (env.failNextGroupCreate) {
                env.failNextGroupCreate = false;
                return json({ error: true }, 500);
            }
            const id = String(nextId++);
            // Like SillyTavern: an explicit field list, unknown fields dropped.
            const group = {
                id, name: body.name, members: body.members ?? [], disabled_members: body.disabled_members ?? [],
                avatar_url: body.avatar_url ?? '', chat_id: id, chats: [id], fav: false,
            };
            groups.set(id, group);
            if (env.loseNextGroupCreate) {
                            throw new TypeError('Simulated network loss after disk write');
            }
            return json(group);
        }
        if (path === '/api/groups/edit') {
            const body = JSON.parse(options.body);
            env.groupCalls.push({ path, body });
            assert.ok(groups.has(String(body.id)), 'edit must never create a group');
            groups.set(String(body.id), clone(body));
            return json({});
        }
        return baseFetch(url, options);
    };
    return env;
}

let nativeFetch, nativeLocation, sessions;
beforeEach(() => {
    nativeFetch = globalThis.fetch;
    nativeLocation = globalThis.location;
    globalThis.location = { protocol: 'http:', hostname: 'localhost' };
    sessions = [];
});
afterEach(async () => {
    for (const session of sessions) await session.leave();
    globalThis.fetch = nativeFetch;
    if (nativeLocation === undefined) delete globalThis.location; else globalThis.location = nativeLocation;
});

async function makeSession(role) {
    const env = withGroups(makeStorage({ settings: { autoReconnect: true } }));
    env.deps.createSocket = options => new FakeSocket(options);
    const session = new MultiplayerSession(env.deps);
    sessions.push(session);
    globalThis.fetch = env.fetch;
    await session.join(code);
    session.role = role;
    session.socket.message({ op: OP.WELCOME, peerId: role === 'host' ? 'host' : 'me', role, roomId: 'room', roomName: 'Room', peers: [] });
    session.socket.message({ op: OP.PARITY_RESULT, ok: true });
    await session._routes;
    await tick();
    return { env, session, get sent() { return session.socket.sent; } };
}

const card = (cardId, name, avatar) => ({ cardId, ownerId: 'owner', sourceId: cardId, name, avatar, defHash: 'd' });

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('a host group id is stable, prefixed, and different per group', () => {
    const settings = {};
    const a = hostGroupSessionId(settings, '111');
    assert.equal(hostGroupSessionId(settings, '111'), a);
    assert.notEqual(hostGroupSessionId(settings, '222'), a);
    assert.ok(isGroupSessionId(a));
    assert.ok(a.length <= 128);
});

test('a group is described by card ids, and unshared members are named', () => {
    const context = { characters: [{ avatar: 'c.png', name: 'Cid' }] };
    const index = [card('id-a', 'Ada', 'a.png'), card('id-b', 'Bo', 'b.png')];
    const full = describeHostGroup(context, { name: 'Party', members: ['a.png', 'b.png'], disabled_members: ['b.png'] }, index);
    assert.deepEqual(full.members, ['id-a', 'id-b']);
    assert.deepEqual(full.disabled, ['id-b']);
    assert.deepEqual(full.missing, []);
    const partial = describeHostGroup(context, { name: 'Party', members: ['a.png', 'c.png'] }, index);
    assert.deepEqual(partial.missing.map(m => m.name), ['Cid']);
});

test('the revision changes with members, mute state and name, not otherwise', () => {
    const base = { name: 'P', members: ['a', 'b'], disabled: [] };
    assert.equal(groupRevision(base), groupRevision({ ...base }));
    assert.notEqual(groupRevision(base), groupRevision({ ...base, members: ['b', 'a'] }));
    assert.notEqual(groupRevision(base), groupRevision({ ...base, disabled: ['a'] }));
    assert.notEqual(groupRevision(base), groupRevision({ ...base, name: 'Q' }));
});

// ---------------------------------------------------------------------------
// Mirror group store
// ---------------------------------------------------------------------------

function storeEnv() {
    const env = withGroups(makeStorage());
    globalThis.fetch = env.fetch;
    return { env, store: new MirrorGroupStore(env.deps) };
}
const spec = overrides => ({
    sessionId: 'grp_owner_group1', name: 'Party', revision: 'r1', memberAvatars: ['a.png', 'b.png'], ...overrides,
});

test('100 repeated and concurrent ensures create exactly one group', async () => {
    const { env, store } = storeEnv();
    const results = await Promise.all(Array.from({ length: 50 }, () => store.ensure(spec())));
    for (let i = 0; i < 50; i++) results.push(await store.ensure(spec()));
    assert.equal(env.groupDisk.size, 1);
    assert.equal(new Set(results.map(r => r.groupId)).size, 1);
    assert.equal(env.groupCalls.filter(c => c.path === '/api/groups/create').length, 1);
    assert.equal(results.filter(r => r.action === 'created').length, 1);
});

test('the mirror carries a marker and is found again by session id', async () => {
    const { env, store } = storeEnv();
    const { groupId } = await store.ensure(spec());
    const saved = env.groupDisk.get(groupId);
    assert.equal(saved.st_multiplayer.sessionId, 'grp_owner_group1');
    assert.equal(store.localGroupId('grp_owner_group1'), groupId);
    assert.equal(store.sessionIdFor(groupId), 'grp_owner_group1');
    assert.equal(store.sessionIdFor('999'), null);
});

test('changed members update the same group in place', async () => {
    const { env, store } = storeEnv();
    const first = await store.ensure(spec());
    const second = await store.ensure(spec({ revision: 'r2', memberAvatars: ['a.png', 'b.png', 'c.png'], disabledAvatars: ['c.png'] }));
    assert.equal(second.groupId, first.groupId);
    assert.equal(second.action, 'updated');
    assert.equal(env.groupDisk.size, 1);
    assert.deepEqual(env.groupDisk.get(first.groupId).members, ['a.png', 'b.png', 'c.png']);
    assert.deepEqual(env.groupDisk.get(first.groupId).disabled_members, ['c.png']);
});

test('a lost receipt is recovered from the marker instead of duplicating', async () => {
    const { env, store } = storeEnv();
    const first = await store.ensure(spec());
    env.settings.sharing.remoteGroups = {};
    const again = await store.ensure(spec());
    assert.equal(again.groupId, first.groupId);
    assert.equal(again.action, 'recovered');
    assert.equal(env.groupDisk.size, 1);
});

test('a deleted mirror group is recreated once', async () => {
    const { env, store } = storeEnv();
    const first = await store.ensure(spec());
    env.groupDisk.delete(first.groupId);
    await env.context.getCharacters();
    const again = await store.ensure(spec());
    assert.notEqual(again.groupId, first.groupId);
    assert.equal(again.action, 'created');
    assert.equal(env.groupDisk.size, 1);
});

test('a failed create is reported, not retried into a duplicate', async () => {
    const { env, store } = storeEnv();
    env.failNextGroupCreate = true;
    await assert.rejects(store.ensure(spec()), /HTTP 500/);
    // The failure happened before anything was written.
    assert.equal(env.groupDisk.size, 0);
    await store.ensure(spec());
    assert.equal(env.groupDisk.size, 1);
});

// ---------------------------------------------------------------------------
// Host session
// ---------------------------------------------------------------------------

test('host: an open group with every member shared becomes the session, with card ids', async () => {
    const h = await makeSession('host');
    h.session.cardIndex = [card('id-a', 'Ada', 'a.png'), card('id-b', 'Bo', 'b.png')];
    h.env.context.groups = [{ id: '7', name: 'Party', members: ['a.png', 'b.png'], disabled_members: [] }];
    h.env.context.groupId = '7';
    h.env.context.getCurrentChatId = () => 'party-chat';
    h.session.announceSession();

    const state = h.sent.filter(p => p.op === OP.SESSION_STATE).at(-1);
    assert.ok(isGroupSessionId(state.cardId));
    assert.equal(state.name, 'Party');
    assert.deepEqual(state.group.members, ['id-a', 'id-b']);
    assert.equal(h.session.inSessionChat(), true);

    // During group generation characterId points at a member: still the group.
    h.env.context.characterId = 0;
    h.env.context.characters = [{ avatar: 'a.png', name: 'Ada' }];
    assert.equal(h.session.currentCardId(), state.cardId);
});

test('host: a group with an unshared member is not a session, and says who is missing', async () => {
    const h = await makeSession('host');
    const logs = [];
    h.session.addEventListener('log', event => logs.push(event.detail.message));
    h.session.cardIndex = [card('id-a', 'Ada', 'a.png')];
    h.env.context.characters = [{ avatar: 'c.png', name: 'Cid' }];
    h.env.context.groups = [{ id: '7', name: 'Party', members: ['a.png', 'c.png'] }];
    h.env.context.groupId = '7';
    h.session.announceSession();
    assert.equal(h.session.activeCardId, null);
    assert.deepEqual(h.session.groupMissing.map(m => m.name), ['Cid']);
    assert.ok(logs.some(message => /Not shared yet: Cid/.test(message)));
});

test('host: editing the group re-announces it without resetting the transcript', async () => {
    const h = await makeSession('host');
    h.session.cardIndex = [card('id-a', 'Ada', 'a.png'), card('id-b', 'Bo', 'b.png')];
    const group = { id: '7', name: 'Party', members: ['a.png'], disabled_members: [] };
    h.env.context.groups = [group];
    h.env.context.groupId = '7';
    h.env.context.getCurrentChatId = () => 'party-chat';
    h.session.announceSession();
    h.session.chat.appliedIds.add('kept');

    group.members.push('b.png');
    h.session.announceSession();
    const states = h.sent.filter(p => p.op === OP.SESSION_STATE);
    assert.equal(states.length, 2);
    assert.deepEqual(states[1].group.members, ['id-a', 'id-b']);
    assert.notEqual(states[1].group.revision, states[0].group.revision);
    assert.ok(h.session.chat.appliedIds.has('kept'), 'transcript state survives a membership change');

    h.session.announceSession();
    assert.equal(h.sent.filter(p => p.op === OP.SESSION_STATE).length, 2, 'no change, no announcement');
});

// ---------------------------------------------------------------------------
// Client session
// ---------------------------------------------------------------------------

async function clientInGroup() {
    const c = await makeSession('client');
    c.session.cardIndex = [card('id-a', 'Ada', 'a.png'), card('id-b', 'Bo', 'b.png')];
    c.session.stubs.set('id-a', 'stub-a.png');
    c.session.stubs.set('id-b', 'stub-b.png');
    const sessionId = 'grp_hostowner_party';
    const announce = (members = ['id-a', 'id-b']) => {
        c.session.socket.message({
            op: OP.SESSION_STATE, cardId: sessionId, name: 'Party',
            group: { name: 'Party', members, disabled: [], revision: members.join('+') },
        });
    };
    return { ...c, sessionId, announce };
}

test('client: the announcement builds one local group from the stubs, across 10 reconnects', async () => {
    const c = await clientInGroup();
    for (let i = 0; i < 10; i++) {
        c.announce();
        await c.session._routes;
        await c.session.ensureMirrorGroup();
    }
    assert.equal(c.env.groupDisk.size, 1);
    const [group] = c.env.groupDisk.values();
    assert.deepEqual(group.members, ['stub-a.png', 'stub-b.png']);
    assert.equal(group.name, 'Party');

    // Opening the mirror is what makes this the session chat.
    c.env.context.groupId = group.id;
    assert.equal(c.session.currentCardId(), c.sessionId);
    assert.equal(c.session.inSessionChat(), true);
});

test('client: the mirror waits until every member has arrived', async () => {
    const c = await clientInGroup();
    c.session.stubs.delete('id-b');
    c.announce();
    await c.session._routes;
    assert.equal(await c.session.ensureMirrorGroup(), null);
    assert.equal(c.env.groupDisk.size, 0);
    c.session.stubs.set('id-b', 'stub-b.png');
    assert.ok(await c.session.ensureMirrorGroup());
    assert.equal(c.env.groupDisk.size, 1);
});

test('client: a membership change updates the same mirror', async () => {
    const c = await clientInGroup();
    c.announce(['id-a']);
    await c.session._routes;
    const first = await c.session.ensureMirrorGroup();
    c.announce(['id-a', 'id-b']);
    await c.session._routes;
    const second = await c.session.ensureMirrorGroup();
    assert.equal(second, first);
    assert.deepEqual(c.env.groupDisk.get(first).members, ['stub-a.png', 'stub-b.png']);
});

test('client: a hostile group payload is bounded', async () => {
    const c = await clientInGroup();
    c.session.socket.message({
        op: OP.SESSION_STATE, cardId: c.sessionId, name: 'x',
        group: { name: 'y'.repeat(500), members: [...Array(200).keys()].map(String).concat([{}]), disabled: ['nope'], revision: 1 },
    });
    await c.session._routes;
    assert.equal(c.session.activeGroup.name.length, 100);
    assert.equal(c.session.activeGroup.members.length, 64);
    assert.deepEqual(c.session.activeGroup.disabled, []);
});

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

function bridgePair() {
    const sent = [];
    const hostContext = {
        chat: [], groupId: '7', characterId: 1,
        characters: [{ avatar: 'a.png', name: 'Ada' }, { avatar: 'b.png', name: 'Bo' }],
        eventSource: { on() {}, removeListener() {} }, eventTypes: {},
    };
    const clientContext = {
        chat: [], name2: 'Someone',
        addOneMessage() {}, printMessages: async () => {}, updateMessageBlock() {}, scrollChatToBottom() {},
    };
    const index = { 'a.png': 'id-a', 'b.png': 'id-b' };
    const host = new ChatBridge({
        getContext: () => hostContext, send: payload => sent.push(payload), role: () => 'host',
        isActive: () => true, speakerCardId: avatar => index[avatar] ?? null,
    });
    const client = new ChatBridge({
        getContext: () => clientContext, send() {}, role: () => 'client', isActive: () => true,
        localAvatar: cardId => ({ 'id-a': 'stub-a.png', 'id-b': 'stub-b.png' })[cardId] ?? null,
    });
    return { host, client, sent, hostContext, clientContext };
}

test('each group message is attributed to the speaker\'s local stub', async () => {
    const { host, client, hostContext, clientContext } = bridgePair();
    hostContext.chat.push(
        { name: 'Ada', is_user: false, mes: 'Hi', original_avatar: 'a.png', extra: { st_multiplayer: { id: 'm1' } } },
        { name: 'Bo', is_user: false, mes: 'Yo', original_avatar: 'b.png', extra: { st_multiplayer: { id: 'm2' } } },
        { name: 'Me', is_user: true, mes: 'Hey', original_avatar: 'a.png', extra: { st_multiplayer: { id: 'm3' } } },
    );
    const snapshot = host.snapshot();
    assert.equal(snapshot[0].speaker, 'id-a');
    assert.equal(snapshot[1].speaker, 'id-b');
    assert.equal(snapshot[2].speaker, undefined, 'player turns have no speaker card');

    await client.applySnapshot({ messages: snapshot });
    assert.equal(clientContext.chat[0].original_avatar, 'stub-a.png');
    assert.equal(clientContext.chat[1].original_avatar, 'stub-b.png');
    assert.equal(clientContext.chat[2].original_avatar, undefined);

    await client.applyRemoteMessage({ message: { ...snapshot[1], extra: { st_multiplayer: { id: 'm4' } } } });
    assert.equal(clientContext.chat.at(-1).original_avatar, 'stub-b.png');
});

test('an unknown speaker card falls back to the default portrait', async () => {
    const { client, clientContext } = bridgePair();
    await client.applyRemoteMessage({ message: { name: 'Ghost', is_user: false, mes: '…', speaker: 'id-zzz', extra: {} } });
    assert.equal(clientContext.chat.at(-1).original_avatar, undefined);
});

test('the live placeholder shows who is speaking', () => {
    const { client, clientContext } = bridgePair();
    client.beginStream({ speaker: 'id-b', speakerName: 'Bo' });
    client.applyStreamToken({ text: 'Thinking' });
    const placeholder = clientContext.chat.at(-1);
    assert.equal(placeholder.name, 'Bo');
    assert.equal(placeholder.original_avatar, 'stub-b.png');
    client.endStream();
    assert.equal(clientContext.chat.length, 0);
});

test('a group asks the host for one reply per player turn, not one per member', () => {
    const sent = [];
    const context = { chat: [{ is_user: true, mes: 'go', extra: { st_multiplayer: { id: 'turn-1' } } }] };
    const bridge = new ChatBridge({ getContext: () => context, send: p => sent.push(p), role: () => 'client', isActive: () => true });
    for (let i = 0; i < 4; i++) bridge.requestGenerationFromHost('normal');
    assert.equal(sent.filter(p => p.op === OP.GEN_REQUEST).length, 1);
    context.chat.push({ is_user: true, mes: 'again', extra: { st_multiplayer: { id: 'turn-2' } } });
    bridge.requestGenerationFromHost('normal');
    assert.equal(sent.filter(p => p.op === OP.GEN_REQUEST).length, 2);
});

test('/mp-ask from a player names the member by card id; unknown names are refused', async () => {
    const c = await clientInGroup();
    c.announce();
    await c.session._routes;
    assert.match(await c.session.askGroupMember('nobody'), /No member/);
    assert.equal(await c.session.askGroupMember('bo'), 'asked');
    const request = c.sent.filter(p => p.op === OP.GEN_REQUEST).at(-1);
    assert.equal(request.member, 'id-b');
});

test('the host turns a member request into a named /trigger', async () => {
    const commands = [];
    const context = {
        chat: [], executeSlashCommandsWithOptions: async command => { commands.push(command); },
    };
    const bridge = new ChatBridge({
        getContext: () => context, send() {}, role: () => 'host', isActive: () => true, autoReply: () => true,
    });
    await bridge.handleGenerationRequest({ name: 'Guest' }, 'Bo "the|bold"');
    await bridge.handleGenerationRequest({ name: 'Guest' });
    assert.deepEqual(commands, ['/trigger await=true "Bo thebold"', '/trigger await=true']);
});
