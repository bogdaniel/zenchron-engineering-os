import type { MouseEvent } from 'react';
import {
  IconChartBar, IconCode, IconHome, IconHierarchy, IconPuzzle, IconRobot, IconSettings, IconStack2, IconTarget,
} from '@tabler/icons-react';

const navigation = [
  { label: 'Overview', href: '#overview', icon: IconHome },
  { label: 'Objectives', href: '#objectives', icon: IconTarget },
  { label: 'Workflows', href: '#workflows', icon: IconHierarchy },
  { label: 'Agents', href: '#agents', icon: IconRobot },
  { label: 'Product Workspace', href: '#workspace', icon: IconStack2 },
  { label: 'Reviews', href: '#reviews', icon: IconCode },
  { label: 'Integrations', href: '#integrations', icon: IconPuzzle },
  { label: 'Reports', href: '#reports', icon: IconChartBar },
  { label: 'Settings', href: '#settings', icon: IconSettings },
];

export function Sidebar({ activePage, localReviewHost, onNavigate }: {
  activePage: string;
  localReviewHost: boolean;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}) {
  return <aside className="sidebar">
    <a className="brand" href="#overview" aria-label="Zenchron Engineering home">
      <span className="brand-mark" aria-hidden="true" />
      <span>Zenchron<small>Engineering</small></span>
    </a>
    <nav aria-label="Main navigation">
      {navigation.map(({ label, href, icon: Icon }) => (
        <a className={`nav-link${href === `#${activePage}` ? ' active' : ''}`} href={href} key={label}
          onClick={(event) => onNavigate(event, href)}>
          <Icon size={18} stroke={1.8} />
          <span className="nav-label" data-mobile-label={href === '#overview' ? 'Home' : href === '#settings' ? 'Profile' : undefined}>
            {label}
          </span>
        </a>
      ))}
    </nav>
    <div className="sidebar-bottom">
      <div className="sidebar-bottom-brand">
        <span className="brand-mark" aria-hidden="true" />
        <strong>Zenchron Engineering</strong>
      </div>
      <p>The AI-native engineering operating system.</p>
      {localReviewHost && <a className="preview-login-link" href="#login">Sign in</a>}
    </div>
  </aside>;
}
