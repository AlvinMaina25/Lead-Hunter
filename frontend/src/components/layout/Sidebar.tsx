import { NavLink } from 'react-router-dom';
import { Radar } from 'lucide-react';
import { NAV_ITEMS } from './nav';

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col text-ink-300">
      <div className="flex items-center gap-2 px-5 py-5">
        <Radar className="h-5 w-5 text-signal" />
        <div>
          <p className="text-sm font-semibold text-white">Alvin Lead Hunter</p>
          <p className="text-xs text-ink-300">Sales intelligence</p>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-ink-700 text-white'
                  : 'text-ink-300 hover:bg-ink-800 hover:text-white'
              }`
            }
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-ink-700 px-5 py-4">
        <p className="text-xs text-ink-300">Alvin Solutions — internal use only</p>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-60 bg-ink md:block">
      <SidebarContent />
    </aside>
  );
}
