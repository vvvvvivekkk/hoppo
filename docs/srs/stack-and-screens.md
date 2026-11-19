That changes the stack meaningfully — real payments, real compliance, real uptime. Here's the stack, then the screen inventory, then the things that bite real products.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Student app | React Native + Expo (EAS) | One codebase, OTA updates without store review, large hiring pool in India |
| Shop dashboard | Next.js PWA | Installs on a counter tablet, works offline-ish, no app store |
| Admin console | Next.js + Tailwind + shadcn/ui | Internal tool, speed over polish |
| API | NestJS (TypeScript), single monolith | Structure without microservice overhead; shares types with the clients |
| Realtime | Socket.IO with the Redis adapter | Dispatch fanout and chat on one connection; survives multi-instance |
| Primary DB | PostgreSQL 16 + PostGIS | Radius validation and nearby-rider queries are first-class, not bolted on |
| Hot state | Redis (GEO sets, locks, pub/sub) | Rider pings every 10–15s would wreck Postgres; this belongs in memory |
| Object store | Cloudflare R2 + Images | No egress fees, on-the-fly resize for catalog and document uploads |
| Push | Firebase Cloud Messaging | Free, covers Android and iOS |
| SMS/OTP | MSG91 | Cheaper than Twilio in India, and handles DLT template registration |
| Payments | Razorpay (Route + Payouts) | See the note below — this choice has legal weight |
| Maps | Google Places autocomplete + Geocoding | You geocode each shop once, so cost stays trivial |
| Errors / analytics | Sentry + PostHog | Self-hostable later if cost matters |
| Hosting | Fly.io or Railway, region `bom` / Mumbai | Start boring; Kubernetes is a later problem, not a launch problem |
| CI | GitHub Actions + EAS Build | |

Four choices worth defending, because they're the ones people get wrong.

**React Native over Flutter.** Flutter has better frame-level performance and a more consistent UI layer. React Native wins here because your shop and admin consoles are React anyway, so validation logic, types, and API clients are shared, and Expo's over-the-air updates let you ship a dispatch bugfix in an hour rather than waiting on Play Store review. When your core loop is real-time dispatch, that matters more than animation smoothness.

**Build chat, don't rent it.** Stream and Sendbird are excellent and will cost you per monthly active user — ruinous for a free student product with thin delivery margins. More to the point, you said the LINE-like layer is a reason students open the app. If it's a retention hook, it's core, and core doesn't get outsourced. Your messages are text and images in rooms; that's a weekend of schema and a fortnight of polish.

**Redis holds rider presence, Postgres holds the record.** When a rider goes online, `GEOADD` their position to a per-college Redis key and refresh it on each ping. At broadcast, `GEOSEARCH` returns eligible riders in sub-millisecond time. Postgres stores only the task, the assignment, and the audit trail.

**The assignment lock is the whole product.** Two riders tap accept 40ms apart. Use a single conditional update — `UPDATE task SET rider_id = $1 WHERE id = $2 AND rider_id IS NULL RETURNING *` — and treat zero rows returned as "already taken." Do not read-then-write, do not check in application code, do not use a Redis lock as the source of truth. This is the one race that will embarrass you in front of real users.

Here's how the pieces sit together.

External services sit alongside: Razorpay for payments and payouts, FCM for push, MSG91 for OTP, Google Maps for geocoding, Sentry and PostHog for observability.

---

## Screen requirements

Roughly 85 screens across three clients. P1 is launchable, P2 is retention, P3 is breadth.

### Student app — onboarding (9 screens)

| ID | Screen | Key elements | Phase |
|---|---|---|---|
| S-01 | Splash / auth gate | Token check, routes to home or welcome | P1 |
| S-02 | Welcome | Value prop, Sign up / Log in | P1 |
| S-03 | Phone entry | Country code, number, consent checkbox | P1 |
| S-04 | OTP verify | 6-digit input, auto-read on Android, resend timer | P1 |
| S-05 | College picker | Searchable list, distance hint, "my college isn't listed" | P1 |
| S-06 | Profile setup | Name, email, photo, password | P1 |
| S-07 | Verification submit | Roll no, dept, year, ID card camera capture with edge guide | P1 |
| S-08 | Verification pending | Status, expected time, what you can do meanwhile | P1 |
| S-09 | Verification rejected | Reason, annotated guidance, resubmit CTA | P1 |

### Student app — customer (14 screens)

| ID | Screen | Key elements | Phase |
|---|---|---|---|
| S-10 | Home / shop list | Category chips, open-now filter, closed shops greyed, search bar | P1 |
| S-11 | Search results | Items and shops, recent searches | P1 |
| S-12 | Shop detail | Header with rating and prep time, sticky category tabs, closed banner | P1 |
| S-13 | Item sheet | Image, description, quantity stepper, notes field | P1 |
| S-14 | Cart | Line items, edit quantity, fee breakdown, single-shop warning | P1 |
| S-15 | Drop point picker | Campus points list, map, saved points, landmark note | P1 |
| S-16 | Checkout | Payment method, fee breakdown, place-order CTA | P1 |
| S-17 | Payment sheet | Razorpay handoff, failure retry | P1 |
| S-18 | Order placed | Confirmation, order number, track CTA | P1 |
| S-19 | Order tracking | Live status stepper, rider card, OTP reveal, chat and call buttons, ETA | P1 |
| S-20 | Cancel sheet | Reason list, refund explanation | P1 |
| S-21 | Order history | Grouped by date, reorder CTA | P1 |
| S-22 | Order detail / receipt | Itemised, payment ref, download, raise issue | P1 |
| S-23 | Rate order | Separate rider and shop stars, tag chips, optional comment | P2 |

### Student app — rider (11 screens)

| ID | Screen | Key elements | Phase |
|---|---|---|---|
| S-24 | Rider onboarding | Terms, how earnings work, payout setup | P1 |
| S-25 | Work tab (offline) | Big go-online toggle, today's earnings, demand hint | P1 |
| S-26 | Work tab (online) | Waiting state, time online, nearby demand, go-offline | P1 |
| S-27 | Task offer | Full-screen card, countdown ring, pickup and drop, fee, accept/pass | P1 |
| S-28 | Active task — to pickup | Address, map, open-in-Maps, shop contact, chat | P1 |
| S-29 | Pickup confirm | Order items checklist, shop handover confirm or photo | P1 |
| S-30 | Active task — to drop | Drop point, customer chat, arrived button | P1 |
| S-31 | OTP entry | 6-digit input, attempts left, report problem | P1 |
| S-32 | Task complete | Fee credited, next-task prompt, rate customer | P1 |
| S-33 | Earnings | Day/week/month toggle, per-task list, acceptance rate | P2 |
| S-34 | Wallet & withdrawal | Balance, statement, withdraw form, bank details | P2 |

### Student app — chat and community (12 screens)

| ID | Screen | Key elements | Phase |
|---|---|---|---|
| S-35 | Chat list | Tabs: Tasks / Direct / Groups, unread badges, archived section | P2 |
| S-36 | Chat room | Bubbles, attachments, read receipts, archived banner on task rooms | P2 |
| S-37 | Contact picker | College directory search, recent | P2 |
| S-38 | Create group | Name, description, member multi-select | P2 |
| S-39 | Group info | Members, admin actions, leave, report | P2 |
| S-40 | Report / block sheet | Reason list, free text | P2 |
| S-41 | Community feed | Category chips, sort toggle, pinned announcements | P3 |
| S-42 | Post detail | Body, attachments, upvote, comment thread | P3 |
| S-43 | Create post | Category picker, title, body, attachments, link | P3 |
| S-44 | My posts | Drafts, published, engagement counts | P3 |
| S-45 | Saved posts | Bookmarked list | P3 |
| S-46 | Community search | Across titles and bodies, category filter | P3 |

### Student app — tasks and settings (9 screens)

| ID | Screen | Key elements | Phase |
|---|---|---|---|
| S-47 | Create parcel pickup | Pickup point, drop, parcel description, collection ref, fee quote | P3 |
| S-48 | Create peer errand | Pickup, drop, description, reimbursement amount, fee quote | P3 |
| S-49 | Profile | Avatar, name, college, verified badge, stats | P1 |
| S-50 | Edit profile | Name, photo, email, password change | P1 |
| S-51 | Notification settings | Per-category toggles, task offers locked while online | P2 |
| S-52 | Payment methods | Saved methods, default | P2 |
| S-53 | Help & support | FAQ, raise ticket, ticket history | P2 |
| S-54 | Legal | Privacy policy, terms, rider terms | P1 |
| S-55 | Account & data | Export data, delete account | P1 |

### Shop dashboard (14 screens)

| ID | Screen | Key elements | Phase |
|---|---|---|---|
| D-01 | Login | Email/phone + OTP | P1 |
| D-02 | Registration — details | Shop name, category, owner, contact | P1 |
| D-03 | Registration — location | Address autocomplete, draggable map pin, on/off campus toggle | P1 |
| D-04 | Registration — radius result | Measured distance, pass or fail with the limit shown | P1 |
| D-05 | Registration — documents | Licence, GSTIN, owner ID, frontage photo, FSSAI if food | P1 |
| D-06 | Registration — review | Summary, submit | P1 |
| D-07 | Verification pending | Status, contact admin | P1 |
| D-08 | Order queue | Live cards, audible alert, accept/reject, prep-time stepper | P1 |
| D-09 | Order detail | Items, customer note, rider status, mark ready, handover confirm | P1 |
| D-10 | Order history | Date range, status filter, export | P1 |
| D-11 | Catalog | Item list by category, availability toggles, bulk actions | P1 |
| D-12 | Item editor | Name, price, prep time, image upload, category | P1 |
| D-13 | Hours & closure | Weekly schedule, temporary closure with reopen time | P1 |
| D-14 | Settlements | Payout statement, commission breakdown, bank details | P1 |

### Admin console (18 screens)

| ID | Screen | Key elements | Phase |
|---|---|---|---|
| A-01 | Login | Email + password + TOTP | P1 |
| A-02 | Ops dashboard | Live orders, unfulfilled broadcasts, riders online, alerts | P1 |
| A-03 | Student verification queue | Document preview, approve/reject with reason, bulk view | P1 |
| A-04 | Student detail | Profile, order and task history, suspend | P1 |
| A-05 | Shop verification queue | Map with pin and radius circle, distance, documents | P1 |
| A-06 | Shop detail | Catalog, orders, settlements, suspend | P1 |
| A-07 | Live order board | Kanban by status, stuck-order flags | P1 |
| A-08 | Escalated tasks | OTP failures, abandonments, resolve with note | P1 |
| A-09 | College settings | Radius, fee bands, broadcast rounds, timeouts | P1 |
| A-10 | Delivery points | Map editor for campus drop points | P1 |
| A-11 | Reported content | Post and comment queue, remove/dismiss | P3 |
| A-12 | Reported users | Conversation view, warn/suspend | P2 |
| A-13 | Withdrawal requests | Verify, mark paid, payout reference | P2 |
| A-14 | Analytics | Funnel, acceptance latency, rider supply by hour, shop revenue | P2 |
| A-15 | Audit log | Filterable, exportable | P1 |
| A-16 | Admin users | Roles, invites, deactivate | P1 |
| A-17 | Announcements | Compose, pin, schedule | P3 |
| A-18 | Tenant management | Create college, coordinates, radius, assign admins | P1 |

Beyond screens, specify these as design states or you'll ship holes: empty catalog, no shops open, offline banner, verification-locked overlay on gated features, no riders available, payment failed, order cancelled by shop, task abandoned mid-delivery, and token expiry during an active task.

---

## What changes now that it's real

Four items from the SRS flip, and they're the ones that carry money and liability.

**Payments.** Use Razorpay Route so the money splits at the gateway and settles to each shop's account directly. If you take payment into your own account and pay shops later, you are holding customer funds as an intermediary, and in India that is the territory of the RBI's payment aggregator authorisation. Route keeps you out of it. Rider earnings go through RazorpayX Payouts, which means each rider needs a bank account and PAN on file.

**Food.** If you deliver prepared food you likely need FSSAI registration as an e-commerce food business operator, and every shop you onboard needs its own FSSAI licence number captured and displayed. Add it to the shop document list in D-05 and to the SRS as a hard registration requirement.

**Aadhaar.** The Section 11 recommendation gets stronger, not weaker. A real company holding a database of Aadhaar images is a genuine liability, and the Digital Personal Data Protection Act's obligations apply to you from day one. College ID plus verified phone establishes college membership, which is all you actually need. If you want a second document for riders handling cash, take a driving licence and store only the type, last four characters, and the decision.

**Riders.** Students doing paid deliveries are gig workers. Think about accident cover before your first rider is hit at a campus gate, not after — a group personal accident policy is cheap and the absence of one is not.

The economics are the thing I'd stress-test before writing much code. A ₹25 delivery fee and a 10% take on a ₹120 order is about ₹37 of gross per delivery, out of which the rider takes most of it. Campus density is your only real edge over Zomato, so model how many deliveries per day a single college actually generates before you build for fifty of them.

Want the ER diagram next, or the dispatcher implementation — the Redis GEO plus conditional-update flow written out?