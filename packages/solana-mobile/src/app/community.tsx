import { useLocalSearchParams, useRouter } from 'expo-router'
import { SocialSheet } from '@/components/app/sheets/social-sheet'
/** Shared profile/drawing links open the same native community sheet. */
export default function CommunityLink() {
  const { player, drawing } = useLocalSearchParams<{ player?: string; drawing?: string }>()
  const router = useRouter()
  return (
    <SocialSheet
      open
      initialPlayer={player}
      initialDrawing={drawing}
      onClose={() => (router.canGoBack() ? router.back() : router.replace('/'))}
    />
  )
}
