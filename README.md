# SillyTavern Multiplayer

One host, one shared roleplay, and a separate persona for each player. The host
runs the model; joining players do not need their own inference API keys.

**Version 1.6.0: an extension API (Phone Trigger multiplayer). 1.5.0: internet play without a VPN, phone hosting, and group chats.**
Both the browser extension and the host relay must be updated together. The wire
revision is `STMP/1.6.0`; older peers are deliberately rejected rather than mixed
into the same room.

## What changed in 1.6.0

- **Extension API.** Other extensions can now talk to the room through
  `globalThis.STMultiplayer`: see who is playing and exchange their own messages
  with one player, the host, or everyone. Phone Trigger uses it for mail and calls
  between players and for shared D-Mails and time leaps. See
  [Extension API](#extension-api).
- New opcode `ext.message`; the wire revision is now `STMP/1.6.0`. Update the
  extension and the relay together, on every machine.

## Extension API

Installed when Multiplayer activates, removed when it is disabled. Messages
travel over the room's encrypted channel, are stamped with the real sender by
the relay, and are never written to the chat.

```js
const mp = globalThis.STMultiplayer;      // undefined when Multiplayer is not loaded
mp.isConnected();                         // in a room right now?
mp.role();                                // 'host' | 'client' | null
mp.selfId(); mp.hostId();                 // peer ids (change on reconnect)
mp.peers();                               // [{ id, name, role, isMe, persona: { name, description, ownerId } | null }]
mp.send('myext.ping', { any: 'json' }, { to: peerId });  // or to: 'host', or omit for everyone else
const off = mp.on('myext.ping', ({ channel, data, from, name, role }) => { /* ... */ });
const offRoster = mp.onRoster(peers => { /* connection, players or personas changed */ });
```

`document` also receives `stmp:ready` (the API was installed) and `stmp:roster`
(`detail.peers`). Channel names should be namespaced and at most 64 characters;
a message may be up to 512 KiB on the wire.

## What changed in 1.5.0

- **No VPN needed.** Play over the internet through your own router: automatic
  NAT-PMP/UPnP mapping, or one manual port forward. No Radmin, Tailscale, tunnel
  or account is involved. See
  [Play over the internet without a VPN](#play-over-the-internet-without-a-vpn).
- **Hosting from Android (Termux).** Address and router discovery no longer
  depend on Android's blocked interface list. A **Router address** field covers
  routers that cannot be found automatically.
- **Safer when the port is public.** A room-wide breaker stops guessing spread
  across many addresses. **Lock room** shuts the door once everyone is in, while
  a player whose phone slept can still reconnect. The router port closes by
  itself after 30 minutes with nobody but the host.
- **Mobile reconnects.** When the SillyTavern tab comes back to the foreground or
  the phone comes back online, it reconnects at once.
- **IPv6.** The relay listens dual-stack and connection codes can carry an IPv6
  address, which often needs no forwarding at all.
- **SillyTavern group chats.** The host opens a group whose members are all shared.
  Every player gets the same group, with each message under the right character's
  name and portrait. `/mp-ask Name` asks a particular member to answer.

## What changed in 1.4.0

The manifest minimum remains SillyTavern 1.13.0. The character and persona API
contracts were reviewed against upstream source, and the automated tests below
pass. This release has **not** been exercised inside a complete running
SillyTavern installation or on a real Tailscale connection. See
[TEST_REPORT.md](TEST_REPORT.md) for the tested environment and remaining manual
checks. The previous README's blanket claim of verification against 1.18.0 has
been removed.

## What changed in 1.4.0

The 1.4.0 relay stopped reusing `welcome` for host-name updates. A browser answered that
message with another roster/name announcement, producing a feedback loop.
Repeated reconnects also left old connection IDs in the persona map. This
release separates initial admission from `welcome.update`, makes admission
idempotent, prunes departed personas, and ignores obsolete socket callbacks.
The undefined `kind` variable in the router-mapping warning is fixed too.

Character sharing now has a durable owner ID and a durable source-card ID.
Those identify the same original across reconnects, page reloads, room changes,
and new connection codes. The receiver remembers its existing local filename.
Replaying the same revision does not import or edit the card again. A changed
revision updates the same file, preserving its chat association and favourite
state rather than making another copy. Host-side session copies follow the
same rules.

Additional safeguards include serialized per-item writes, disk verification,
recovery after an ambiguous/lost import response, content hashes for definitions
and portraits, bounded avatar reassembly, bounded reconnect retries, send pacing
below the relay's rate limits, and cleanup of event listeners and observers on
disable/re-enable. New **Shared storage / recovery** and **Resync shared data**
controls make synchronization problems easier to inspect and recover from.

**Existing duplicates are not automatically deleted.** A character with a chat
history is not disposable just because its name resembles another character.
The recovery workflow below lets you choose an old remote copy to keep.

## Upgrading an existing installation

1. Back up your SillyTavern data, including settings, characters, personas, chats,
   and World Info. Stop active rooms. Preserve your existing extension settings;
   clearing them is not a deduplication fix.
2. Replace the contents of the **existing** Multiplayer extension folder with
   this release, on the host and on every joining player's installation. Do not
   install a second copy under another folder name. Keep your normal repository
   directory if you plan to commit or apply the supplied patch.
3. On the host, run `node install.mjs` from that extension folder again. This is
   especially important when the relay was installed with `--copy`. Set
   `enableServerPlugins: true` if it is not already enabled.
4. Fully restart the host's SillyTavern server, then reload every player's
   browser page. Start a new room and distribute its new code. Use matching
   extension versions before testing reconnection.

On Windows, `install-windows.bat` runs the installer and helps locate Node. A
browser refresh alone does not reload the server plugin. An old relay paired
with a new browser extension will report a protocol mismatch.

## Installing from scratch

### Everyone: browser extension

Install Guided Generations first:

```text
https://github.com/Samueras/GuidedGenerations-Extension
```

Then use **Extensions > Install extension** with:

```text
https://github.com/PoweringManipulation2/Vibed-ST-Muliplayer
```

The dependency in `manifest.json` uses the folder name
`GuidedGenerations-Extension`. A manually renamed checkout must match that
name, or you must adjust the dependency to the actual folder name.

A manual Multiplayer checkout can live in either extension location:

| Scope | Directory under SillyTavern |
| --- | --- |
| Per user | `data/<user>/extensions/<extension-folder>/` |
| Global | `public/scripts/extensions/third-party/<extension-folder>/` |

Joining someone else's room needs only the browser extension. Hosting needs
the companion relay too.

### Host only: server relay

From inside the installed extension folder:

```bash
node install.mjs --enable
```

This links `server/` into `SillyTavern/plugins/st-multiplayer`, checks whether
`ws` resolves from the SillyTavern installation, and enables server plugins.
Changing `config.yaml` with `--enable` first creates a timestamped backup.
Fully restart SillyTavern afterward.

Other installer options:

```bash
node install.mjs                         # link and inspect config, without changing it
node install.mjs --root /path/to/ST       # specify the SillyTavern root explicitly
node install.mjs --copy                   # copy the relay instead of linking it
node install.mjs --uninstall              # remove the installed relay
```

A copied relay does not follow later extension updates; rerun the installer.
The installer prints a warning if `ws` cannot be resolved. The standalone test
setup described below is not required merely to use the extension.

## Playing a session

**Hosting.** Open **Extensions > Multiplayer**, choose the characters to share,
and start hosting. Share the connection code privately. The code contains the
connection information and a room secret. **New code** invalidates the old one
and disconnects the current peers.

Open a shared character using its session control. The host gets a dedicated
session copy rather than writing multiplayer turns into the original
character's private chat. That session copy is reused on later sessions.

**Joining.** Paste the code into Multiplayer and press **Join**. If the enabled
extension sets do not match and parity checking is enabled, the panel shows a
diff. **Sync extensions** offers a plan before making changes. Review it:
reinstalling an extension can discard local modifications, and removing extras
is a separate destructive option. Reload and rejoin after syncing.

**Sending turns.** The host owns the canonical transcript and performs model
generation. A normal client send can request a reply when the host enables
**Answer when a player asks for a reply**. Guided Generations' **Simple Send**
posts a turn without requesting generation, so several players can act first.
Typing indicators and the generation-status banner show what is happening.

**Group chats.** To play a SillyTavern group, the host shares every member and
opens the group chat. If a member is not shared yet, the panel lists it and
offers **Share group members**. Players see the group in the Multiplayer panel,
and **Open group chat** creates or reuses a local copy built from their saved
copies of those characters. Only one such copy exists per host group. It is
reused across reconnects and new codes, and updated in place when the host adds,
removes or mutes a member. The host's model and the group's own activation
strategy decide who speaks. `/mp-ask Name` asks one member to answer next,
for the host and for players.

**Player chat.** The speech-bubble button opens the separate out-of-character
panel. Its messages do not enter the model's chat array or prompt through this
extension. **To RP** explicitly posts a composed message into the roleplay. The
panel remembers its position and size; **Reset its position** restores it.
The relay keeps a bounded, in-memory player-chat history, not an archival log.

**Personas and lore.** Each player keeps their own selected persona. The room
view shows the current players, portraits, descriptions, and persona lorebooks.
The host builds the player roster for the prompt and uses a session-bound World
Info book for shared lore. Lorebook activation is delegated to SillyTavern, not
a separate substring matcher. The panel reports the roster and lore state.

## Persistent sharing: what is remembered

Bookkeeping lives in SillyTavern's normal extension settings at
`extension_settings.multiplayer.sharing`. It contains a storage-schema version,
a local `ownerId`, stable `cardSources` and `personaSources`, and filename /
revision receipts in `remoteCards`, `sessionCards`, and `remotePersonas`.
It does not store the room secret or full remote character definitions.

| Situation | Behavior |
| --- | --- |
| Reconnect, reopen the page, or join another room with the same source | Find and reuse the already mapped local copy. |
| Receive the same item concurrently or repeatedly | Serialize work for that identity; verify the saved copy; do not import again. |
| Host edits a definition, name, tags, or portrait | Update the mapped filename and refresh the in-session definition. |
| Different owners use the same display name | Keep separate identities; never merge just by name. |
| Host renames a card through SillyTavern's rename event | Move its source-ID mapping to the new filename. |
| Local mapped file was deleted | Recreate the same deterministic filename after confirming it is missing. |
| Request fails, authentication fails, or disk lookup returns a server error | Report the failure; do not treat it as permission to create another file. |
| Import finishes but its response is lost | Recover the deterministic file and its marker on the next sync. |
| Host stops sharing a card or the session disconnects | Clear its received definition from memory; retain the saved stub and chats. |

The authoritative marker is `data.extensions.st_multiplayer` in the saved card.
New filenames are derived from the stable identity, not from a display name or
room code. The implementation checks the saved marker before editing and checks
the saved revision afterward. Only a definite missing-file response permits
creation. An unrelated file occupying the reserved filename is a conflict, not
a file that can be overwritten.

Content hashes cover actual definition and portrait contents, not their length.
Same-size portrait changes and deleted definition fields are therefore not
silently missed. Receipt revisions advance only after the write is verified.
Where supported, Web Locks coordinate the same item across browser tabs as well
as within the page. This is not a transactional replacement for SillyTavern's
own settings storage; simultaneous independent server sessions should still be
used cautiously.

Keep settings backed up. Resetting the host's owner/source identities makes it
look like a different source. Renaming or moving character files outside
SillyTavern does not fire its rename event and may require manual recovery.
These IDs are synchronization identifiers, not public-key proof of authorship.

### Persona handling is not the same as character-card importing

The normal `index.js` extension keeps remote personas in the room view and
prompt state. It **does not automatically create a local Persona Management
entry for every remote player**. A reconnect replaces obsolete peer-ID entries,
a departure removes them, and an updated portrait/description/lorebook replaces
that player's current data. Switching to a different persona clears stale
fields from the previous one.

The separate, legacy `mp-personas.js` integration helper is not loaded by
`index.js`. For integrations which explicitly use that helper to save remote
personas, it now reserves a deterministic avatar filename, remembers it across
reloads, and updates that same file instead of importing timestamp-named copies.
Legacy helper receipts are adopted when they can identify an existing file.
Changing a remote description or portrait no longer requires deleting and
reimporting that persona.

### What is and is not persisted

Clients automatically save a **stub** with identifying metadata, a portrait,
and the Multiplayer marker. Full host character definitions are received and
applied to in-memory character objects while the session is connected. The
extension's automatic card and portrait write paths use clean disk data rather
than serializing those hydrated objects. Disconnect restores their baselines.
A card is only enabled when it is available in the currently connected host's
catalogue, not merely because some room is connected.

This is **not DRM**. Players receive the definition and can inspect or copy it.
Manual saving, exports, browser behavior, and other extensions are outside that
automatic-write guarantee. Chat transcripts can be saved normally, and shared
persona/card lore may be written to the existing session World Info book. That
book is unbound when the session ends; this does not promise to erase every
previously saved lore file. Host-side session copies contain the host's own
character definition and are intentionally saved on the host.

## Recovering an installation that already has duplicates

Open **Shared storage / recovery**. The report shows remembered copies,
operation counts, extension-marked duplicate groups, and legacy cards without
stable owner/source IDs. It is read-only until you explicitly choose a linking
action. Its coverage is the current SillyTavern character list, not a forensic
scan of every file on disk or a deduplicator for unrelated extensions.

An exact legacy card ID in the same room can be adopted automatically. An old
room-derived ID usually cannot prove identity across a new code or room. While
connected to the correct host, choose both the currently shared character and
the **existing legacy remote copy to keep**, then confirm **Link selected
copy**. This preserves that local filename and uses it for subsequent updates.
If the room changes while the dialog is open, linking is cancelled.

Linking is limited to extension-marked remote legacy cards. It refuses an
original local character, a host session copy, or a copy already assigned to a
different stable source. Linking neither deletes the other copies nor merges
their chat histories. Review backups and histories before manually deleting
anything. Unmarked legacy personas cannot safely be matched just by name.

Use **Resync shared data** after correcting a failed write, changing a portrait
through a path that did not emit an event, or completing recovery. It republishes
the local persona and asks for the shared catalogue again. It does not erase
identity receipts. `/mp-storage` produces a read-only JSON report; `/mp-resync`
performs the same resynchronization as the button.

## Play over the internet without a VPN

The joining player connects straight to the host's relay. Nothing in between
needs an account, a VPN or a tunnel. All that is needed is a way through the
host's router.

**Who should host.** Host on home Wi-Fi or broadband. Mobile networks put phones
behind carrier-grade NAT, which no port forward can get through. The joining
player can be anywhere, including on mobile data.

1. Keep **Allow players on my local network** and **Ask my router to open the
   port automatically** ticked, then press **Start hosting**.
2. Look at the **Internet play** box under the connection code.
   - **Ready**: the router opened the port and supplied your public address.
     Send the code and you are done.
   - **Not reachable from outside yet**: if you host from a phone, type the
     router's address in **Router address** (usually `192.168.1.1` or
     `192.168.0.1`; on Android see Settings → Wi-Fi → your network → Gateway)
     and start hosting again.
   - If the router still refuses, forward **TCP** on the port (default `8899`)
     yourself, to the local address the box shows. Give that device a DHCP
     reservation so the rule keeps working. Then put your public IP, or your
     router's DDNS hostname, in **Address players connect to** and press
     **New code**.
   - **Carrier-grade NAT**: the connection itself cannot accept incoming
     connections. Host from another network, ask the ISP for a public IPv4
     address, or try IPv6 (below).
3. Send the code privately. Once everyone has joined, press **Lock room**.

**IPv6.** Where the host has a global IPv6 address, the box offers **Use IPv6**.
IPv6 has no NAT, so all that is needed is to allow the port in the router's
IPv6 firewall. The joining player's network must have IPv6 too.

**Android/Termux hosts.** Run `termux-wake-lock`, exempt Termux from battery
optimisation, and keep the SillyTavern tab open. Android stops background work
aggressively. A player's phone that sleeps mid-session reconnects by itself when
the tab is opened again.

**What protects an open port.** Only someone holding the code can complete the
handshake. The code carries a random 128-bit room key, and the key itself never
crosses the network. Traffic is encrypted with AES-256-GCM. Wrong guesses
block the guessing address. Many failures from any mix of addresses refuse
everyone new for two minutes, except the host's own browser. **Lock room**
refuses newcomers even with a correct code. **New code** invalidates the old one
and its rejoin tickets. Automatic router mappings are leased, renewed only while
hosting, and released when you stop or after 30 idle minutes (**Reopen port**
brings it back). A manual forward stays open until you remove it, so remove it,
or stop SillyTavern, when you are done playing.

## Connectivity and troubleshooting

The default relay port is `8899`. The address embedded in the code must be
reachable from the joining computer; the panel displays the actual endpoint.
**Allow players on my local network** controls non-loopback binding. The router
mapping option attempts NAT-PMP/UPnP; success depends on the network and is not
guaranteed. Failed mapping is reported without the old `kind is not defined`
exception.

For Tailscale or another private network, use the host's reachable private-network
address, allow the connection in that network and the host firewall, and permit
non-loopback listening. Do not advertise `localhost` to another computer.
For a tunnel or reverse proxy, advertise its hostname and forwarded port, and
select the HTTPS option only when that endpoint actually supports secure
WebSockets. An HTTPS browser page needs a compatible secure WebSocket endpoint;
application-level encryption does not bypass browser mixed-content rules.

| Symptom | Check |
| --- | --- |
| `kind is not defined` | Replace the old browser files and reload; the failing warning path is fixed in 1.4.0. |
| Constant join/leave or rapidly growing persona list | Update **both** relay and clients, restart the host server, and close stale tabs. The welcome echo loop and stale persona entries are fixed. Other network faults can still disconnect a peer. |
| Protocol mismatch | Reinstall the relay from the updated extension folder, restart the server, and reload all peers. |
| "The host has locked this room" | The host pressed **Lock room** before you joined. Ask them to unlock it. |
| Code works at home, not from outside | Check **Internet play** on the host. "Carrier-grade NAT" means the host network cannot accept incoming connections. Otherwise forward the port or fill in **Router address**. |
| Port mapping stopped working after a while | The relay closes an idle router port after 30 minutes. Press **Reopen port**. |
| Group chat shows "Receiving characters…" | The players' copies of some members have not arrived yet. Wait, or use **Resync shared data**. |
| Plugin HTTP 404 | Confirm the relay is installed, server plugins are enabled, startup did not report an import/dependency error, and the server was restarted. |
| Plugin HTTP 401/403 | Check the signed-in session and host account's admin permission. |
| Connection attempts never reach the host | Verify the advertised address/port, firewall, binding, private-network access, and tunnel settings. |
| An existing copy cannot be verified | Correct the access/server problem, then resync. The extension intentionally stops instead of creating a speculative duplicate. |
| A definition or portrait remains old | Save the host edit, use resync, and inspect the activity log for a refused revision, image, or write. |

Automatic reconnect respects its checkbox. Retryable failures use backoff and
jitter, with at most eight consecutive unstable retries. A connection that stays
open for a minute resets that retry budget. Fatal protocol/authentication errors
stop immediately; use Leave and Join after correcting the cause. Outgoing data
is paced so ordinary synchronization is less likely to trigger the relay's
message/byte limits. Streaming snapshots are coalesced at about four per second;
large catalogues and images can still take time to synchronize.

## Commands

| Command | Purpose |
| --- | --- |
| `/mp-host` | Start hosting and return the room code. |
| `/mp-join <code>` | Join a room. |
| `/mp-leave` | Leave the active session. |
| `/mp-sync` | Review extension parity and synchronization. |
| `/mp-status` | Report session status. |
| `/mp-ooc [message]` | Open player chat, or send a player-chat message. |
| `/mp-ask <name>` | In a shared group chat, ask that character to reply next. |
| `/mp-storage` | Return the read-only shared-storage report. |
| `/mp-resync` | Republish/request shared data without clearing receipts. |

## Security and trust

Transport uses ephemeral P-256 ECDH, a code-derived pre-shared key, HKDF-SHA256,
and AES-256-GCM with separate directional keys and counters. Browser and relay
implementations have interoperability tests, replay checks, frame-size limits,
heartbeat handling, and rate limits. The protocol constants are mirrored and
tested together. This release is **not an independent security audit**.

The relay runs on the host's machine and can access the shared session data.
Encryption is not intended to hide that data from the host or admitted players.
Protect the connection code as a credential and share only content you are
comfortable sending to those players. A host token and loopback check distinguish
host authority; clients cannot announce the host's catalogue or directly route
authorized host-only messages. A targeted reply to a departed peer is discarded
rather than accidentally broadcast to everyone.

The control routes use SillyTavern's server middleware and an additional admin
check. OOC text is rendered as text, not HTML. Bounded transfers and retry limits
reduce accidental overload; they are not a guarantee against every malicious
or incompatible peer. Browser extension trust and model-provider privacy are
separate from this transport layer.

## Development and tests

For the standalone regression runner, use Node 22 or newer. It needs Node's
native WebSocket client and WebCrypto as well as the `ws` server dependency:

```bash
npm install
npm test
npm run test:hunt
```

`npm test` runs each suite in a fresh process and fails if any suite fails or
exceeds its timeout. The recorded 1.5.0 run passed **386 checks across 17 suites**.
It includes the real relay, real transport and crypto, and storage-adapter tests
covering 100 simultaneous deliveries, 100 repeated unchanged synchronizations,
10 join/leave cycles plus an automatic retry, changed revisions, failed writes,
lost responses, owner/name collisions, and conservative legacy recovery.

The separate hunt suite reported **13 passes and zero findings**. Its runner is
an informational probe rather than the main regression gate, so inspect its
output. An offline Chromium DOM smoke test passed **59 assertions**, including
10 UI mount/destroy cycles, late template completion, card gating, and stale
recovery-dialog rejection. That test mocks SillyTavern's context; it is not a
substitute for testing the whole application.

To run the browser smoke page manually, serve the repository with a local static
server and open `tests/ui-smoke.html`. For example:

```bash
python -m http.server 9000 --bind 127.0.0.1
# Open http://127.0.0.1:9000/tests/ui-smoke.html in a browser.
```

See [TEST_REPORT.md](TEST_REPORT.md) for precise environment details, API review
references, test boundaries, and a two-instance manual acceptance checklist.

## Source layout

```text
index.js                 extension lifecycle, settings, slash commands
settings.html            settings drawer, storage/recovery and resync buttons
style.css
lib/
  identity.js            durable identities, canonical hashes, write queues
  card-store.js          verified create/reuse/update and legacy recovery
  cards.js               card shapes, ST API adapters, RAM hydration, chunks
  transport.js           handshake, socket lifecycle, backoff, encrypted sends
  send-budget.js         cancellable message/byte pacing
  session.js             host/client orchestration and ordered synchronization
  chat.js                roleplay relay and stable room persona state
  protocol.js            opcodes, revision, limits, connection codes
  crypto.js              browser WebCrypto implementation
  parity.js              extension comparison and reviewed sync plans
  lore.js                session World Info integration
  ooc.js                 separate player-chat channel and panel
  groups.js              group-chat sessions and durable client mirror groups
  typing.js              typing state
  ui.js                  settings UI, cloud-card gating, recovery dialog
mp-personas.js           optional legacy persona import helper, not live entrypoint
server/
  index.js               server plugin and authenticated control routes
  lib/protocol.js        wire constants mirrored with lib/protocol.js
  lib/crypto.js          Node crypto implementation
  lib/relay.js           room authority, routing, admission and limits
  lib/portmap.js         NAT-PMP/UPnP mapping
install.mjs              relay installer
install-windows.bat      Windows installer launcher
tests/                   regression suites, mock ST store, browser smoke page
TEST_REPORT.md           recorded validation and remaining manual checks
```

## Limits

The host remains a single point of failure; there is no host migration. One
character or one group is active at a time. In a group session, the members must
all be shared. Group settings other than name, members and muted members
(activation strategy, avatar, auto-mode) stay host-side. If SillyTavern loses
the response to a group-create request, a second mirror group can appear. The
create endpoint does not keep the marker that recovery relies on.
The handshake breaker exempts loopback connections. A tunnel or reverse proxy on
the host machine makes every player look local, so rely on its own rate limits.
Port mapping has been exercised only against protocol tests here, not real
routers. Some routers ship with UPnP disabled, and carrier-grade NAT cannot be
worked around.
Client transcripts mirror the host; branching, editing, and swipes are host-side
actions. Saved chats and session lore are separate from the character-stub cache.
The peer limit is eight, and a received catalogue is limited to 512 cards.

Git-commit parity can be slower than name/version parity. Extensions without an
installable repository URL require manual handling. Updating a pinned extension
by deleting and recloning it can lose local changes. Back up first and review the
plan. Persistent identity depends on retained settings/markers; this release
does not globally deduplicate arbitrary cards or automatically delete old data.

## Licence

AGPL-3.0, matching the repository's existing licence.
