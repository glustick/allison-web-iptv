/**
 * Playlists: more than one Xtream profile per account, for redundancy.
 *
 * Requested by the operator 2026-09-23: *"one provider can be unstable — I would like to configure two
 * Xtream profiles or playlists for redundancy, show them both in the channel selection, but give an
 * option to sort or hide a playlist to avoid having 1000s of channels."*
 *
 * This module is phase 1: the **model and the migration**, with no behaviour change. Everything the app
 * does today keeps working off the account's first playlist, and the stored blob is only rewritten
 * once something actually edits the list. That is deliberate — the threading of a playlist dimension
 * through favourites, history, resume points, the search index, EPG matching and the relay's own
 * segment URLs is the hard, risky part, and it should not be entangled with the migration.
 *
 * Two things worth knowing about the shape it migrates from:
 *
 * 1. The stored object is **not only provider credentials**. `SessionCredentials` also carries
 *    account-level settings (`epgUrls`, `alertWebhook`, and whatever gets added next). So the envelope
 *    spreads the legacy object and replaces only the three provider fields — anything unrecognised is
 *    preserved verbatim, which is what makes a future field survive a round trip through an older
 *    build.
 * 2. Channel ids are **provider-scoped**: two profiles will renumber the same channel differently, and
 *    they will reuse each other's ids for different channels. That is why a playlist needs a stable id
 *    of its own, and why nothing in this phase lets a caller address a channel without saying which
 *    playlist it means.
 */

/** One Xtream profile, with the identity and label a playlist needs to be addressable and shown. */
export interface Playlist {
  /** Stable, unique within the account, and never derived from the provider — see the note above. */
  id: string
  /** What the operator sees in the channel list ("Main", "Backup line"). */
  label: string
  server: string
  username: string
  password: string
}

/** The stored blob, versioned so a later shape can be recognised rather than guessed at. */
export interface PlaylistsEnvelope {
  version: 1
  playlists: Playlist[]
}

/** The legacy single-profile fields, as `SessionCredentials` carries them. */
interface LegacyCredentials {
  server?: unknown
  username?: unknown
  password?: unknown
  [key: string]: unknown
}

export interface ParsedPlaylists {
  /** Everything the account stores, with `playlists` filling the provider role. */
  envelope: PlaylistsEnvelope
  /** The account-level fields from a legacy blob, preserved so writing back loses nothing. */
  carried: Record<string, unknown>
  /** True when this came from a single-profile blob and would be written back in the new shape. */
  migrated: boolean
}

const PROVIDER_FIELDS = ['server', 'username', 'password'] as const

/** The id a migrated single profile gets — stable, and obviously the original one. */
export const MIGRATED_PLAYLIST_ID = 'primary'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Reads a stored blob as a playlist list, migrating the legacy single-profile shape on the way.
 *
 * Pure and total: anything unreadable becomes "no playlists" rather than an exception, because this
 * runs on the path that decides whether an account can play anything at all.
 */
export function parsePlaylists(raw: unknown): ParsedPlaylists {
  const empty: ParsedPlaylists = {
    envelope: { version: 1, playlists: [] },
    carried: {},
    migrated: false
  }

  if (raw === null || raw === undefined) return empty

  let blob: Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
      blob = parsed as Record<string, unknown>
    } catch {
      return empty
    }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    blob = raw as Record<string, unknown>
  } else {
    return empty
  }

  // Already the new shape: keep it, and trust nothing about its contents beyond the fields it needs.
  if (Array.isArray(blob.playlists)) {
    const playlists: Playlist[] = []
    for (const entry of blob.playlists) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      if (!isNonEmptyString(item.id) || !isNonEmptyString(item.server)) continue
      playlists.push({
        id: item.id,
        label: isNonEmptyString(item.label) ? item.label : item.id,
        server: item.server,
        username: isNonEmptyString(item.username) ? item.username : '',
        password: isNonEmptyString(item.password) ? item.password : ''
      })
    }
    const carried = { ...blob }
    delete carried.playlists
    delete carried.version
    // Provider fields live in the list, never loose on the account as well: two copies of the same
    // truth is how they end up disagreeing.
    for (const field of PROVIDER_FIELDS) delete carried[field]
    return { envelope: { version: 1, playlists }, carried, migrated: false }
  }

  // The legacy single-profile shape: one profile, carried across as one playlist.
  const legacy = blob as LegacyCredentials
  const carried = { ...blob }
  for (const field of PROVIDER_FIELDS) delete carried[field]

  const hasProfile = isNonEmptyString(legacy.server) && isNonEmptyString(legacy.username)
  if (!hasProfile) {
    return { envelope: { version: 1, playlists: [] }, carried, migrated: Object.keys(carried).length > 0 }
  }

  return {
    envelope: {
      version: 1,
      playlists: [
        {
          id: MIGRATED_PLAYLIST_ID,
          label: 'Primary',
          server: legacy.server as string,
          username: legacy.username as string,
          password: isNonEmptyString(legacy.password) ? legacy.password : ''
        }
      ]
    },
    carried,
    migrated: true
  }
}

/**
 * The object to store: the account's own fields, plus the playlist list under `playlists`.
 *
 * The inverse of the migration, so a legacy blob that is read and written back in the new shape loses
 * nothing.
 */
export function serializePlaylists(parsed: ParsedPlaylists): Record<string, unknown> {
  // The primary playlist's provider fields are written at the top level *as well as* in the list.
  // That is not redundancy for its own sake: `decryptSessionCredentials` refuses any payload without
  // `server`, `username` and `password`, so an envelope that replaced them outright produced a blob the
  // app could no longer read — found live on 2026-09-23, and exactly the kind of delayed breakage a
  // storage-format change invites. Writing them alongside keeps the strict reader happy while the list
  // stays the source of truth.
  const derived = primaryCredentials(parsed)
  return {
    ...(derived ?? parsed.carried),
    version: parsed.envelope.version,
    playlists: parsed.envelope.playlists
  }
}

/**
 * Which playlist an unqualified request means.
 *
 * The operator's own ordering is the answer — first listed wins — because the alternative (a "primary"
 * flag) adds a way for the list and the flag to disagree. Phase 1 keeps the app on exactly this
 * playlist, so the behaviour of an existing account is unchanged after migration.
 */
export function primaryPlaylist(playlists: Playlist[]): Playlist | null {
  return playlists.length > 0 ? playlists[0] : null
}

/** A free id for a new playlist: `p1`, `p2`, … — readable in logs, and never reused. */
export function nextPlaylistId(playlists: Playlist[]): string {
  const used = new Set(playlists.map((playlist) => playlist.id))
  for (let n = playlists.length + 1; n < playlists.length + 1000; n += 1) {
    const candidate = `p${n}`
    if (!used.has(candidate)) return candidate
  }
  return `p${Date.now()}`
}

/**
 * Identity for a channel across playlists — the key the dedupe phase will match on.
 *
 * Deliberately *not* the stream id: ids are provider-scoped, so two profiles use different ids for the
 * same channel and the same id for different ones. Normalised name plus category is what a human would
 * match on, and the schema already denormalises both for exactly this kind of robustness.
 */
export function channelMatchKey(channel: { name: string; category?: string | null }): string {
  const normalise = (value: string): string =>
    value
      .toLowerCase()
      // Providers prefix the same channel differently on different lines ("UK: Sky Sports Main
      // Event" on one, "Sky Sports Main Event" on another), so a leading region tag is provider
      // furniture rather than part of the name — the first test written for this caught exactly
      // that. It is a match *heuristic*: a wrong match groups two rows under one heading, which the
      // operator can still see both of, and a missed match merely leaves two rows.
      .replace(/^[a-z]{2,4}\s*:\s*/, '')
      .replace(/\b(uhd|fhd|hd|sd)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  return `${normalise(channel.name)}|${normalise(channel.category ?? '')}`
}

/**
 * The provider fields an unqualified request should use: the primary playlist's credentials, plus the
 * account's own carried fields.
 *
 * This is what lets every existing caller keep working untouched. For an account still stored in the
 * legacy single-profile shape, the result is **field-for-field identical to the object those callers
 * read before** — the migration is invisible until something edits the list, which is the property that
 * makes it safe to put on the credential path.
 *
 * Null when there is no playlist to derive from, so the caller can fall back to whatever it did before
 * rather than treat an empty list as "no provider configured".
 *
 * **Writers, beware:** this returns a *derived* view. Writing it back through the legacy shape drops
 * every playlist but the primary. Anything that saves credentials must merge into the envelope (see the
 * note in the roadmap); with one playlist today that is harmless, and it is the first thing to fix when
 * the playlist UI lands.
 */
export function primaryCredentials(parsed: ParsedPlaylists): Record<string, unknown> | null {
  const primary = primaryPlaylist(parsed.envelope.playlists)
  if (!primary) return null
  return {
    ...parsed.carried,
    server: primary.server,
    username: primary.username,
    password: primary.password
  }
}

/**
 * Applies a settings change to a stored account without touching the playlist list.
 *
 * This is the answer to the hazard the read-side rewiring exposed: every writer used to read a
 * credentials object, spread its one field over it, and save the result. That object is now a *derived*
 * view of the primary playlist, so saving it back would drop the other playlists. Routing writes
 * through here instead means:
 *
 * - **account-level fields** (guide URLs, alert webhook, anything added later) merge into the fields the
 *   account carries, untouched by playlists;
 * - **provider fields** (`server`, `username`, `password`) apply to the primary playlist — and create
 *   one, labelled "Primary", when the account has none yet, which is exactly the first-time setup case.
 *
 * Pure, so the rule that matters — saving your Discord webhook cannot delete your second playlist — is
 * tested rather than hoped for.
 */
export function applyCredentialPatch(parsed: ParsedPlaylists, patch: Record<string, unknown>): ParsedPlaylists {
  const carried = { ...parsed.carried }
  const providerPatch: Partial<Playlist> = {}

  for (const [key, value] of Object.entries(patch)) {
    if ((PROVIDER_FIELDS as readonly string[]).includes(key)) {
      ;(providerPatch as Record<string, unknown>)[key] = value
    } else {
      carried[key] = value
    }
  }

  const playlists = parsed.envelope.playlists.map((playlist) => ({ ...playlist }))
  if (Object.keys(providerPatch).length > 0) {
    if (playlists.length === 0) {
      playlists.push({
        id: MIGRATED_PLAYLIST_ID,
        label: 'Primary',
        server: '',
        username: '',
        password: '',
        ...providerPatch
      })
    } else {
      playlists[0] = { ...playlists[0], ...providerPatch }
    }
  }

  return { envelope: { version: 1, playlists }, carried, migrated: parsed.migrated }
}

/**
 * Replaces the playlist list, keeping the account's carried fields.
 *
 * The write side of the playlist UI. Entries are normalised rather than rejected wholesale: a blank
 * label falls back to the id, a missing password becomes an empty one (the settings screen sends blank
 * to mean "keep what is stored", and the caller resolves that before it gets here), and ids are made
 * unique so two entries cannot address the same channels by accident.
 */
export function replacePlaylists(parsed: ParsedPlaylists, playlists: Playlist[]): ParsedPlaylists {
  const seen = new Set<string>()
  const cleaned: Playlist[] = []
  for (const entry of playlists) {
    const id = entry.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    cleaned.push({
      id,
      label: entry.label.trim() || id,
      server: entry.server.trim(),
      username: entry.username.trim(),
      password: entry.password
    })
  }
  return { envelope: { version: 1, playlists: cleaned }, carried: { ...parsed.carried }, migrated: false }
}

/** The stored password for a playlist, for a settings screen that sends blank to mean "keep". */
export function storedPassword(parsed: ParsedPlaylists, id: string): string {
  return parsed.envelope.playlists.find((playlist) => playlist.id === id)?.password ?? ''
}
