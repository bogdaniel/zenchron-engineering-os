import { Button } from '@mantine/core';
import { IconDownload, IconFileTypeCsv, IconFileTypePdf, IconFileTypeXls } from '@tabler/icons-react';
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
            <span className={`downloadable-report-format format-${report.format.toLowerCase()}${report.download ? '' : ' unavailable'}`}
              role="img" aria-label={`${report.format} file${report.download ? '' : ' unavailable'}`}>
              {report.format === 'PDF' ? <IconFileTypePdf size={22} aria-hidden="true" />
                : report.format === 'XLSX' ? <IconFileTypeXls size={22} aria-hidden="true" />
                  : <IconFileTypeCsv size={22} aria-hidden="true" />}
            </span>
            <div className="downloadable-report-copy"><b>{report.name}</b><span>{report.detail}</span></div>
            <Button className="downloadable-report-button" variant="subtle" disabled={!report.download}
              aria-label={report.download ? `Download ${report.name} ${report.format}` : `${report.name} download unavailable`}
              title={report.download ? undefined : 'No download is available in this view'}
              onClick={report.download}>
              <IconDownload size={14} />
            </Button>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}
