# Zenchron Engineering OS

Go service and React dashboard starter.

## Go

```sh
go run ./cmd/zenchron
go test ./...
go vet ./...
```

## Dashboard

```sh
cd dashboard
npm ci
npm run typecheck
npm run build
npm run dev
```

Run the browser acceptance check with `npx playwright install chromium` then `npm run test:e2e` from `dashboard/`.
