import { IconAlertTriangle, IconFileText, IconGitBranch, IconMinus, IconPlus, IconShieldCheck } from '@tabler/icons-react';

const metrics = [
  ['Files Changed', '6', IconFileText, 'files'], ['Lines Added', '+427', IconPlus, 'added'],
  ['Commits', '12', IconGitBranch, 'commits'], ['Lines Removed', '−68', IconMinus, 'removed'],
  ['Risk Score', '78 / 100 (High)', IconAlertTriangle, 'risk'],
  ['Evidence Completeness', '94%', IconShieldCheck, 'evidence'],
] as const;
const checks = [
  ['CI / Build (8 jobs)', '3m 41s'], ['Tests (1,284)', '4m 07s'], ['Coverage (87.6% ≥ 85%)', '28s'],
  ['Security Scan (SAST/SCA)', '1m 32s'], ['Dependency Policy', '18s'], ['Evidence Completeness (≥ 90%)', '94%'],
  ['Policy Gates', '6s'], ['Trusted-main Criteria', '4s'],
];

export function ReviewPreviewSummary() {
  return <>
    <div className="reviews-summary-stats">
      {metrics.map(([label, value, Icon, tone]) => <div className={`reviews-preview-summary-metric ${tone}`} key={label}>
        <span><Icon size={12} aria-hidden="true" />{label}</span><b>{value}</b>
        {tone === 'evidence' && <div className="reviews-preview-evidence-progress" role="progressbar"
          aria-label="Evidence completeness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={94}>
          <i />
        </div>}
      </div>)}
    </div>
    <div className="reviews-checks-heading"><b>Required checks</b><span>8/8 All Passed</span></div>
    <div className="reviews-check-empty reviews-preview-checks">
      {checks.map(([label, duration]) => <span key={label}>✓ {label}<b>{duration}</b></span>)}
    </div>
  </>;
}
