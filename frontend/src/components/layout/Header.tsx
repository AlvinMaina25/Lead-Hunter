import { Menu } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { NAV_ITEMS } from './nav';
import { useDemoData } from '../../lib/DemoDataContext';
import { Badge } from '../ui/Badge';

export function Header({ onMenuClick }: { onMenuClick: () => void }) {
  const location = useLocation();
  const { isDemoMode } = useDemoData();

  const current =
    NAV_ITEMS.find((item) => (item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to))) ??
    NAV_ITEMS[0];

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-surface-border bg-white px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          aria-label="Open navigation"
          className="flex h-8 w-8 items-center justify-center rounded text-ink-600 hover:bg-surface-muted md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-ink-600">{current.label}</span>
      </div>

      <div className="flex items-center gap-3">
        {isDemoMode && <Badge tone="info">Demo data</Badge>}
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-white"
          title="Signed in user"
        >
          AS
        </div>
      </div>
    </header>
  );
}
