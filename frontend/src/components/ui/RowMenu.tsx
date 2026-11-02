import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MoreHorizontal } from 'lucide-react';

export interface RowMenuItem {
  key: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
}

interface RowMenuProps {
  items: RowMenuItem[];
  /** An action started from this menu is still running; shown as a spinner on the trigger. */
  busy?: boolean;
  /** Message for a failed action; shown as a dot on the trigger and in its tooltip. */
  alert?: string;
  label?: string;
}

const MENU_WIDTH = 176;
const ITEM_HEIGHT = 34;
const GAP = 4;
const EDGE = 8;

/**
 * Overflow ("more actions") menu for table rows.
 *
 * The menu is portalled to <body> and positioned with `fixed`, because table
 * cells live inside a scroll container whose `overflow` would otherwise clip it
 * on the last rows. Closes on outside click, Escape, scroll and resize --
 * simpler and safer than trying to track a trigger that moved.
 */
export function RowMenu({ items, busy = false, alert, label = 'More actions' }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string }>({ top: 0, left: 0, origin: 'top right' });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  function toggle() {
    if (open) return close(false);
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = items.length * ITEM_HEIGHT + 8;
    const opensUp = rect.bottom + GAP + height > window.innerHeight - EDGE && rect.top - GAP - height > EDGE;
    setPos({
      top: opensUp ? rect.top - GAP - height : rect.bottom + GAP,
      left: Math.max(EDGE, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - EDGE)),
      origin: opensUp ? 'bottom right' : 'top right',
    });
    setOpen(true);
  }

  // Move focus into the menu when it opens.
  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close(false);
    };
    const onResize = () => close(false);
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const enabled = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      enabled[(index + 1) % enabled.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      enabled[(index - 1 + enabled.length) % enabled.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      enabled[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      enabled[enabled.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={alert ?? label}
        className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-surface-border bg-white text-ink-600 transition-colors hover:bg-surface-muted aria-expanded:bg-surface-muted"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
        {alert && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger ring-2 ring-white" />}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH, transformOrigin: pos.origin }}
            className="z-50 animate-panel-in rounded border border-surface-border bg-white py-1 shadow-lg motion-reduce:animate-none"
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
                style={{ height: ITEM_HEIGHT }}
                className="flex w-full items-center gap-2 px-3 text-left text-sm text-ink hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed disabled:text-ink-400 disabled:hover:bg-transparent"
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
