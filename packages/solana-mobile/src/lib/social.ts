import { useSyncExternalStore } from 'react'
import { RELAYER_URL } from './config'
import type { PlayerProfile, PublicDrawing, SocialActivity, SocialMessage } from '@skech/core/social'

function serviceUrl() {
  if (process.env.EXPO_PUBLIC_SOCIAL_URL) return process.env.EXPO_PUBLIC_SOCIAL_URL.replace(/\/$/, '')
  const url = new URL(RELAYER_URL)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  if (['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname)) {
    url.port = '3106'
    url.pathname = ''
  } else url.pathname = '/social-solana'
  url.search = ''
  return url.toString().replace(/\/$/, '')
}
export const SOCIAL_URL = serviceUrl()
export const avatarUrl = (profile: PlayerProfile) =>
  profile.avatar ? `${SOCIAL_URL}/avatar?player=${encodeURIComponent(profile.player)}` : undefined

export async function socialRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${SOCIAL_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Could not load this right now')
  return result as T
}
export async function socialAction<T>(
  player: string,
  action: 'profile' | 'follow',
  payload: unknown,
  sign: (message: string) => Promise<string | null>,
) {
  const challenge = await socialRequest<{ nonce: string; message: string }>('/challenge', { player, action, payload })
  const signature = await sign(challenge.message)
  if (!signature) throw new Error('The signature was cancelled')
  return socialRequest<T>(`/${action}`, { nonce: challenge.nonce, signature })
}

export type SocialState = {
  connected: boolean
  counting: boolean
  progress: number
  drawings: PublicDrawing[]
  activity: SocialActivity[]
  profiles: Record<string, PlayerProfile>
}
const EMPTY: SocialState = { connected: false, counting: false, progress: 0, drawings: [], activity: [], profiles: {} }
let current = EMPTY
const listeners = new Set<() => void>()
const eventListeners = new Set<(activity: SocialActivity) => void>()
function publish(next: SocialState) {
  const keys = Object.keys(next.profiles)
  if (keys.length > 500) {
    const keep = new Set([...keys.slice(-400), ...next.drawings.map((d) => d.player), ...(viewer ? [viewer] : [])])
    next.profiles = Object.fromEntries(Object.entries(next.profiles).filter(([key]) => keep.has(key)))
  }
  current = next
  for (const listener of listeners) listener()
}
export function cacheProfile(profile: PlayerProfile) {
  publish({ ...current, profiles: { ...current.profiles, [profile.player]: profile } })
}
export const socialSnapshot = () => current
export const onSocialActivity = (listener: (activity: SocialActivity) => void) => {
  eventListeners.add(listener)
  return () => {
    eventListeners.delete(listener)
  }
}
export const useSocial = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    socialSnapshot,
    () => EMPTY,
  )

/** One bounded stream for the page; the canvas reads snapshots without subscribing React. */
export function connectSocial() {
  let stopped = false,
    socket: WebSocket | null = null,
    retry: ReturnType<typeof setTimeout> | null = null,
    backoff = 500
  const connect = () => {
    if (stopped) return
    const url = new URL(`${SOCIAL_URL}/ws`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    socket = ws
    ws.onopen = () => {
      backoff = 500
      publish({ ...current, connected: true })
    }
    ws.onmessage = (event) => {
      let message: SocialMessage
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === 'snapshot') {
        const profiles = { ...current.profiles }
        for (const d of message.drawings) profiles[d.player] = d.profile
        publish({
          ...current,
          drawings: message.drawings.slice(0, 80),
          activity: message.activity.slice(0, 60),
          profiles,
          counting: message.counting,
          progress: message.progress,
        })
      } else if (message.type === 'drawing') {
        const d = message.drawing
        const drawings = [
          d,
          ...current.drawings.filter((x) => x.id !== d.id && x.updatedAt > Date.now() - 120_000),
        ].slice(0, 80)
        const activity = message.activity
          ? [message.activity, ...current.activity.filter((x) => x.id !== message.activity!.id)].slice(0, 60)
          : current.activity
        publish({ ...current, drawings, activity, profiles: { ...current.profiles, [d.player]: d.profile } })
        if (message.activity) for (const listener of eventListeners) listener(message.activity)
      } else if (message.type === 'profile') {
        publish({
          ...current,
          profiles: { ...current.profiles, [message.profile.player]: message.profile },
          drawings: current.drawings.map((d) =>
            d.player === message.profile.player ? { ...d, profile: message.profile } : d,
          ),
        })
      } else if (message.type === 'status')
        publish({ ...current, counting: message.counting, progress: message.progress })
    }
    ws.onclose = () => {
      if (socket !== ws || stopped) return
      publish({ ...current, connected: false })
      retry = setTimeout(connect, backoff)
      backoff = Math.min(15_000, backoff * 2)
    }
    ws.onerror = () => ws.close()
  }
  connect()
  return () => {
    stopped = true
    if (retry) clearTimeout(retry)
    socket?.close()
    publish({ ...current, connected: false })
  }
}

export type DrawingAudience = 'everyone' | 'following' | 'me'
let audience: DrawingAudience = 'everyone'
let viewer: string | null = null
let following = new Set<string>()
export function setSocialViewer(player: string | null, targets: string[]) {
  viewer = player ?? null
  following = new Set(targets)
}
export function setDrawingAudience(value: DrawingAudience) {
  audience = value
}
export function remoteDrawings() {
  if (audience === 'me' || !current.connected) return []
  return current.drawings.filter(
    (d) =>
      d.player !== viewer && d.updatedAt > Date.now() - 120_000 && (audience === 'everyone' || following.has(d.player)),
  )
}
export function visibleSocialDrawings() {
  if (!current.connected) return []
  return current.drawings.filter(
    (d) =>
      d.updatedAt > Date.now() - 120_000 &&
      (d.player === viewer || (audience !== 'me' && (audience === 'everyone' || following.has(d.player)))),
  )
}

/** No floating-point arithmetic before formatting. */
export function socialMoney(value: string, signed = false): string {
  const amount = BigInt(value),
    abs = amount < 0n ? -amount : amount
  const rounded = (abs + 5000n) / 10_000n
  const dollars = rounded / 100n,
    cents = (rounded % 100n).toString().padStart(2, '0')
  return `${amount < 0n ? '−' : signed && amount > 0n ? '+' : ''}$${dollars.toLocaleString('en-US')}${cents === '00' ? '' : `.${cents}`}`
}

let profileOpener: ((player: string) => void) | null = null
export function setProfileOpener(open: ((player: string) => void) | null) {
  profileOpener = open
}
export function openPlayerProfile(player: string) {
  profileOpener?.(player)
}
