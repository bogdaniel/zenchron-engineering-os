import type { Project } from './projects';

export const reviewPreviewProject: Project = {
  id: '48274827482748274827482748274827',
  name: 'Nova Platform',
  branch: 'main',
  git_remote: 'github.com/zenchron/nova-platform',
  worker_id: '0123456789abcdef0123456789abcdef',
  worker_name: 'Development Mac',
  last_seen: '2025-01-21T10:24:00Z',
  worker_status: 'online',
};

const pullRequest = (number: number, title: string, author: string, head: string, state = 'open', draft = false) => ({
  number,
  title,
  state,
  html_url: '#',
  body: number === 4827
    ? 'Adds AI feedback signals and end-to-end evidence capture for code reviews, including artifact collection, attestation, and policy context. Improves review quality, traceability, and merge governance.'
    : '',
  draft,
  updated_at: '2025-01-21T10:24:00Z',
  user: { login: author },
  head: { ref: head },
  base: { ref: 'main' },
});

export const reviewPreviewPullRequests = [
  pullRequest(4827, 'Add AI feedback signals and evidence capture', 'Maya Patel', 'feat/review-ai-evidence'),
  pullRequest(4819, 'Resolve flaky test in evidence pipeline', 'Jordan Kim', 'fix/evidence-flaky', 'open'),
  pullRequest(4816, 'Refactor review orchestration agents', 'Riley Torres', 'refactor/review-orchestration'),
  pullRequest(4812, 'Harden evidence artifact signing', 'Casey Morgan', 'security/artifact-signing'),
  pullRequest(4808, 'Update policy rules and merge thresholds', 'Alex Chen', 'chore/policy-rules'),
];

export const reviewPreviewDiff = `diff --git a/src/review/evidence_capture.ts b/src/review/evidence_capture.ts
index 6d3aa72..746bb91 100644
--- a/src/review/evidence_capture.ts
+++ b/src/review/evidence_capture.ts
@@ -118,12 +118,18 @@ export async function captureEvidence(ctx: ReviewCtx) {
   const signals = await aiFeedback.analyze(diff, context);
-  const evidence = await evidenceCapture.build({ diff, signals });
+  const evidence = await evidenceCapture.build({
+    diff,
+    signals,
+    artifacts: await collectArtifacts(ctx),
+    attestation: await signEvidence(ctx),
+    policyContext: ctx.policy,
+  });
   return evidence;
 }`;
