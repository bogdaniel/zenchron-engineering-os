import { useState } from 'react';
import { TextInput } from '@mantine/core';
import { useDraggable } from '@dnd-kit/core';
import { IconChevronDown, IconCirclePlus, IconGripVertical, IconSearch } from '@tabler/icons-react';
import { PanelHeading } from './PanelHeading';
import { components, componentGroups, defaultDescriptions, workflowNodeIcons } from './workflowModel';
import type { ComponentType } from './workflowModel';

const paletteCategories = ['All', 'Agents', 'Actions', 'Control', 'Integrations'] as const;
type PaletteCategory = typeof paletteCategories[number];
const paletteCategoryTypes: Record<PaletteCategory, Set<ComponentType>> = {
  All: new Set(components.map(([, type]) => type)),
  Agents: new Set<ComponentType>(['planner', 'agent-router', 'agent-task', 'code-reviewer', 'test-generator', 'coverage-analyzer']),
  Actions: new Set<ComponentType>(['trigger', 'condition', 'loop', 'merge-gate']),
  Control: new Set<ComponentType>(['human-approval', 'merge-gate', 'condition', 'loop']),
  Integrations: new Set<ComponentType>(['publish-report']),
};
export const customBlock = { type: 'agent-task', label: 'Custom Block' } as const;
type AddComponent = (type: ComponentType, label: string) => void;

function ComponentPaletteItem({ type, label, description, onAdd }: {
  type: ComponentType; label: string; description: string; onAdd: AddComponent;
}) {
  const Icon = workflowNodeIcons[type];
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`, data: { type, label },
  });
  return <div className="workflow-component-row">
    <button className="workflow-component-add" type="button" onClick={() => onAdd(type, label)}>
      <span className={`workflow-component-icon ${type}`}><Icon size={15} /></span>
      <span className="workflow-component-copy"><b>{label}</b><small>{description}</small></span>
    </button>
    <button
      className="workflow-drag-handle"
      type="button"
      ref={setNodeRef}
      aria-label={`Drag ${label} to canvas`}
      style={{ opacity: isDragging ? .45 : 1 }}
      {...attributes}
      {...listeners}
    ><IconGripVertical size={14} /></button>
  </div>;
}

/** The component list: search, category chips, and collapsible groups. Must render inside the canvas DndContext. */
export function WorkflowPalette({ onAdd }: { onAdd: AddComponent }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<PaletteCategory>('All');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set(['Integrations']));
  const filteredComponents = components.filter(([, type, label]) =>
    paletteCategoryTypes[category].has(type)
    && `${label} ${defaultDescriptions[type]}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return <aside className="workflow-palette">
    <PanelHeading className="workflow-subheading" icon={<IconCirclePlus size={16} />} title="Components"
      actions={<button className="workflow-preview-custom-block" type="button"
        onClick={() => onAdd(customBlock.type, customBlock.label)}>＋ Custom Block</button>} />
    <TextInput
      className="workflow-palette-search"
      aria-label="Search blocks"
      placeholder="Search blocks..."
      leftSection={<IconSearch size={14} />}
      value={search}
      onChange={(event) => setSearch(event.currentTarget.value)}
    />
    <div className="workflow-preview-palette-categories" role="group" aria-label="Component categories">
      {paletteCategories.map((name) => <button key={name} type="button"
        aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</button>)}
    </div>
    {componentGroups.map((group) => {
      const groupComponents = filteredComponents.filter(([groupName]) => groupName === group);
      if (!groupComponents.length) return null;
      const isCollapsed = collapsedGroups.has(group) && !search.trim() && category === 'All';
      const groupId = `workflow-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      return <div className="workflow-component-group" key={group}>
        <button className="workflow-component-group-toggle" type="button" aria-label={`Toggle ${group}`}
          aria-expanded={!isCollapsed} aria-controls={groupId} onClick={() => setCollapsedGroups((current) => {
            const next = new Set(current);
            if (next.has(group)) next.delete(group);
            else next.add(group);
            return next;
          })}>
          <b>{group}</b><IconChevronDown size={13} />
        </button>
        <div className="workflow-component-list" id={groupId} hidden={isCollapsed}>
          {groupComponents.map(([, type, label]) => (
            <ComponentPaletteItem key={type} type={type} label={label} description={defaultDescriptions[type]}
              onAdd={onAdd} />
          ))}
        </div>
      </div>;
    })}
    {!filteredComponents.length && <p className="workflow-palette-empty">No blocks match your search.</p>}
  </aside>;
}
