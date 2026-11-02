import {
  LayoutDashboard,
  Users,
  Building2,
  SearchIcon,
  BarChart3,
  Settings as SettingsIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: typeof LayoutDashboard;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  { label: 'Leads', to: '/leads', icon: Users },
  { label: 'Businesses', to: '/businesses', icon: Building2 },
  { label: 'Searches', to: '/searches', icon: SearchIcon },
  { label: 'Analytics', to: '/analytics', icon: BarChart3 },
  { label: 'Settings', to: '/settings', icon: SettingsIcon },
];
