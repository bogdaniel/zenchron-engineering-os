import React from 'react';
import { Button } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { PanelCard } from './PanelCard';

export class PageErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return <section className="page-error-region" role="alert" aria-labelledby="page-error-title">
      <PanelCard className="page-error-card" withBorder>
        <IconAlertTriangle size={24} aria-hidden="true" />
        <h2 id="page-error-title">This page could not be displayed</h2>
        <p>The rest of Zenchron is still available. Try loading this page again.</p>
        <Button onClick={() => this.setState({ hasError: false })}>Try again</Button>
      </PanelCard>
    </section>;
  }
}
