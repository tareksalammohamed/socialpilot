import { Component, type ReactNode } from 'react';
import { Button } from './ui';

/** A failed render or lazy chunk must leave a usable recovery action. */
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return (
      <div role="alert" className="min-h-[50vh] flex flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-ink-100">تعذّر فتح الصفحة. أعد تحميل التطبيق للمحاولة مجددًا.</p>
        <Button onClick={() => window.location.reload()}>إعادة تحميل التطبيق</Button>
      </div>
    );
    return this.props.children;
  }
}
