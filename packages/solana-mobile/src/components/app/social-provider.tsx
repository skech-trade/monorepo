import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { AppState, Pressable, Text, View } from 'react-native'
import {
  cacheProfile,
  connectSocial,
  onSocialActivity,
  type DrawingAudience,
  setDrawingAudience,
  setProfileOpener,
  setSocialViewer,
  socialRequest,
} from '@/lib/social'
import { playerName, type PlayerProfile, type SocialActivity } from '@skech/core/social'
import { readJson, writeJson } from '@/lib/storage'
import { useAccount } from './auth'
import { SocialSheet } from './sheets/social-sheet'

type Community = {
  open: (player?: string, drawing?: string) => void
  audience: DrawingAudience
  changeAudience: (value: DrawingAudience) => void
  refreshFollowing: () => void
}
const Context = createContext<Community | null>(null)
export const useCommunity = () => useContext(Context)
export function SocialProvider({ children }: { children: ReactNode }) {
  const me = useAccount()
  const followed = useRef(new Set<string>())
  const notified = useRef(new Set<string>())
  const [alert, setAlert] = useState<SocialActivity | null>(null)
  const [selection, setSelection] = useState<{ player?: string; drawing?: string } | null>(null)
  const [audience, setAudience] = useState<DrawingAudience>(
    () => readJson<DrawingAudience>('social:audience') ?? 'everyone',
  )
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let stop = AppState.currentState === 'active' ? connectSocial() : null
    const subscription = AppState.addEventListener('change', (state) => {
      stop?.()
      stop = state === 'active' ? connectSocial() : null
    })
    return () => {
      subscription.remove()
      stop?.()
    }
  }, [])
  useEffect(() => {
    setProfileOpener((player) => setSelection({ player }))
    return () => setProfileOpener(null)
  }, [])
  useEffect(() => {
    setDrawingAudience(audience)
    writeJson('social:audience', audience)
  }, [audience])
  useEffect(() => {
    const controller = new AbortController()
    setSocialViewer(me.address, [])
    followed.current.clear()
    if (me.address)
      void socialRequest<{ profile: PlayerProfile }>(
        `/identity?player=${me.address}`,
        undefined,
        controller.signal,
      ).then(
        (result) => {
          if (!controller.signal.aborted) cacheProfile(result.profile)
        },
        () => undefined,
      )
    if (me.address)
      void socialRequest<{ players: string[] }>(`/following?player=${me.address}`, undefined, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) {
            setSocialViewer(me.address, result.players)
            followed.current = new Set(result.players)
          }
        },
        () => undefined,
      )
    return () => controller.abort()
  }, [me.address, revision])
  useEffect(
    () =>
      onSocialActivity((item) => {
        if (
          AppState.currentState !== 'active' ||
          item.kind !== 'settled' ||
          !item.complete ||
          !followed.current.has(item.player) ||
          readJson<boolean>('social:alerts') === false ||
          notified.current.has(item.drawing)
        )
          return
        notified.current.add(item.drawing)
        if (notified.current.size > 500) notified.current.delete(notified.current.values().next().value!)
        setAlert(item)
      }),
    [],
  )
  useEffect(() => {
    if (!alert) return
    const timer = setTimeout(() => setAlert(null), 4000)
    return () => clearTimeout(timer)
  }, [alert])
  return (
    <Context.Provider
      value={{
        open: (player, drawing) => setSelection({ player, drawing }),
        audience,
        changeAudience: setAudience,
        refreshFollowing: () => setRevision((value) => value + 1),
      }}
    >
      {children}
      {alert && !selection ? (
        <View pointerEvents="box-none" className="absolute inset-x-4 z-40 items-center" style={{ bottom: 112 }}>
          <Pressable
            className="min-h-11 w-full max-w-[360px] rounded-[18px] border border-border bg-popover px-4 py-3"
            accessibilityRole="button"
            onPress={() => {
              setSelection({ drawing: alert.drawing })
              setAlert(null)
            }}
          >
            <Text className="text-sm text-foreground">{playerName(alert.profile)} finished a drawing</Text>
            <Text className="text-xs text-muted-foreground">Tap to see their result</Text>
          </Pressable>
        </View>
      ) : null}
      {selection ? (
        <SocialSheet
          open
          initialPlayer={selection.player}
          initialDrawing={selection.drawing}
          onClose={() => setSelection(null)}
        />
      ) : null}
    </Context.Provider>
  )
}
