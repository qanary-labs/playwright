# Custom

## Behavior changes vs upstream

- **`HttpsUpgrades` left enabled** (`packages/playwright-core/src/server/chromium/chromiumSwitches.ts`).
  Upstream disables it (PR #27605); we removed it from `disabledFeatures` so Chromium keeps its default
  http→https auto-upgrade. Without it, targets that 302 from https to an http-only host (e.g. OIDC
  downgrade redirects) fail with "site can't be reached". Re-removing this is required after any rebase
  onto a newer Playwright base, since the upstream list will re-add `HttpsUpgrades`.

## Installation

Follow [CONTRIBUTING.md](./CONTRIBUTING.md) guidelines.

## Build locally

Do these following commands into `packages/playwright` to build `.tgz` file.

```Bash
npm install
npm run build
npm pack
```

Integrate it into a real project through `npm`:

```Bash
npm install produced-file.tgz
```

And look like this in `package.json`:

```JSON
  "dependencies": {
    "playwright": "file:./playwright.tgz",
  }
```
