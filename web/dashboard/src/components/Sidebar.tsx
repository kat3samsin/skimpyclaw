import '../styles/sidebar.css';
import type { IconType } from 'react-icons';
import {
  LuBadgeCheck,
  LuBookOpen,
  LuChevronLeft,
  LuClock3,
  LuCode,
  LuCpu,
  LuDatabase,
  LuDollarSign,
  LuFileText,
  LuHeartPulse,
  LuLayoutDashboard,
  LuLogs,
  LuMessageSquare,
  LuNewspaper,
  LuSearch,
  LuSettings2,
  LuUserCog,
  LuZap,
} from 'react-icons/lu';

export type PageId =
  | 'overview'
  | 'history'
  | 'cron'
  | 'memory'
  | 'model'
  | 'agents'
  | 'coding'
  | 'logs'
  | 'audit'
  | 'digests'
  | 'skills'
  | 'approvals'
  | 'health'
  | 'usage'
  | 'config'
  | 'templates';

interface NavItem {
  id: PageId;
  label: string;
  icon: IconType;
  section: 'dashboard' | 'settings' | 'footer';
  badge?: number;
}

interface ExternalNavItem {
  id: string;
  label: string;
  icon: IconType;
  section: 'dashboard' | 'settings' | 'footer';
  href: string;
}

type AnyNavItem = NavItem | ExternalNavItem;

function isExternal(item: AnyNavItem): item is ExternalNavItem {
  return 'href' in item;
}

const NAV_ITEMS: AnyNavItem[] = [
  { id: 'overview', label: 'Overview', icon: LuLayoutDashboard, section: 'dashboard' },
  { id: 'history', label: 'Messages', icon: LuMessageSquare, section: 'dashboard' },
  { id: 'approvals', label: 'Approvals', icon: LuBadgeCheck, section: 'dashboard' },
  { id: 'digests', label: 'Digests', icon: LuNewspaper, section: 'dashboard' },
  { id: 'newspaper', label: 'Newspaper', icon: LuBookOpen, section: 'dashboard', href: '/newspaper' },
  { id: 'audit', label: 'Audit', icon: LuSearch, section: 'dashboard' },
  { id: 'usage', label: 'Usage', icon: LuDollarSign, section: 'dashboard' },
  { id: 'coding', label: 'Coding Agent', icon: LuCode, section: 'dashboard' },
  { id: 'memory', label: 'Memory', icon: LuDatabase, section: 'settings' },
  { id: 'templates', label: 'Templates', icon: LuFileText, section: 'settings' },
  { id: 'model', label: 'Model', icon: LuCpu, section: 'settings' },
  { id: 'agents', label: 'Agents', icon: LuUserCog, section: 'settings' },
  { id: 'skills', label: 'Skills', icon: LuZap, section: 'settings' },
  { id: 'cron', label: 'Scheduled Jobs', icon: LuClock3, section: 'settings' },
  { id: 'config', label: 'Config', icon: LuSettings2, section: 'settings' },
  { id: 'logs', label: 'Logs', icon: LuLogs, section: 'footer' },
  { id: 'health', label: 'Health', icon: LuHeartPulse, section: 'footer' },
];

const SECTIONS: { id: string; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'settings', label: 'Settings' },
];

interface SidebarProps {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  botName: string;
  botEmoji: string;
  pendingApprovals?: number;
  isNarrow?: boolean;
  onClose?: () => void;
}

export function Sidebar({
  currentPage,
  onNavigate,
  botName,
  botEmoji,
  pendingApprovals,
  isNarrow,
  onClose,
}: SidebarProps) {
  return (
    <nav class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-logo">{botEmoji}</div>
        <div class="sidebar-brand">
          <span class="sidebar-brand-name">{botName}</span>
          <span class="sidebar-brand-status">Online</span>
        </div>
        {isNarrow && (
          <button class="sidebar-close-btn" onClick={onClose} aria-label="Close sidebar">
            <LuChevronLeft size={16} />
          </button>
        )}
      </div>

      {SECTIONS.map(section => {
        const items = NAV_ITEMS.filter(i => i.section === section.id);
        return (
          <div class="sidebar-section" key={section.id}>
            <div class="sidebar-section-label">{section.label}</div>
            {items.map(item => {
              const Icon = item.icon;
              if (isExternal(item)) {
                return (
                  <a
                    key={item.id}
                    href={item.href}
                    class="sidebar-item"
                  >
                    <span class="sidebar-item-icon"><Icon size={16} /></span>
                    <span class="sidebar-item-label">{item.label}</span>
                  </a>
                );
              }
              const badge = item.id === 'approvals' && pendingApprovals ? pendingApprovals : undefined;
              return (
                <button
                  key={item.id}
                  data-page={item.id}
                  class={`sidebar-item${currentPage === item.id ? ' active' : ''}`}
                  onClick={() => onNavigate(item.id)}
                >
                  <span class="sidebar-item-icon"><Icon size={16} /></span>
                  <span class="sidebar-item-label">{item.label}</span>
                  {badge ? <span class="item-badge">{badge}</span> : null}
                </button>
              );
            })}
          </div>
        );
      })}

      <div class="sidebar-spacer" />

      <div class="sidebar-footer">
        {NAV_ITEMS.filter(i => i.section === 'footer').map(item => {
          const Icon = item.icon;
          if (isExternal(item)) {
            return (
              <a key={item.id} href={item.href} class="sidebar-footer-item">
                <span class="sidebar-item-icon"><Icon size={16} /></span>
                <span class="sidebar-item-label">{item.label}</span>
              </a>
            );
          }
          return (
            <button
              key={item.id}
              data-page={item.id}
              class={`sidebar-footer-item${currentPage === item.id ? ' active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              <span class="sidebar-item-icon"><Icon size={16} /></span>
              <span class="sidebar-item-label">{item.label}</span>
            </button>
          );
        })}
        <a
          class="sidebar-footer-item"
          href="https://docs.skimpyclaw.xyz/guide/"
          target="_blank"
          rel="noreferrer"
          title="Open SkimpyClaw documentation"
        >
          <span class="sidebar-item-icon"><LuBookOpen size={16} /></span>
          <span class="sidebar-item-label">Help Docs</span>
        </a>
      </div>
    </nav>
  );
}
