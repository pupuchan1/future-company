import { useState, useSyncExternalStore } from 'react'
import { ReceptionNavigation } from './reception-navigation'

export function useReceptionScreen() {
  const [navigation] = useState(() => new ReceptionNavigation(window))
  const screen = useSyncExternalStore(navigation.subscribe, navigation.getScreen, () => 'home' as const)
  return { screen, navigate: navigation.navigate }
}
