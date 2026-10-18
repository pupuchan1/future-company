export type ReceptionScreen = 'home' | 'conversation'

export interface ReceptionHistory {
  location: { pathname: string }
  history: { pushState(data: unknown, unused: string, url: string): void }
  addEventListener(type: 'popstate', listener: () => void): void
  removeEventListener(type: 'popstate', listener: () => void): void
}

/** Changes the screen without reloading the document that owns the voice session. */
export class ReceptionNavigation {
  private browser: ReceptionHistory

  constructor(browser: ReceptionHistory) { this.browser = browser }

  getScreen = (): ReceptionScreen =>
    this.browser.location.pathname.replace(/\/$/, '') === '/conversation' ? 'conversation' : 'home'

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    this.browser.addEventListener('popstate', listener)
    return () => {
      this.listeners.delete(listener)
      this.browser.removeEventListener('popstate', listener)
    }
  }

  private listeners = new Set<() => void>()

  navigate = (screen: ReceptionScreen) => {
    if (this.getScreen() === screen) return
    this.browser.history.pushState(null, '', screen === 'conversation' ? '/conversation' : '/')
    this.listeners.forEach(listener => listener())
  }
}
