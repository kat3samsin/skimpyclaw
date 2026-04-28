import { useState, useEffect } from 'preact/hooks';
import { LuMenu, LuMoon, LuSun } from 'react-icons/lu';
import { Sidebar, type PageId } from './components/Sidebar.js';
import { ToastContainer, useToast } from './components/Toast.js';
import {
  Overview,
  History,
  Cron,
  Coding,
  Audit,
  Approvals,
  Memory,
  Model,
  Agents,
  Logs,
  Config,
  Digests,
  Skills,
  Health,
  Templates,
  Usage,
} from './pages/index.js';
import { getToken, onUnauthorized, setToken } from './api/client.js';
import './styles/base.css';

const PAGE_IDS: PageId[] = [
  'overview',
  'history',
  'cron',
  'memory',
  'model',
  'agents',
  'coding',
  'logs',
  'audit',
  'digests',
  'skills',
  'approvals',
  'health',
  'usage',
  'config',
  'templates',
];

function isPageId(value: string): value is PageId {
  return PAGE_IDS.includes(value as PageId);
}

function readPageFromHash(): PageId {
  const raw = window.location.hash.replace(/^#/, '').split('/')[0]!.trim();
  return isPageId(raw) ? raw : 'overview';
}

function getConfiguredBot(): { name: string; emoji: string } {
  const data = (window as any).__SKIMPY_DASHBOARD__;
  const name = typeof data?.botName === 'string' && data.botName.trim()
    ? data.botName
    : 'SkimpyClaw';
  const emoji = typeof data?.botEmoji === 'string' && data.botEmoji.trim()
    ? data.botEmoji
    : '👙🦞';
  return { name, emoji };
}

function LoginScreen({
  onLogin,
  botName,
  botEmoji,
}: {
  onLogin: (token: string) => void;
  botName: string;
  botEmoji: string;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  async function submit() {
    const trimmed = input.trim();
    if (!trimmed) return;
    // Try a basic API call to verify the token
    try {
      const res = await fetch('/api/dashboard/status', {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (res.status === 401) {
        setError('Invalid token');
        return;
      }
      setToken(trimmed);
      onLogin(trimmed);
    } catch {
      setError('Could not reach server');
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg)',
    }}>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '40px 48px',
        width: 360,
        boxShadow: 'var(--shadow-md)',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 36, marginBottom: 16 }}>{botEmoji}</div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
          {botName}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 28 }}>
          Enter your dashboard token
        </div>
        <input
          type="password"
          placeholder="Bearer token"
          value={input}
          onInput={(e) => { setInput((e.target as HTMLInputElement).value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          style={{
            width: '100%',
            padding: '10px 14px',
            borderRadius: 'var(--radius-sm)',
            border: `1px solid ${error ? 'var(--error)' : 'var(--border)'}`,
            background: 'var(--surface-alt)',
            color: 'var(--text)',
            fontFamily: 'var(--mono)',
            fontSize: 13,
            marginBottom: 12,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {error && (
          <div style={{ fontSize: 12, color: 'var(--error)', marginBottom: 12 }}>{error}</div>
        )}
        <button class="btn btn-primary" style={{ width: '100%' }} onClick={submit}>
          Sign in
        </button>
      </div>
    </div>
  );
}

export function App() {
  const bot = getConfiguredBot();
  const [authed, setAuthed] = useState(!!getToken());
  const [page, setPage] = useState<PageId>(() => readPageFromHash());
  const [isNarrow, setIsNarrow] = useState<boolean>(() => window.innerWidth <= 980);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => window.innerWidth > 980);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') ?? 'light';
  });
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const { toasts, showToast } = useToast();

  useEffect(() => {
    return onUnauthorized(() => {
      setAuthed(false);
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    function onResize() {
      const narrow = window.innerWidth <= 980;
      setIsNarrow(prev => {
        if (prev !== narrow) setSidebarOpen(!narrow);
        return narrow;
      });
    }

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!isNarrow || !sidebarOpen) {
      document.body.style.overflow = '';
      return;
    }
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isNarrow, sidebarOpen]);

  useEffect(() => {
    const applyFromHash = () => {
      const next = readPageFromHash();
      setPage(next);
      if (isNarrow) setSidebarOpen(false);
    };

    if (!window.location.hash) {
      window.location.hash = '#overview';
    } else {
      applyFromHash();
    }

    window.addEventListener('hashchange', applyFromHash);
    return () => window.removeEventListener('hashchange', applyFromHash);
  }, [isNarrow]);

  function toggleTheme() {
    setTheme(t => t === 'light' ? 'dark' : 'light');
  }

  function navigate(p: PageId) {
    const nextHash = `#${p}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    } else {
      setPage(p);
    }
    if (isNarrow) setSidebarOpen(false);
  }

  if (!authed) {
    return <LoginScreen botName={bot.name} botEmoji={bot.emoji} onLogin={() => setAuthed(true)} />;
  }

  function renderPage() {
    switch (page) {
      case 'overview':
        return <Overview onNavigate={navigate} showToast={showToast} />;
      case 'history':
        return <History />;
      case 'cron':
        return <Cron showToast={showToast} />;
      case 'usage':
        return <Usage />;
      case 'coding':
        return <Coding />;
      case 'audit':
        return <Audit />;
      case 'approvals':
        return <Approvals showToast={showToast} onCountChange={setPendingApprovals} />;
      case 'memory':
        return <Memory />;
      case 'model':
        return <Model showToast={showToast} />;
      case 'agents':
        return <Agents showToast={showToast} />;
      case 'logs':
        return <Logs />;
      case 'config':
        return <Config showToast={showToast} />;
      case 'digests':
        return <Digests />;
      case 'skills':
        return <Skills showToast={showToast} />;
      case 'health':
        return <Health />;
      case 'templates':
        return <Templates showToast={showToast} />;
      default:
        return <Overview onNavigate={navigate} showToast={showToast} />;
    }
  }

  return (
    <>
      <div class={`shell${isNarrow ? ' shell-narrow' : ''}${isNarrow && sidebarOpen ? ' sidebar-open' : ''}`}>
        {isNarrow && (
          <button
            class="global-sidebar-toggle"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            <LuMenu size={16} />
          </button>
        )}
        <Sidebar
          currentPage={page}
          onNavigate={navigate}
          botName={bot.name}
          botEmoji={bot.emoji}
          pendingApprovals={pendingApprovals}
          isNarrow={isNarrow}
          onClose={() => setSidebarOpen(false)}
        />
        {isNarrow && sidebarOpen ? <button class="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" /> : null}
        <main class="main">
          <button class="global-theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
            {theme === 'light' ? <LuMoon size={16} /> : <LuSun size={16} />}
          </button>
          {renderPage()}
        </main>
      </div>
      <ToastContainer toasts={toasts} />
    </>
  );
}
