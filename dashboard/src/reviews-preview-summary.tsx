const metrics = [
  ['Files changed', '6'], ['Lines added', '+427'], ['Commits', '12'],
  ['Lines removed', '−68'], ['Risk score', '78/100 · High'], ['Evidence completeness', '94%'],
];
const checks = [
  ['CI / Build (8 jobs)', '3m 41s'], ['Tests (1,284)', '4m 07s'], ['Coverage (87.6% ≥ 85%)', '28s'],
  ['Security Scan (SAST/SCA)', '1m 32s'], ['Dependency Policy', '18s'], ['Evidence Completeness (≥ 90%)', '94%'],
  ['Policy Gates', '6s'], ['Trusted-main Criteria', '4s'],
];

export function ReviewPreviewSummary() {
  return <>
    <div className="reviews-summary-stats">
      {metrics.map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
    </div>
    <div className="reviews-checks-heading"><b>Required checks</b><span>8/8 All Passed</span></div>
    <div className="reviews-check-empty reviews-preview-checks">
      {checks.map(([label, duration]) => <span key={label}>✓ {label}<b>{duration}</b></span>)}
    </div>
  </>;
}
