import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md p-32 text-center">
            <h1 className="mb-16 text-2xl font-bold">Something went wrong</h1>
            <p className="mb-24 text-sm text-text-2">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button onClick={() => window.location.reload()} className="btn-primary btn">
              Reload page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
