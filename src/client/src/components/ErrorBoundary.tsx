import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

// A real, uncaught TypeError (see xtreamClient.ts's own getShortEpg fix) crashed the whole app
// to a blank white page during this project's own testing, with nothing in the UI to say why —
// only the browser console showed anything. React only unmounts the entire tree on an uncaught
// render error if nothing catches it; a class component is still the only way to do that (no
// hook equivalent exists yet). This doesn't fix the underlying bug class, just makes the next
// one visible and recoverable instead of a silent blank page.
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] uncaught render error:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="login-screen">
          <div className="login-card">
            <h1>Something went wrong</h1>
            <div className="login-error">{this.state.error.message}</div>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
