/**
 * SillyTavern group chats in a multiplayer room.
 *
 * The host plays in an ordinary SillyTavern group whose members are shared
 * characters. Each client mirrors it with a local group made of the stubs it
 * already keeps for those characters, so the group chat renders with the right
 * names and portraits and the transcript arrives the same way a single
 * character's does.
 *
 * Mirror groups follow the same durability rules as received character cards:
 * a receipt keyed by the host's stable group identity maps to one local group,
 * which is reused or updated, never duplicated, across reconnects, reloads and
 * new connection codes. The local group also carries the identity in its own
 * file, so a create whose response was lost can be recovered.
 */

import { canonicalJson, newIdentity, sharedWrite, sharingState, validIdentity } from './identity.js';

export const GROUP_TAG = 'st_multiplayer';
export const GROUP_SESSION_PREFIX = 'grp_';

/** True when a room session id names a group rather than a character card. */
export const isGroupSessionId = value => typeof value === 'string' && value.startsWith(GROUP_SESSION_PREFIX);

/**
 * Host: the durable session id for one of its groups. Built from the host's
 * owner id and a per-group source id, so it is stable across rooms and codes
 * but never collides with another host's group of the same name.
 */
export function hostGroupSessionId(settings, groupId, save = () => {}) {
    const state = sharingState(settings, save);
    const key = JSON.stringify(String(groupId));
    if (!Object.hasOwn(state.groupSources, key) || !validIdentity(state.groupSources[key])) {
        state.groupSources[key] = newIdentity();
        save();
    }
    return `${GROUP_SESSION_PREFIX}${state.ownerId.slice(0, 32)}_${state.groupSources[key].slice(0, 32)}`;
}

/** Host: the group currently open, or null. */
export function currentGroup(context) {
    const id = context?.groupId;
    if (id === undefined || id === null || id === '') return null;
    return (context.groups ?? []).find(group => String(group.id) === String(id)) ?? null;
}

/**
 * Host: describes a group in terms of shared card ids. `missing` lists members
 * that are not in the shared catalogue, by name, so the host can be asked to
 * share them; a group with any missing member is not a room session.
 */
export function describeHostGroup(context, group, cardIndex) {
    const members = [], missing = [];
    for (const avatar of group?.members ?? []) {
        const entry = cardIndex.find(candidate => candidate.avatar === avatar);
        if (entry) {
            members.push(entry.cardId);
        } else {
            const character = (context.characters ?? []).find(candidate => candidate.avatar === avatar);
            missing.push({ avatar, name: character?.name ?? avatar });
        }
    }
    const disabled = (group?.disabled_members ?? [])
        .map(avatar => cardIndex.find(candidate => candidate.avatar === avatar)?.cardId)
        .filter(Boolean);
    return { members, missing, disabled, name: String(group?.name ?? 'Group').slice(0, 100) };
}

/**
 * A revision that changes whenever anything mirrored about the group does.
 * Synchronous (FNV-1a) because it is computed on every chat change.
 */
export function groupRevision(group) {
    const text = canonicalJson({ name: group.name, members: group.members, disabled: group.disabled ?? [] });
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Client: the store of mirror groups.
 *
 * @param {object} deps
 * @param {() => object} deps.getContext
 * @param {() => object} deps.settings
 * @param {() => void} deps.save
 * @param {(options?: object) => object} deps.getRequestHeaders
 */
export class MirrorGroupStore {
    constructor(deps) {
        this.deps = deps;
    }

    get #state() {
        return sharingState(this.deps.settings(), this.deps.save);
    }

    /** The local group id mirroring `sessionId`, if one is known and still exists. */
    localGroupId(sessionId) {
        const receipt = this.#state.remoteGroups[JSON.stringify(sessionId)];
        if (!receipt) return null;
        const exists = (this.deps.getContext().groups ?? []).some(group => String(group.id) === String(receipt.groupId));
        return exists ? String(receipt.groupId) : null;
    }

    /** The session id a local group mirrors, or null for an ordinary group. */
    sessionIdFor(localGroupId) {
        if (localGroupId === undefined || localGroupId === null || localGroupId === '') return null;
        for (const [key, receipt] of Object.entries(this.#state.remoteGroups)) {
            if (String(receipt?.groupId) === String(localGroupId)) return JSON.parse(key);
        }
        const group = (this.deps.getContext().groups ?? []).find(candidate => String(candidate.id) === String(localGroupId));
        const marked = group?.[GROUP_TAG]?.sessionId;
        return isGroupSessionId(marked) ? marked : null;
    }

    /**
     * Creates or updates the local mirror of a host group. Serialised per
     * session id (and across tabs where Web Locks exist), so concurrent session
     * announcements cannot create two groups.
     *
     * @param {object} spec
     * @param {string} spec.sessionId
     * @param {string} spec.name
     * @param {string} spec.revision
     * @param {string[]} spec.memberAvatars local stub filenames, in host order
     * @param {string[]} [spec.disabledAvatars]
     * @param {string} [spec.roomName]
     * @returns {Promise<{groupId: string, action: 'reused'|'updated'|'created'|'recovered'}>}
     */
    ensure(spec) {
        return sharedWrite(`group:${spec.sessionId}`, () => this.#ensure(spec));
    }

    async #ensure({ sessionId, name, revision, memberAvatars, disabledAvatars = [], roomName = '' }) {
        if (!isGroupSessionId(sessionId)) throw new Error('Not a group session id.');
        const context = this.deps.getContext();
        const state = this.#state;
        const key = JSON.stringify(sessionId);
        const groups = () => this.deps.getContext().groups ?? [];

        let receipt = state.remoteGroups[key] ?? null;
        let group = receipt ? groups().find(candidate => String(candidate.id) === String(receipt.groupId)) : null;
        let action = 'reused';

        // Receipt lost (settings reset) or create response lost: adopt by marker.
        if (!group) {
            group = groups().find(candidate => candidate?.[GROUP_TAG]?.sessionId === sessionId) ?? null;
            if (group) action = 'recovered';
        }

        const desired = {
            name: `${name}`.slice(0, 100),
            members: [...memberAvatars],
            disabled_members: disabledAvatars.filter(avatar => memberAvatars.includes(avatar)),
        };

        if (!group) {
            const response = await fetch('/api/groups/create', {
                method: 'POST',
                headers: this.deps.getRequestHeaders(),
                body: JSON.stringify({
                    ...desired,
                    avatar_url: '',
                    allow_self_responses: false,
                    activation_strategy: 0,
                    generation_mode: 0,
                    chat_metadata: {},
                    fav: false,
                }),
            });
            if (!response.ok) throw new Error(`Could not create the room's group (HTTP ${response.status}).`);
            group = await response.json();
            if (!group?.id) throw new Error('SillyTavern did not return the new group.');
            action = 'created';
            // Remember it before anything else can fail, so a retry reuses it.
            state.remoteGroups[key] = { groupId: String(group.id), revision: null };
            this.deps.save();
        }

        const sameMembers = canonicalJson(group.members ?? []) === canonicalJson(desired.members)
            && canonicalJson(group.disabled_members ?? []) === canonicalJson(desired.disabled_members);
        const marked = group[GROUP_TAG]?.sessionId === sessionId;
        if (action !== 'reused' || !sameMembers || group.name !== desired.name || !marked
            || state.remoteGroups[key]?.revision !== revision) {
            const updated = {
                ...group,
                ...desired,
                [GROUP_TAG]: { sessionId, revision, roomName: String(roomName ?? '').slice(0, 60) },
            };
            const response = await fetch('/api/groups/edit', {
                method: 'POST',
                headers: this.deps.getRequestHeaders(),
                body: JSON.stringify(updated),
            });
            if (!response.ok) throw new Error(`Could not update the room's group (HTTP ${response.status}).`);
            if (action === 'reused') action = 'updated';
            group = updated;
        }

        state.remoteGroups[key] = { groupId: String(group.id), revision };
        this.deps.save();

        // getCharacters() also reloads groups in SillyTavern. Fall back to
        // patching the live array when the refreshed list does not include it.
        await context.getCharacters?.();
        const live = groups();
        const index = live.findIndex(candidate => String(candidate.id) === String(group.id));
        if (index < 0) live.push(group);
        else if (!live[index][GROUP_TAG]) Object.assign(live[index], group);

        return { groupId: String(group.id), action };
    }
}

/**
 * Opens a group chat by id, using whichever entry point this SillyTavern has.
 * Returns false when none was available.
 */
export async function openGroup(context, groupId) {
    if (typeof context.openGroupChat === 'function') {
        await context.openGroupChat(groupId);
        return true;
    }
    if (typeof document !== 'undefined') {
        const element = document.querySelector(`.group_select[data-grid="${CSS.escape(String(groupId))}"]`);
        if (element) {
            element.click();
            return true;
        }
    }
    return false;
}
