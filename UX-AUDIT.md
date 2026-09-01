# UX-laws audit — Algo PBX Apple-black app (S7)

Method: static/code audit of every major admin and agent screen against the 10
UX laws (Hick, Miller, Tesler, Jakob, Fitts, Doherty, Proximity, Von Restorff,
Serial position, Peak-End). The local app needs `AUTH_SECRET` + a seeded
Postgres to boot, which this environment does not have, so screens were read
from source rather than driven in a browser. Findings that need a running DB to
confirm (contrast in both themes, real 390px wrapping) are marked *(needs live
check)*.

One round of small, safe fixes was applied — cosmetic / a11y / micro-interaction
only. No API route, data shape, Prisma schema, business logic, `sip-context.tsx`,
`src/lib/**`, token layer, or `src/components/ui/**` primitive was touched.

---

## Summary — findings by law

| Law | Findings | Fixed | Recommended |
|---|---|---|---|
| Hick | 3 | 0 | 3 |
| Miller | 2 | 0 | 2 |
| Tesler | 1 | 0 | 1 |
| Jakob | 1 | 0 | 1 |
| Fitts | 3 | 2 | 1 |
| Doherty | 4 | 2 | 2 |
| Proximity | 1 | 0 | 1 |
| Von Restorff | 2 | 0 | 2 |
| Serial position | 1 | 0 | 1 |
| Peak-End | 2 | 1 | 1 |
| A11y (cross-cutting) | 4 | 3 | 1 |
| **Total** | **24** | **9** | **15** |

9 code fixes across 3 files. All remaining items are listed as "recommended,
not done" to stay under the ~15-fix ceiling and the safety rules.

---

## Fixes applied

### 1. Agent · Contacts list · Fitts / A11y — `src/components/crm/contact-list.tsx`
- **Problem:** the "new contact" trigger was a bare `+` glyph in a `px-3 py-2`
  box (~32px tall, under the 44px target) with only a `title` and no accessible
  name or state; the Mine/All scope toggle had no `aria-pressed`.
- **Fix (done):** `+` button → `h-10 w-10` square, `type="button"`,
  `aria-label="New contact"`, `aria-expanded={showCreate}`. Scope toggles →
  `aria-pressed`, `type="button"`, `py-1 → py-1.5`.

### 2. Agent · Contacts list · Doherty — `src/components/crm/contact-list.tsx`
- **Problem:** first load and every 15s poll showed a plain "Loading…" string;
  no skeleton, so the list area collapsed to one line of text.
- **Fix (done):** render 6 `<Skeleton className="h-12" />` rows in a
  `aria-busy` container while `loading`.

### 3. Agent · Contact detail · Doherty — `src/components/crm/contact-detail.tsx`
- **Problem:** whole right column was replaced by "Loading…" text on every
  contact switch — a jarring full-panel blank.
- **Fix (done):** skeleton layout (title + subtitle + three blocks) in an
  `aria-busy` container.

### 4. Agent · Contact detail · Peak-End — `src/components/crm/contact-detail.tsx`
- **Problem:** recording a disposition / adding a note or task just silently
  cleared the input and re-fetched. The end-of-call moment (disposition) — the
  single most important agent action — had no designed confirmation.
- **Fix (done):** transient `role="status"` success line ("Marked Interested",
  "Note added", "Task added") that self-clears after 2.5s.

### 5. Agent · Contact detail · A11y — `src/components/crm/contact-detail.tsx`
- **Problem:** the primary "Call" button's accessible name was just "Call" with
  no indication of who is being called.
- **Fix (done):** `aria-label={`Call ${name || number}`}`.

### 6. Agent · Contacts home · Peak-End / empty state — `src/app/agent/page.tsx`
- **Problem:** right-pane empty state was one grey sentence, "Select a contact,
  or create a new one." — no hierarchy, easy to read as "nothing here / broken".
- **Fix (done):** two-line empty state with a bold "No contact selected" lead
  and a helper line pointing at the list and the "+" button.

---

## Recommended — not done

Ordered roughly by value.

1. **`src/components/ui/button.tsx` + `input.tsx` — no visible focus ring.**
   `button.tsx` sets `focus-visible:outline-none` and adds **no** replacement
   ring on `primary` / `secondary` / `ghost` / `danger`. Keyboard focus is
   therefore invisible on almost every button in the app (WCAG 2.4.7 fail).
   `input.tsx` has `focus-visible:ring-1` but no `ring-color`, so the ring is
   the browser default. This is in the primitive layer (off-limits for S7) —
   needs a one-line `focus-visible:ring-2 ring-accent ring-offset-2
   ring-offset-canvas` added to `buttonVariants` base and a `ring-accent` on the
   input. High priority.

2. **Admin shell · Hick / Miller / Serial position — `admin-shell.tsx`.**
   6 nav groups, ~27 leaf items, several near-duplicates split across groups:
   "Call recording" (Configuration) vs "Recordings" (Telephony) vs "Live
   monitor" (Telephony); "Do not call" (Configuration) is really CRM/telephony
   policy; "Manager escalation" (Configuration) is queue behaviour. Recommend:
   merge to 4 groups (Overview, CRM, Telephony, Admin), move DNC under CRM,
   co-locate the three recording/monitor items, and order each group
   most-used-first (Serial position). Structural — deferred.

3. **Agent · Call page · Miller / Proximity — `src/app/agent/call/page.tsx`.**
   One route stacks Dialpad, CallControls, Missed calls, Voicemail and
   Recordings vertically with no grouping headers or cards separating the
   "make a call" tools from the "review past activity" lists. Recommend two
   labelled sections (or tabs) — "Dial" and "History". Structural — deferred.

4. **Agent · Contact detail · Von Restorff — disposition bar.**
   4 outcome pills + DNC are all the same weight and size as every other
   secondary button on the page; the disposition bar is the primary purpose of
   the screen and should stand out (e.g. a filled primary "Interested", a
   slightly larger bar, section framing). Also the pills are `px-3 py-1`
   (~28px) — under 44px. Cosmetic but touches the visual system; deferred to a
   design pass.

5. **Global · Doherty — three more raw "Loading…" strings.**
   `src/app/register/page.tsx:246`, `src/app/admin/contact-ownership/page.tsx:101`,
   `src/app/admin/audit/page.tsx:81` still render a text "Loading…" instead of
   `<Skeleton>`. Low risk, left out only for the fix-count ceiling.

6. **Agent shell · Von Restorff / Hick — sidebar "Admin" link.**
   For a SUPERVISOR/ADMIN working as an agent, the only cross-workspace link is
   a tiny `text-xs` line at the bottom of the rail. Fine as-is, but consider a
   clearer affordance.

7. **Admin · Wallboard (`/admin`) · Doherty — `src/components/wallboard.tsx`**
   *(needs live check)* — confirm it shows a skeleton, not a blank card, during
   its first poll.

8. **Jakob — contact list "+" for "new".**
   A `+` glyph for "new contact" is less conventional than a labelled "New" or
   a `UserPlus` icon with text. Consider `+ New`.

9. **Tesler — "Who was this?" prompt.**
   Good instinct, but it reappears on every visit to any un-named contact until
   named or skipped-this-session; skip state is not persisted. Minor.

10. **Fitts — task checkboxes in contact detail** are native `<input
    type="checkbox">` at default ~13px with a 2px offset; hard to hit on
    touch. Wrap in a `<label>` with padding so the whole row toggles.

11. **Proximity — contact detail disposition note field** sits on the same row
    as the outcome pills but is visually a sibling of them (`ml-auto`), reading
    as a filter box rather than "note attached to the disposition you pick".
    Move it below the pills with a caption.

12. **Miller — admin Reports hub** *(needs live check)* — confirm the KPI row
    is chunked (≤ ~6 tiles per band) and charts are grouped by theme, not a
    flat wall.

13. **Von Restorff — agent Contacts home** has no single standout action; the
    "+" is de-emphasised and there is no primary CTA when the list is empty.
    Pair with the empty-state fix (#6 above) by adding a real button there.

14. **Serial position — agent nav "Work" group** order is Contacts, Call,
    Calls, Missed, Voicemail. "Missed" and "Voicemail" (the things that decay if
    ignored) are last; consider Contacts, Call, Missed, Voicemail, Calls.

15. **A11y — `aria-current` / landmark check across admin pages** *(needs live
    check)* — SidebarNav sets `aria-current="page"` correctly; verify each
    page renders exactly one `<h1>` and a `<main>` landmark (admin-shell
    provides `<main>`, agent pages provide their own — agent/page.tsx and
    agent/call/page.tsx both render a nested `<main>` inside agent-shell's
    content div, which itself is not a `<main>`; still, two `<main>` elements
    would be wrong if the shell ever adds one).

---

## Screens reviewed

Admin: Wallboard, Contacts, CRM Companies/Pipeline/Tasks, Ownership, Queues,
Call log (CDR), Recordings, Live monitor, Extensions, Dinstar, WhatsApp, SIM
SMS, Rooms, Reports, Users, Escalations, DNC, Call recording, Domain, Settings,
System, Audit log, Sign-ins.
Agent: Contacts (home), Call, Calls, Missed, Voicemail, Chat, CRM
Pipeline/Tasks.
Auth: Login, Register, Forgot-password, Invite, Setup.

Well-instrumented already (no fix needed): `call-controls.tsx` (48px circular
targets, full `aria-label` coverage, error toasts), `chat/*` (aria-labels,
mobile back button, search labels), `sidebar-nav.tsx` (Headless UI Disclosure,
`aria-current`, badges), `theme-toggle.tsx` (labelled), CRM pipeline/company/
task boards (all use `<Skeleton>`).

---

## Gate

`npm run typecheck && npm run test && npm run lint && npm run build` — see commit
message / session report for results.
