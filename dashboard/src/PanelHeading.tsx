import type { ReactNode } from 'react';

export function PanelHeading({ eyebrow, title, description, icon, actions, className }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`shared-panel-heading${className ? ` ${className}` : ''}`}>
      <div>{icon}<div>{eyebrow !== undefined && <small className="shared-panel-eyebrow">{eyebrow}</small>}
        <h3>{title}</h3>{description !== undefined && <p>{description}</p>}</div></div>
      {actions}
    </div>
  );
}
