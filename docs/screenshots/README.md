# Objectives page review captures

These Playwright screenshots were captured from the existing dashboard at `http://127.0.0.1:4173/#objectives` using the local read-only design preview.

- `objectives-desktop.png`: 1672 × 941 viewport.
- `objectives-1668x750.png`: 1668 × 750 viewport used for the live manual review.
- `objectives-mobile.png`: 390 × 844 viewport, full page.

The preview uses sample records and does not read or write workspace objective data. Automated coverage is in `dashboard/e2e/objectives-views.spec.ts`; run it with `cd dashboard && npm run test:e2e -- e2e/objectives-views.spec.ts`.
