/**
 * {{user}} in shared personas.
 *
 * A persona written as "{{user}} Siltala is a soldier" reached the host's model
 * as "Mika: Kaede Siltala is a soldier", because the HOST's SillyTavern expanded
 * {{user}} to the host's own name. These tests pin the macro to the persona's
 * author on the sending side, and on the host as a fallback for older peers.
 *
 * Run with:  node tests/macros.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { resolveUserMacro, resolveUserMacroInBook } = await import(path.join(root, 'lib/macros.js'));
const { buildSessionBook } = await import(path.join(root, 'lib/lore.js'));
const { ChatBridge } = await import(path.join(root, 'lib/chat.js'));

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`  ✗ ${name}\n      ${error.message}`);
        failed += 1;
    }
}

function bridgeFor(selfName, power = {}, extra = {}) {
    const injected = [];
    const context = {
        chat: [],
        eventSource: { on() {}, removeListener() {}, emit() {} },
        eventTypes: {},
        // Mimics SillyTavern: {{user}} expands to THIS machine's persona.
        substituteParams: text => String(text).replace(/\{\{user\}\}/gi, selfName),
        powerUserSettings: power,
        setExtensionPrompt: (key, value) => injected.push({ key, value }),
        extensionPromptTypes: { IN_PROMPT: 0, IN_CHAT: 1 },
        extensionPromptRoles: { SYSTEM: 0 },
        ...extra,
    };
    const bridge = new ChatBridge({
        getContext: () => context,
        send: () => {},
        role: () => 'host',
        isActive: () => true,
        selfPeerId: () => 'me',
    });
    return { bridge, injected, context };
}

console.log('\nThe helper');

await test('resolves {{user}} in any case and spacing, and <USER>', () => {
    assert.equal(resolveUserMacro('{{user}} / {{USER}} / {{ User }} / <USER>', 'Mika'), 'Mika / Mika / Mika / Mika');
});

await test('leaves {{char}} and other macros for the host', () => {
    assert.equal(resolveUserMacro('{{user}} met {{char}} on {{date}}', 'Mika'), 'Mika met {{char}} on {{date}}');
});

await test('inserts names containing $ patterns literally', () => {
    assert.equal(resolveUserMacro('Hi {{user}}', '$& $1'), 'Hi $& $1');
});

await test('an empty name leaves the text untouched', () => {
    assert.equal(resolveUserMacro('{{user}} waves', ''), '{{user}} waves');
});

await test('books are copied, not mutated', () => {
    const book = { entries: { 0: { key: ['{{user}}'], content: '{{user}} is tall.' } } };
    const out = resolveUserMacroInBook(book, 'Mika');
    assert.equal(out.entries[0].content, 'Mika is tall.');
    assert.deepEqual(out.entries[0].key, ['Mika']);
    assert.equal(book.entries[0].content, '{{user}} is tall.', 'the cached original must stay intact');
});

console.log('\nSending side');

await test("a player's description is sent with {{user}} already meaning that player", async () => {
    const { bridge } = bridgeFor('Mika', { persona_description: '{{user}} Siltala is 23, a Finnish soldier.' });
    const persona = await bridge.describeLocalPersona();
    assert.equal(persona.name, 'Mika');
    assert.equal(persona.description, 'Mika Siltala is 23, a Finnish soldier.');
});

await test("a player's lorebook is sent resolved, without touching the local book", async () => {
    const original = { entries: { 0: { key: ['{{user}}'], keysecondary: [], content: '{{user}} served two years.' } } };
    const { bridge } = bridgeFor('Mika', { persona_description: 'x', persona_description_lorebook: 'Mika lore' }, {
        loadWorldInfo: async () => original,
    });
    const persona = await bridge.describeLocalPersona();
    assert.equal(persona.lorebook.entries[0].content, 'Mika served two years.');
    assert.deepEqual(persona.lorebook.entries[0].key, ['Mika']);
    assert.equal(original.entries[0].content, '{{user}} served two years.');
});

console.log('\nHost side (fallback for older peers)');

await test("the host's prompt never turns another player's {{user}} into the host", () => {
    const { bridge } = bridgeFor('Kaede');
    bridge.rememberPersona('p2', { name: 'Mika', description: '{{user}} Siltala is 23, a Finnish soldier.' });
    const text = bridge.injectPersonas(4, 'me');
    assert.match(text, /Mika: Mika Siltala is 23/);
    assert.doesNotMatch(text, /\{\{user\}\}/i);
    assert.doesNotMatch(text, /Kaede Siltala/);
});

await test("merged lore resolves {{user}} to the book's owner", () => {
    const { entries } = buildSessionBook([{
        peerId: 'p2',
        name: 'Mika',
        lorebook: { entries: { 0: { key: ['{{user}}', 'rifle'], keysecondary: ['<USER>'], content: '{{user}} carries a rifle.' } } },
    }], { excludePeerId: 'me' });
    assert.equal(entries[0].content, 'Mika carries a rifle.');
    assert.deepEqual(entries[0].key, ['Mika', 'rifle']);
    assert.deepEqual(entries[0].keysecondary, ['Mika']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
