import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

// Persistent account store for the web app's own login system — the replacement for the old
// single shared ACCESS_PASSWORD gate. Users live in a small JSON file on disk (hashed
// passwords only; the IPTV provider credentials are stored encrypted per user via
// sessionStore.ts, never in plaintext). Deliberately dependency-free: scrypt from node:crypto
// covers password hashing, and atomic write-then-rename keeps the file from being truncated by
// a crash mid-save.

export type UserRole = 'admin' | 'user'

export const USER_ROLES: readonly UserRole[] = ['admin', 'user']

// Usernames double as URL path segments on the admin API, so keep them URL-safe by
// construction rather than encoding after the fact.
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/
const MIN_PASSWORD_LENGTH = 6

export interface StoredUser {
  username: string
  role: UserRole
  createdAt: string
  lastLoginAt: string | null
  password: { salt: string; hash: string }
  // Opaque encrypted blob (see sessionStore.ts) — created/decrypted above this layer.
  iptvCredentials: string | null
}

export interface PublicUser {
  username: string
  role: UserRole
  createdAt: string
  lastLoginAt: string | null
}

export interface NewUserInput {
  username: string
  password: string
  role: UserRole
}

interface UsersFile {
  version: 1
  users: StoredUser[]
}

const USERS_FILE_VERSION = 1

function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return { salt, hash }
}

function verifyPassword(password: string, stored: { salt: string; hash: string }): boolean {
  try {
    const expected = Buffer.from(stored.hash, 'hex')
    const actual = scryptSync(password, stored.salt, expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

export class UserStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserStoreError'
  }
}

export interface UsersStore {
  hasUsers(): boolean
  listUsers(): PublicUser[]
  findUser(username: string): PublicUser | null
  verifyCredentials(username: string, password: string): StoredUser | null
  createUser(input: NewUserInput): PublicUser
  deleteUser(username: string): PublicUser
  countAdmins(): number
  recordLogin(username: string): void
  getIptvCredentials(username: string): string | null
  setIptvCredentials(username: string, encrypted: string | null): void
}

export function validateUsername(username: unknown): string {
  if (typeof username !== 'string') throw new UserStoreError('Username is required')
  const trimmed = username.trim()
  if (!USERNAME_PATTERN.test(trimmed)) {
    throw new UserStoreError('Username must be 3-32 characters: letters, numbers, dots, dashes or underscores')
  }
  return trimmed
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new UserStoreError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  return password
}

export function validateRole(role: unknown): UserRole {
  if (role !== 'admin' && role !== 'user') throw new UserStoreError('Role must be "admin" or "user"')
  return role
}

export function createUsersStore({ filePath }: { filePath: string }): UsersStore {
  function load(): UsersFile {
    if (!existsSync(filePath)) return { version: USERS_FILE_VERSION, users: [] }
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as UsersFile
      if (!parsed || parsed.version !== USERS_FILE_VERSION || !Array.isArray(parsed.users)) {
        throw new Error('unexpected shape')
      }
      return parsed
    } catch (err) {
      throw new Error(`Users file at ${filePath} is corrupted; fix or remove it and restart: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function save(file: UsersFile): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(file, null, 2))
    renameSync(tempPath, filePath)
  }

  function findStored(file: UsersFile, username: string): StoredUser | undefined {
    return file.users.find((user) => user.username === username)
  }

  function toPublic(user: StoredUser): PublicUser {
    return { username: user.username, role: user.role, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt }
  }

  return {
    hasUsers(): boolean {
      return load().users.length > 0
    },

    listUsers(): PublicUser[] {
      return load()
        .users.map(toPublic)
        .sort((a, b) => a.username.localeCompare(b.username))
    },

    findUser(username: string): PublicUser | null {
      const found = findStored(load(), username)
      return found ? toPublic(found) : null
    },

    verifyCredentials(username: string, password: string): StoredUser | null {
      const user = findStored(load(), username)
      if (!user) return null
      if (!verifyPassword(password, user.password)) return null
      return user
    },

    createUser(input: NewUserInput): PublicUser {
      const username = validateUsername(input.username)
      const password = validatePassword(input.password)
      const role = validateRole(input.role)
      const file = load()
      if (findStored(file, username)) throw new UserStoreError(`User "${username}" already exists`)
      const user: StoredUser = {
        username,
        role,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
        password: hashPassword(password),
        iptvCredentials: null
      }
      file.users.push(user)
      save(file)
      return toPublic(user)
    },

    deleteUser(username: string): PublicUser {
      const file = load()
      const user = findStored(file, username)
      if (!user) throw new UserStoreError(`User "${username}" does not exist`)
      if (user.role === 'admin' && file.users.filter((entry) => entry.role === 'admin').length === 1) {
        throw new UserStoreError('Cannot delete the last remaining admin')
      }
      file.users = file.users.filter((entry) => entry.username !== username)
      save(file)
      return toPublic(user)
    },

    countAdmins(): number {
      return load().users.filter((user) => user.role === 'admin').length
    },

    recordLogin(username: string): void {
      const file = load()
      const user = findStored(file, username)
      if (!user) return
      user.lastLoginAt = new Date().toISOString()
      save(file)
    },

    getIptvCredentials(username: string): string | null {
      return findStored(load(), username)?.iptvCredentials ?? null
    },

    setIptvCredentials(username: string, encrypted: string | null): void {
      const file = load()
      const user = findStored(file, username)
      if (!user) throw new UserStoreError(`User "${username}" does not exist`)
      user.iptvCredentials = encrypted
      save(file)
    }
  }
}
