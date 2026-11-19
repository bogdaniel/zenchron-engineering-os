import type { ReactNode } from 'react';

export function PageHeading({ eyebrow, title, titleAdornment, description, className, titleClassName, titleLevel = 2, titleTabIndex }: {
  eyebrow?: ReactNode;
  title: ReactNode;
  titleAdornment?: ReactNode;
  description: ReactNode;
  className?: string;
  titleClassName?: string;
  titleLevel?: 1 | 2;
  titleTabIndex?: number;
}) {
  const Title = titleLevel === 1 ? 'h1' : 'h2';
  return (
    <div className={`page-heading${className ? ` ${className}` : ''}`}>
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <div className={`page-heading-title-row${titleClassName ? ` ${titleClassName}` : ''}`}>
        <Title tabIndex={titleTabIndex}>{title}</Title>{titleAdornment}
      </div>
      <p>{description}</p>
    </div>
  );
}
