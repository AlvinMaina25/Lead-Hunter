import { X } from 'lucide-react';
import { SidebarContent } from './Sidebar';

export function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <div
        className="absolute inset-0 animate-overlay-in bg-ink/50 motion-reduce:animate-none"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute inset-y-0 left-0 w-64 origin-left animate-panel-in bg-ink shadow-xl motion-reduce:animate-none">
        <button
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded text-ink-300 hover:bg-ink-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
        <SidebarContent onNavigate={onClose} />
      </div>
    </div>
  );
}
