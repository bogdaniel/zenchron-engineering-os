import type { MouseEvent, ReactNode } from 'react';
import {
  IconChartBar, IconCode, IconHome, IconHierarchy, IconPuzzle, IconRobot, IconSettings, IconStack2, IconTarget, IconUser,
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
  { label: 'Settings', href: '#settings', icon: IconSettings, mobileIcon: IconUser },
];

export function Sidebar({ activePage, showSignIn, modeSwitch, onNavigate }: {
  activePage: string;
  showSignIn: boolean;
  modeSwitch: ReactNode;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}) {
  return <aside className="sidebar">
    <a className="brand" href="#overview" aria-label="Zenchron Engineering home">
      <span className="brand-mark" aria-hidden="true" />
      <span>Zenchron<small>Engineering</small></span>
    </a>
    <nav aria-label="Main navigation">
      {navigation.map(({ label, href, icon: Icon, mobileIcon: MobileIcon }) => (
        <a className={`nav-link${href === `#${activePage}` ? ' active' : ''}`} href={href} key={label}
          onClick={(event) => onNavigate(event, href)}>
          <Icon className={MobileIcon ? 'nav-desktop-icon' : undefined} size={18} stroke={1.8} aria-hidden="true" />
          {MobileIcon && <MobileIcon className="nav-mobile-icon" size={18} stroke={1.8} aria-hidden="true" />}
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
      <div className="sidebar-mode">{modeSwitch}</div>
      {/* The row is always there so the footer sits at the same height in both modes. */}
      {showSignIn ? <a className="preview-login-link" href="#login">Sign in</a>
        : <span className="preview-login-link" aria-hidden="true">&nbsp;</span>}
    </div>
  </aside>;
}
