import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, Title, Text } from '@mantine/core';
import '@mantine/core/styles.css';
import './style.css';

function App() {
  return (
    <MantineProvider>
      <main>
        <Title order={1}>Zenchron</Title>
        <Text c="dimmed">Engineering workspace</Text>
      </main>
    </MantineProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
