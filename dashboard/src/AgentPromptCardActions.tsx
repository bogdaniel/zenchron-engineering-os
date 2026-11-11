import { Button, Menu } from '@mantine/core';
import { IconDots, IconPencil } from '@tabler/icons-react';

export function AgentPromptCardActions({ label, onEdit, onCopy }: {
  label: string;
  onEdit: () => void;
  onCopy: () => void;
}) {
  return <div className="agents-preview-prompt-actions">
    <Button className="agents-preview-card-action" variant="default" size="xs" leftSection={<IconPencil size={11} />}
      onClick={onEdit}>Edit</Button>
    <Menu withinPortal position="bottom-end"><Menu.Target>
      <Button className="agents-preview-prompt-more" variant="default" size="xs" aria-label={`${label} options`}>
        <IconDots size={14} />
      </Button>
    </Menu.Target><Menu.Dropdown>
      <Menu.Item onClick={onCopy}>Copy prompt</Menu.Item>
    </Menu.Dropdown></Menu>
  </div>;
}
