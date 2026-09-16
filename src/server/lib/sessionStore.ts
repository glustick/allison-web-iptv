import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

// Per-user IPTV provider credentials (the Xtream server/username/password configured AFTER the
// app's own username+password login) — encrypted at rest with SESSION_SECRET so the users file
// never holds provider passwords in plaintext. The old shared ACCESS_PASSWORD field and the
// browser-side multi-profile state are gone: with real accounts, each account IS the profile.

export interface SessionCredentials {
  server: string
  username: string
  password: string
  // Optional extra XMLTV guide sources (see epgService.ts) — carried with the credentials so
  // /api/epg can aggregate them alongside the provider's own guide.
  epgUrls?: string[]
  // Where to post provider-outage alerts (a Discord webhook — see lib/providerWatch.ts). Stored with
  // the credentials rather than in preferences because it is a posting credential: anyone holding it
  // can write to that channel.
  alertWebhook?: string
}

export interface EncryptedSessionPayload {
  version: 1
  payload: string
}

const SESSION_KEY_ENV = 'SESSION_SECRET'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

function getSecret(): Buffer {
  const secret = process.env[SESSION_KEY_ENV]
  if (!secret || secret.trim().length < 16) {
    throw new Error(`Missing or weak ${SESSION_KEY_ENV} environment variable; set a 16+ character secret.`)
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

export function encryptSessionCredentials(credentials: SessionCredentials): string {
  const json = JSON.stringify(credentials)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, getSecret(), iv)
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const bundle = Buffer.concat([iv, tag, ciphertext])
  return JSON.stringify({ version: 1, payload: bundle.toString('base64url') } satisfies EncryptedSessionPayload)
}

export function decryptSessionCredentials(encoded: string): SessionCredentials {
  let parsed: EncryptedSessionPayload
  try {
    parsed = JSON.parse(encoded) as EncryptedSessionPayload
  } catch {
    throw new Error('Invalid session credential payload')
  }

  if (!parsed || parsed.version !== 1 || typeof parsed.payload !== 'string') {
    throw new Error('Invalid session credential payload')
  }

  const bundle = Buffer.from(parsed.payload, 'base64url')
  if (bundle.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Session credential payload is malformed')
  }

  const iv = bundle.subarray(0, IV_LENGTH)
  const tag = bundle.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = bundle.subarray(IV_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, getSecret(), iv)
  decipher.setAuthTag(tag)

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    const credentials = JSON.parse(plaintext) as SessionCredentials
    if (!credentials || typeof credentials.server !== 'string' || typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
      throw new Error('Session credential payload is malformed')
    }
    if (credentials.epgUrls !== undefined && (!Array.isArray(credentials.epgUrls) || credentials.epgUrls.some((url) => typeof url !== 'string'))) {
      throw new Error('Session credential payload is malformed')
    }
    return credentials
  } catch {
    throw new Error('Session credential payload is corrupted or signed with a different secret')
  }
}
