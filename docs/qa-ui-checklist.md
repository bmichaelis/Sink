# Manual UI Click-Through Checklist

A hand-run QA pass for the dashboard editor features that automated tests can't
see: the editor accordions rendering, the card badges, the partial-window
warning styling, and the per-variant stats card. Redirect behavior itself is
covered by `tests/redirect.spec.ts` — treat the "Secondary" steps below as
quick confirmations, and spend your attention on the ✔️ **rendering** checks.

Covers: scheduled destinations (#10), geo/time fencing (#12), A/B split links
(#11), and A/B Phase 2 per-variant stats (#20).

## Setup — pick one

**Option A — production (zero setup, most faithful).** Log into
`https://scan.flippinflops.com/dashboard` with your site token. You'll create a
few `qa-*` links and delete them at the end. Real rendering, real timezone, real
Analytics Engine.

**Option B — local (no production data).** In the repo, temporarily remove the
`ai` block from `wrangler.jsonc` (do **not** commit — local KV breaks otherwise),
then:

```bash
echo "NUXT_SITE_TOKEN=SinkCool" > .env
pnpm dev            # open the port it prints (7465, or 3000 if taken)
# when done:
git checkout wrangler.jsonc && rm -f .env
```

Steps below are written for Option A; substitute your local URL for Option B.

## Quick checklist

- [ ] **1. Scheduled destinations** — accordion, datetime + URL rows, Clock badge, time round-trips in local zone
- [ ] **2. Geo restrictions** — accordion, searchable country picker, ShieldBan badge
- [ ] **3. Active hours** — time inputs + auto-filled timezone, **red partial-window warning**, badge
- [ ] **4. A/B split** — accordion, URL + weight rows, Split badge, **mutual-exclusion error toast**
- [ ] **5. Phase 2 stats card** — "Split Test" card on the analytics page, empty state then per-variant numbers

---

## 1. Scheduled destinations (#10)

- [ ] Create a link → URL `https://example.com/photos`, slug `qa-schedule`.
- [ ] Expand **Advanced** → open **Scheduled Destinations** → click **Add**.
- [ ] Set the datetime picker to **~1 hour from now**, URL `https://example.com/rsvp`. Save.
- [ ] ✔️ **Card:** a **clock icon** badge appears; hover shows "Scheduled destinations".
- [ ] ✔️ **Reopen the editor:** the section is auto-expanded and the time shows the **same wall-clock value you entered, in your local timezone**. (A bug here shows a shifted time — this is the round-trip that matters.)
- [ ] Secondary: visit `https://scan.flippinflops.com/qa-schedule` → lands on **/rsvp**, not /photos.

## 2. Geo restrictions (#12)

- [ ] Edit `qa-schedule` (or a new `qa-geo`) → **Advanced** → **Geo Restrictions** → **Add Country**.
- [ ] ✔️ The **country picker** opens and is searchable. Pick **your own country** (so the link still works for you). Save.
- [ ] ✔️ **Card:** a **shield-ban icon** badge; tooltip "Access restricted".
- [ ] Secondary — blocking: add a *different* country instead (one you're not in), save, visit the link → you get the **"Not Available Here"** page (403). Set it back to your country afterward.

## 3. Active hours (#12)

- [ ] New link → URL `https://example.com/shop`, slug `qa-hours` → **Advanced** → **Active Hours**.
- [ ] Set **Start** to the current hour and **End** two hours ahead. ✔️ The **Timezone field auto-fills with your zone** as soon as you set a time. Save → link works when visited.
- [ ] ✔️ **The warning test (the important one):** edit again and **clear the Timezone field** while start/end stay filled. A **red/destructive warning** should appear: *"Set the start, end, and timezone — an incomplete window is not saved."* Save with it cleared → reopen → the whole active-hours window is **gone** (the incomplete state was dropped, and the warning told you so instead of failing silently).
- [ ] Secondary: set a window that **excludes now** (e.g. 3 hours ago → 1 hour ago) → visiting shows the **"Outside Active Hours"** page.

## 4. A/B split (#11)

- [ ] New link → URL `https://example.com/base`, slug `qa-split` → **Advanced** → **Split Test (A/B)**.
- [ ] **Add Variant** twice: `https://example.com/a` weight `1`, and `https://example.com/b` weight `1`. ✔️ Each row has a **URL field and a number (weight) field**. Save.
- [ ] ✔️ **Card:** a **split icon** badge; tooltip "A/B split test".
- [ ] ✔️ **Mutual-exclusion (users will hit this):** edit `qa-split` and *also* try to add a Geo Restriction **or** a Scheduled Destination, then Save. It should be **rejected with an error toast naming the conflict** ("A split link cannot also use geo routing / scheduled destinations …"), not silently accepted.
- [ ] Secondary: visit `https://scan.flippinflops.com/qa-split` **several times** → you land on **/a or /b** (never /base), roughly half each.

## 5. Phase 2 per-variant stats card (#20)

- [ ] Open `qa-split`'s **analytics page** (click the link, or go to `/dashboard/link?slug=qa-split`).
- [ ] ✔️ A **"Split Test" card** renders with **both variants** — each showing "Variant 1 / Variant 2", its URL, weight, and Visits / Visitors columns. With no data yet it shows zeros and the note *"No variant visits recorded yet."*
- [ ] ✔️ The **"variants reflect the link's current setup…"** note is present under the title.
- [ ] **After** scanning the link a few times in step 4, **wait ~2–5 minutes** (Analytics Engine ingestion latency) and refresh → per-variant **visit counts and percentages** appear. *(Caveat: "unique visitors" only increments per distinct IP, so testing from one device won't move that column much — expected, not a bug.)*
- [ ] Optional edge case: in the editor **delete one variant** and save, then reopen the analytics card → the removed variant's past data shows as **"Variant N (removed)"** rather than vanishing.

## Cleanup

- [ ] Delete the `qa-schedule`, `qa-geo`, `qa-hours`, `qa-split` links.

---

**Honest limits:** the geo-*blocking* and active-hours-*excluded* cases are
awkward to exercise from a single location/time, so the ✔️ editor-rendering and
badge checks are the real payoff — those are what no automated test covers. The
Phase 2 numbers need real scans plus the AE delay, so that card is the slowest
to fully confirm.
