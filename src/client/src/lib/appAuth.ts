import { XtreamClient } from './xtreamClient'

// Client side of the app's own account system: app-level username/password login (with
// admin/user roles) happens first, and only after that does the app check the per-account
// IPTV provider config (server/username/password/EPG URLs) — see IptvConfigScreen.

export type UserRole = 'admin' | 'user'

export interface AppUser {
  username: string
  role: UserRole
}

export interface AuthState {
  usersExist: boolean
  authenticated: boolean
  user: AppUser | null
  iptvConfigured: boolean
}

export interface IptvConfig {
  server: string
  username: string
  /** Only ever set by the settings form. Empty means "keep the stored one" — the client is no
   *  longer told the password once it has been saved (see fetchIptvConfig). */
  password: string
  /** Whether a password is on file for this account, so the form can say so without showing it. */
  passwordSet?: boolean
  epgUrls?: string[]
}

// The connected-IPTV session handed to the main app once both checks passed. appUser is the
// logged-in account; username/server are the IPTV provider line in use.
export interface Session {
  client: XtreamClient
  username: string
  server: string
  appUser: AppUser
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export async function fetchAuthState(): Promise<AuthState> {
  const res = await fetch('/api/auth/state')
  if (!res.ok) {
    // The server sends a readable JSON error for storage problems (unreadable users file,
    // read-only data volume) — surface that instead of a generic "unreachable" message.
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? 'Could not reach the server')
  }
  return res.json() as Promise<AuthState>
}

export async function setupAdminAccount(username: string, password: string): Promise<AppUser> {
  const data = await postJson<{ user: AppUser }>('/api/auth/setup', { username, password })
  return data.user
}

export async function login(username: string, password: string): Promise<AppUser> {
  const data = await postJson<{ user: AppUser }>('/api/auth/login', { username, password })
  return data.user
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
}

// Returns the account's saved IPTV config, or null when this account hasn't configured a
// provider yet (the client then shows the IPTV config step).
export async function fetchIptvConfig(): Promise<IptvConfig | null> {
  const res = await fetch('/api/session')
  if (!res.ok) throw new Error('Could not load the IPTV configuration')
  const data = (await res.json()) as {
    configured: boolean
    server: string | null
    username: string | null
    passwordSet?: boolean
    epgUrls?: string[]
  }
  // No password comes back any more — a stored config is identified by server + username, and
  // `passwordSet` is what the form uses to say "one is saved".
  if (!data.configured || !data.server || !data.username) return null
  return { server: data.server, username: data.username, password: '', passwordSet: data.passwordSet ?? false, epgUrls: data.epgUrls ?? [] }
}

export async function saveIptvConfig(config: IptvConfig): Promise<void> {
  await postJson('/api/session/save', config)
}

export async function clearIptvConfig(): Promise<void> {
  await fetch('/api/session/clear', { method: 'POST' })
}

// Points the server's proxy at the provider and verifies the provider credentials actually
// authenticate — the same two steps the old combined login form did, now as its own phase.
export async function connectIptv(config: IptvConfig): Promise<Session> {
  await postJson('/api/connect', { server: config.server })

  // Credential-free: the client addresses the server, which addresses the provider.
  const client = new XtreamClient()
  const auth = await client.authenticate()
  if (auth.user_info.auth !== 1) throw new Error('Invalid IPTV credentials')

  return { client, username: config.username, server: config.server, appUser: await whoAmI() }
}

async function whoAmI(): Promise<AppUser> {
  const state = await fetchAuthState()
  if (!state.authenticated || !state.user) throw new Error('Login session ended')
  return state.user
}
