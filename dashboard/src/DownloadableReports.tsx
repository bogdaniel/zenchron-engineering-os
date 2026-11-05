import { Badge, Button } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';

export interface DownloadableReport {
  name: string;
  detail: string;
  format: string;
  download?: () => void;
}

export function DownloadableReports({ reports }: { reports: DownloadableReport[] }) {
  return (
    <PanelCard className="reports-panel downloadable-reports-panel" withBorder>
      <PanelHeading className="reports-panel-heading" icon={<IconDownload size={15} />} title="Downloadable Reports" />
      <div className="downloadable-report-list">
        {reports.map((report) => (
          <div className="downloadable-report" key={report.name}>
            <Badge className={`downloadable-report-format ${report.download ? '' : 'unavailable'}`} variant="light">
              {report.format}
            </Badge>
            <div className="downloadable-report-copy"><b>{report.name}</b><span>{report.detail}</span></div>
            <Button className="downloadable-report-button" variant="subtle" disabled={!report.download}
              aria-label={report.download ? `Download ${report.name} ${report.format}` : `${report.name} unavailable`}
              onClick={report.download}>
              <IconDownload size={14} />
            </Button>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}
