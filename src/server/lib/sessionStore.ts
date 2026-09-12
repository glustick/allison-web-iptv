import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

export interface SessionCredentials {
  accessPassword: string
  server: string
  username: string
  password: string
  // Optional extra XMLTV guide sources (see epgService.ts) — carried with the session so
  // /api/epg can aggregate them alongside the provider's own guide.
  epgUrls?: string[]
}

export interface EncryptedSessionPayload {
  version: 1
  payload: string
}

export interface SessionProfileEntry {
  id: string
  name: string
  credentials: SessionCredentials
  epgUrls?: string[]
}

export interface SessionProfileState {
  activeProfileId: string | null
  profiles: SessionProfileEntry[]
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
    if (!credentials || typeof credentials.server !== 'string' || typeof credentials.username !== 'string' || typeof credentials.password !== 'string' || typeof credentials.accessPassword !== 'string') {
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

function decryptEncryptedSessionPayload(encoded: string): unknown {
  let parsed: EncryptedSessionPayload
  try {
    parsed = JSON.parse(encoded) as EncryptedSessionPayload
  } catch {
    throw new Error('Invalid encrypted payload')
  }

  if (!parsed || parsed.version !== 1 || typeof parsed.payload !== 'string') {
    throw new Error('Invalid encrypted payload')
  }

  const bundle = Buffer.from(parsed.payload, 'base64url')
  if (bundle.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted payload is malformed')
  }

  const iv = bundle.subarray(0, IV_LENGTH)
  const tag = bundle.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = bundle.subarray(IV_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, getSecret(), iv)
  decipher.setAuthTag(tag)

  try {
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
  } catch {
    throw new Error('Encrypted payload is corrupted or signed with a different secret')
  }
}

export function encryptSessionProfileState(state: SessionProfileState): string {
  const json = JSON.stringify(state)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, getSecret(), iv)
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const bundle = Buffer.concat([iv, tag, ciphertext])
  return JSON.stringify({ version: 1, payload: bundle.toString('base64url') } satisfies EncryptedSessionPayload)
}

export function decryptSessionProfileState(encoded: string): SessionProfileState {
  const value = decryptEncryptedSessionPayload(encoded) as SessionProfileState
  if (!value || !Array.isArray(value.profiles) || !(typeof value.activeProfileId === 'string' || value.activeProfileId === null)) {
    throw new Error('Session profile payload is malformed')
  }

  const profiles = value.profiles.map((profile) => {
    if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string' || !profile.credentials || typeof profile.credentials.accessPassword !== 'string' || typeof profile.credentials.server !== 'string' || typeof profile.credentials.username !== 'string' || typeof profile.credentials.password !== 'string') {
      throw new Error('Session profile payload is malformed')
    }
    if (profile.epgUrls !== undefined && !Array.isArray(profile.epgUrls)) {
      throw new Error('Session profile payload is malformed')
    }
    return profile as SessionProfileEntry
  })

  return { activeProfileId: value.activeProfileId, profiles }
}
