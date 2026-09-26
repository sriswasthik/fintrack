import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  /**
   * Changing this clears a caught error — the router's location is passed in,
   * so navigating away from a broken page is enough to recover from it.
   */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches an error thrown while rendering a page.
 *
 * Without one, a single bad render — a chart handed data it did not expect —
 * unmounts the whole tree and leaves a blank white screen with no way back
 * but the address bar. With one, the nav stays up, the person is told what
 * happened, and they can try again or go elsewhere.
 *
 * A class component because React still offers no hook for this.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only log a static SPA has. Worth keeping the
    // component stack: "which card threw" is the first question.
    console.error('Render failed:', error, info.componentStack);
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main
        role="alert"
        className="mx-auto flex min-h-[60svh] max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <h1 className="text-2xl font-semibold tracking-tight">This page hit a problem</h1>
        <p className="text-muted-foreground text-sm">
          Something went wrong while showing it. Your data is safe — nothing was changed. Try again,
          or head to another page.
        </p>
        <div className="flex gap-2">
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button variant="outline" onClick={() => window.location.assign('/')}>
            Go home
          </Button>
        </div>
      </main>
    );
  }
}
