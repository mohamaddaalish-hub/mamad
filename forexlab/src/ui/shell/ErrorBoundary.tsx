/**
 * Last-resort error surface. The product requirement is "never fail silently",
 * so anything that escapes the render tree is shown with a copyable message.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ForexLab] unhandled UI error', error, info.componentStack);
    this.setState({ info: String(info.componentStack ?? '').slice(0, 1200) });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, maxWidth: 860, margin: '40px auto', fontFamily: 'var(--font)' }}>
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>The interface hit an unexpected error</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Your imported data is untouched — it lives in this browser's local storage, not in the component that failed.
        </p>
        <pre className="notice error" style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: 11 }}>
          {this.state.error.message}
          {'\n'}
          {this.state.info}
        </pre>
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload workstation
          </button>
          <button className="btn" onClick={() => this.setState({ error: null, info: '' })}>
            Dismiss and continue
          </button>
        </div>
      </div>
    );
  }
}
