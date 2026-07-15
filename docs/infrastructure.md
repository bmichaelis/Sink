# Infrastructure

Deployment map and rebuild runbook for this fork. **No secrets in this file** —
credentials live in the password manager (entries referenced below).

## Overview

```
visitor ── scan.flippinflops.com ──► Cloudflare Worker "kinda-sink"
                                        │  KV (links + notify state)
                                        │  Analytics Engine (kinda_sink)
                                        │  R2 "kinda-sink" (backups, images)
                                        │  AI (slug/OG generation)
                                        │
                        notification    ▼
                    ntfy.flippinflops.com ──► cloudflared tunnel ──► ntfy
                    (proxied CNAME)           (outbound-only)        (Oracle VM,
                                                                     127.0.0.1:2586)
phones (ntfy app) ◄── subscribe to topic "scans" ─────────────────────┘
```

## Cloudflare Worker

- **Worker:** `kinda-sink`, custom domain `scan.flippinflops.com` only
  (workers.dev + preview URLs disabled in `wrangler.jsonc`).
- The custom domain is managed via the account API / dashboard, **not** a
  `routes` entry — the deploy token lacks Workers Routes permission and a
  config entry would fail every deploy.
- **Deploy:** automatic — every push to `master` runs
  `.github/workflows/deploy.yml` (install → build → preset guard →
  `wrangler deploy`), authenticated by the `CLOUDFLARE_API_TOKEN` repo
  secret. Manual fallback: `pnpm build && npx wrangler deploy`.
  ⚠️ Never build with `CI=true` — it silently switches the Nitro preset from
  `cloudflare-module` to node-server and produces a non-Worker bundle. (The
  workflow handles this by forcing `NITRO_PRESET=cloudflare-module` and
  refusing to deploy any other preset.)
- **Bindings** (see `wrangler.jsonc`): KV namespace, Analytics Engine dataset
  `kinda_sink`, R2 bucket `kinda-sink`, AI, assets.
- **Vars:** `NUXT_DATASET=kinda_sink` (stats queries MUST read the same
  dataset the ANALYTICS binding writes, or the dashboard shows zero hits);
  `NUXT_REDIRECT_STATUS_CODE=302` (301s get browser-cached and repeat visits
  bypass the worker, going unlogged).
- **Secrets** (set with `npx wrangler secret put <NAME>`):
  - `NUXT_SITE_TOKEN` — dashboard login (password manager: "kinda-sink dashboard")
  - `NUXT_CF_ACCOUNT_ID` — account id for analytics queries
  - `NUXT_CF_API_TOKEN` — scoped token, Account Analytics:Read only

## R2 backups

- Daily cron (`0 0 * * *` in `wrangler.jsonc`) dumps all links to
  `backups/links-<timestamp>.json` in the `kinda-sink` bucket.
- Manual trigger: `POST /api/backup` (authed).
- Lifecycle rule `expire-backups-30d` on the bucket expires `backups/`
  objects after 30 days (set via `wrangler r2 bucket lifecycle`).
- Restore: download a backup file, use dashboard Import/Export → Import.

## Self-hosted ntfy (scan notifications)

Why self-hosted: **ntfy.sh drops Cloudflare Workers egress IPs** at the
network level (verified 2026-07-14 — timeouts from the worker on every
request shape while other hosts succeed). See closed issue #3.

- **Server:** ntfy on the Oracle arm64 VM, systemd service `ntfy`,
  config `/etc/ntfy/server.yml`, listening on `127.0.0.1:2586` **only** —
  never exposed directly; no inbound firewall ports open.
- **Ingress:** cloudflared tunnel `ntfy-flippinflops`
  (id `2fa17d4c-2d63-4196-80a4-6367f478ecb1`), systemd service `cloudflared`,
  outbound-only. DNS: proxied CNAME `ntfy.flippinflops.com` →
  `<tunnel-id>.cfargotunnel.com`.
- **Auth:** `auth-default-access: deny-all`. User `brett` (admin) for phone
  app login; a publish token for the worker (password manager:
  "ntfy.flippinflops.com"). Links embed it as
  `https://ntfy.flippinflops.com/<topic>?auth=<base64 'Bearer <token>'>`.
- **iOS push:** `upstream-base-url: https://ntfy.sh` relays a content-free
  poll ping through ntfy.sh APNS (originates from the VM, unaffected by the
  Workers block); message content never leaves our server.
- **Family topic:** `scans` — phones subscribe in the ntfy app after adding
  the server + logging in.
- `detectChannel()` in `server/utils/scan-notify.ts` treats any `ntfy.*`
  hostname as ntfy-format, so this server gets pretty pushes.

### Rebuild ntfy from scratch (VM loss)

1. Install: latest `ntfy_*_linux_arm64.deb` from
   github.com/binwiederhier/ntfy releases → `dpkg -i`.
2. Recreate `/etc/ntfy/server.yml` (base-url, listen 127.0.0.1:2586,
   behind-proxy, auth-file `/var/lib/ntfy/user.db`, deny-all,
   upstream-base-url ntfy.sh, cache 24h). `systemctl enable --now ntfy`.
3. Recreate user + token:
   `NTFY_PASSWORD=... ntfy user add --role=admin brett`,
   `ntfy token add brett` → **update the auth param in every link's
   notifyUrl** (token changed) and the password-manager entry.
4. Install cloudflared (`cloudflared-linux-arm64.deb`), fetch the tunnel run
   token (Zero Trust → Networks → Tunnels → ntfy-flippinflops, or
   `GET /accounts/<acc>/cfd_tunnel/<id>/token`), then
   `cloudflared service install <run-token>`.
   The tunnel, its ingress config, and the DNS record live in Cloudflare and
   survive VM loss — only the connector is reinstalled.
5. Verify: `curl https://ntfy.flippinflops.com/v1/health` → 200; authed
   publish → 200; anonymous publish → 403.

## GitHub

- Issues are enabled on this fork and `gh repo set-default` is pinned here —
  `gh issue create` without `-R` once misfiled to the upstream parent.
