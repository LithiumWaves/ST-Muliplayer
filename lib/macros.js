/**
 * Player-relative macros in shared persona text.
 *
 * Persona descriptions and persona lorebooks are usually written with
 * SillyTavern's `{{user}}` macro ("{{user}} is a 23-year-old soldier…"). On the
 * author's machine that means the author. Shipped raw, though, the macro is
 * expanded by whichever SillyTavern builds the prompt, which is the HOST's, so
 * every other player's persona was rewritten to be about the host: a persona
 * called Mika described as "{{user}} Siltala" reached the model as
 * "Mika: Kaede Siltala…".
 *
 * So `{{user}}` (and its legacy alias `<USER>`) is resolved to the persona's own
 * name before the text leaves the author, and again on the host as a fallback
 * for peers running an older build. Everything else, `{{char}}` included, is
 * left for the host to expand, because the host's active character is the
 * shared one and is the correct referent there.
 */

const USER_MACRO = /\{\{\s*user\s*\}\}|<USER>/gi;

/**
 * Replaces the user macro in `text` with `name`.
 * @param {unknown} text
 * @param {unknown} name
 * @returns {string}
 */
export function resolveUserMacro(text, name) {
    const value = String(text ?? '');
    const who = String(name ?? '').trim();
    if (!who) return value;
    // A function replacer, so a name containing `$&` or `$1` is inserted literally.
    return value.replace(USER_MACRO, () => who);
}

/**
 * Returns a copy of a World Info book with the user macro resolved in every
 * entry's content, keys and comment. The input is never mutated: books returned
 * by `loadWorldInfo` can be SillyTavern's own cached objects.
 * @param {object|null|undefined} book
 * @param {string} name
 */
export function resolveUserMacroInBook(book, name) {
    if (!book || typeof book !== 'object' || !book.entries) return book;
    const fixEntry = entry => {
        if (!entry || typeof entry !== 'object') return entry;
        const out = { ...entry };
        if (typeof out.content === 'string') out.content = resolveUserMacro(out.content, name);
        if (typeof out.comment === 'string') out.comment = resolveUserMacro(out.comment, name);
        for (const field of ['key', 'keys', 'keysecondary']) {
            if (Array.isArray(out[field])) out[field] = out[field].map(key => (typeof key === 'string' ? resolveUserMacro(key, name) : key));
        }
        return out;
    };
    const entries = Array.isArray(book.entries)
        ? book.entries.map(fixEntry)
        : Object.fromEntries(Object.entries(book.entries).map(([id, entry]) => [id, fixEntry(entry)]));
    return { ...book, entries };
}
