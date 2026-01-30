# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sink is a URL shortener with analytics, built with Nuxt 3 (Vue 3) and designed to run entirely on Cloudflare's serverless platform (Pages, Workers, KV, Analytics Engine).

## Commands

```bash
# Development
pnpm dev              # Start Nuxt dev server

# Build
pnpm build            # Production build
pnpm build:map        # Generate world map JSON (run automatically on postinstall)
pnpm build:colo       # Build Cloudflare colo data

# Code quality
pnpm lint             # ESLint check
pnpm lint:fix         # ESLint auto-fix
pnpm typecheck        # TypeScript type checking

# Deploy
pnpm preview          # Local preview with Wrangler
pnpm deploy           # Deploy to Cloudflare Pages
```

## Architecture

### Frontend (`app/`)
- **Pages**: `app/pages/` - Nuxt file-based routing
  - `/` - Public homepage
  - `/dashboard/*` - Protected dashboard routes (links, link details, analysis, realtime)
- **Components**: `app/components/`
  - `ui/` - shadcn-vue components (do not modify directly)
  - `dashboard/`, `home/`, `login/` - Feature-specific components
- **Composables**: `app/composables/` - Shared Vue composition functions
- **Utils**: `app/utils/api.ts` - `useAPI()` composable handles auth headers and 401 redirects

### Backend (`server/`)
- **Middleware** (executed in order):
  1. `server/middleware/1.redirect.ts` - Handles short link redirects
  2. `server/middleware/2.auth.ts` - Request authentication
- **API Routes**: `server/api/`
  - `link/` - CRUD operations (create, edit, delete, list, query, search, upsert, ai)
  - `stats/` - Analytics (counters, metrics, views)
  - `logs/` - Event and location logs

### Data Validation (`schemas/`)
- Zod schemas for link and query validation

### Internationalization (`i18n/`)
- Locales: en-US, zh-CN, zh-TW, fr-FR, vi-VN

## Key Configuration

### Cloudflare Bindings Required
- **KV**: Variable `KV` - Stores link data
- **Analytics Engine**: Variable `ANALYTICS` with dataset `sink`
- **Workers AI** (optional): Variable `AI` - For AI slug generation

### Environment Variables
See `.env.example` for full list. Key variables:
- `NUXT_SITE_TOKEN` - Dashboard auth token (must be >8 chars)
- `NUXT_CF_ACCOUNT_ID` / `NUXT_CF_API_TOKEN` - For analytics API access
- `NUXT_REDIRECT_STATUS_CODE` - HTTP redirect code (301/302/307/308)
- `NUXT_PUBLIC_PREVIEW_MODE` - Demo mode (links expire in 24h)

## Code Style

- ESLint: @antfu/eslint-config with pre-commit hooks via simple-git-hooks
- Components in `app/components/ui/` are ignored from linting
- TypeScript strict mode enabled
