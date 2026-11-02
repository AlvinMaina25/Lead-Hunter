import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface DemoDataContextValue {
  isDemoMode: boolean;
  setDemoMode: (value: boolean) => void;
}

const DemoDataContext = createContext<DemoDataContextValue | undefined>(undefined);

const STORAGE_KEY = 'alh_demo_mode';

function readInitialValue(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function DemoDataProvider({ children }: { children: ReactNode }) {
  const [isDemoMode, setIsDemoMode] = useState<boolean>(readInitialValue);

  const setDemoMode = (value: boolean) => {
    setIsDemoMode(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // localStorage unavailable — demo mode still works for this session
    }
  };

  const value = useMemo(() => ({ isDemoMode, setDemoMode }), [isDemoMode]);

  return <DemoDataContext.Provider value={value}>{children}</DemoDataContext.Provider>;
}

export function useDemoData() {
  const ctx = useContext(DemoDataContext);
  if (!ctx) throw new Error('useDemoData must be used within a DemoDataProvider');
  return ctx;
}
