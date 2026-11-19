1. Introduction
1.1 Purpose

This document specifies the functional and non-functional requirements for a college-scoped delivery and student networking platform. The system enables verified students of a college to order goods from registered shops, to earn by delivering those orders to peers, and to communicate and share academic and career resources within their college community.

This SRS is intended for the project guide, evaluators, and the development team, and serves as the baseline for design, implementation, and acceptance testing.

1.2 Scope

The platform operates as a multi-tenant system where each college is an independent tenant. A student sees only the shops, orders, riders, chats, and posts belonging to their own college. There is no cross-college visibility or delivery.

The product consists of three interfaces:

Interface	Primary user	Form factor
Student app	Students (as customers and as riders)	Mobile-first
Shop dashboard	Shop owners / staff	Tablet or desktop web
Admin console	Platform administrators	Desktop web

In scope: identity verification, shop onboarding with geographic validation, catalog and ordering, delivery task broadcast and acceptance, in-app messaging, community posting, wallet and settlement, ratings, and administration.

Out of scope for this release: real payment-gateway settlement to shop bank accounts, live GPS turn-by-turn navigation, scheduled or subscription orders, and public (non-college) user access.

1.3 Definitions and Acronyms
Term	Meaning
Tenant	A single college and all data scoped to it
Student	A verified member of a college tenant
Work mode	A toggle that makes a verified student visible to the delivery dispatcher
Rider	A student currently in work mode who has accepted a task
Task	Any deliverable job: a shop order, a parcel pickup, or a peer errand
Broadcast	The dispatch event that offers a task to all eligible riders simultaneously
Shop	A merchant registered inside the campus or within the configured radius
Serviceable radius	The maximum distance from the college at which a shop may register (default 3 km)
OTP	One-time password used to confirm handover of goods
Admin	A platform operator who verifies students and shops and resolves disputes
FR	Functional Requirement
NFR	Non-functional Requirement
1.4 References
IEEE Std 830-1998, Recommended Practice for Software Requirements Specifications
The Aadhaar (Targeted Delivery of Financial and Other Subsidies, Benefits and Services) Act, 2016, and the Aadhaar (Sharing of Information) Regulations, 2016
The Digital Personal Data Protection Act, 2023
1.5 Overview

Section 2 describes the product context and users. Section 3 covers interfaces. Sections 4 to 8 enumerate functional requirements by module. Section 9 defines the data model, Section 10 the non-functional requirements, Section 11 legal constraints, Section 12 assumptions and phasing, and Section 13 the appendices.

2. Overall Description
2.1 Product Perspective

The system is a new, self-contained product. It is not a replacement for an existing system and has no mandatory integration with college ERP or academic systems, though a future release may consume a college-provided student roster to automate verification.

Architecturally it is a client-server application: mobile and web clients communicating with a REST API, a real-time channel (WebSocket) for dispatch and chat, a relational database, and an object store for uploaded documents and images.

2.2 Product Functions

At a high level the system shall:

Register and verify students against a specific college using institutional and government identity documents.
Register and verify shops, enforcing that each shop lies inside the campus or within the serviceable radius of its chosen college.
Let verified students browse shop catalogs and place orders.
Let verified students enable work mode and accept delivery tasks offered by the dispatcher.
Assign each task to exactly one rider on a first-accept basis.
Confirm handover using a one-time password and settle the delivery fee to the rider.
Provide messaging between the parties to a task, and between students generally.
Provide a community board for notes, resources, internships, and announcements.
Provide administrators with verification queues, dispute handling, and operational reporting.
2.3 User Classes and Characteristics

U1 — Student (customer role). Every verified student. Low tolerance for latency, uses a mid-range Android phone on campus Wi-Fi or 4G. Orders are small-value and time-sensitive.

U2 — Student (rider role). The same account as U1 with work mode enabled. Motivated by small earnings between classes. Availability is irregular and short-lived, so the system must not depend on any individual rider being reachable.

U3 — Shop owner or staff. Operates from a counter, often busy, limited technical skill. Needs a single screen showing incoming orders with large tap targets and an audible alert.

U4 — Platform administrator. Trained operator. Reviews verification documents, resolves disputes, configures per-college settings such as the serviceable radius and delivery fee.

U5 — Super administrator. Creates college tenants and manages administrator accounts.

2.4 Operating Environment
Client: Android 10 and above, iOS 15 and above, and modern desktop browsers (Chrome, Edge, Firefox, Safari) for the shop and admin consoles.
Server: a Linux host with an application runtime, a relational database (PostgreSQL recommended for its geospatial support), and an object store.
Network: the system shall function over 4G and campus Wi-Fi, and shall degrade gracefully on intermittent connectivity.
2.5 Design and Implementation Constraints
C-1. All data access shall be scoped by college_id. No query may return records belonging to another tenant.
C-2. Distance validation between a shop and a college shall use geodesic distance computed from stored coordinates, not road distance.
C-3. Identity documents shall be stored encrypted at rest and shall never be exposed through any student- or shop-facing endpoint.
C-4. The delivery fee, serviceable radius, and broadcast timeout shall be configuration values per college, not hard-coded constants.
C-5. For the academic release, payment is cash-on-delivery or an internal simulated wallet; no live payment gateway is integrated.
2.6 Assumptions and Dependencies
Students possess a valid college identity card and an institutional or personal email and mobile number.
Each college tenant has at least one administrator available to process verification requests.
Geocoding of shop addresses depends on an external mapping service.
SMS or push delivery for OTP and notifications depends on an external provider.
3. External Interface Requirements
3.1 User Interfaces
UI-1. The student app shall present a bottom navigation with Home (shops), Orders, Work, Chat, and Community.
UI-2. The work mode toggle shall be visible on the Work tab and shall display current status, today’s earnings, and completed tasks.
UI-3. Incoming task offers shall appear as a full-width card with pickup point, drop point, fee, and a countdown timer.
UI-4. The shop dashboard shall present incoming orders in a single queue with Accept and Reject actions and an audible alert on arrival.
UI-5. The admin console shall present verification queues as tabbed lists with document preview, Approve, and Reject with reason.
UI-6. All screens shall support English, with the text layer externalised to permit later localisation.
3.2 Hardware Interfaces
HI-1. The student app shall request location permission to determine proximity for task eligibility.
HI-2. The app shall use the device camera for document capture and for scanning the handover OTP if a QR variant is implemented.
3.3 Software Interfaces
SI-1. Geocoding service — converts a shop address to latitude and longitude.
SI-2. Push notification service — delivers task broadcasts and chat messages.
SI-3. SMS or email service — delivers OTP for account verification.
SI-4. Object storage — stores verification documents and catalog images.
3.4 Communication Interfaces
CI-1. All client-server traffic shall use HTTPS with TLS 1.2 or higher.
CI-2. Task dispatch and chat shall use a persistent WebSocket connection with automatic reconnection and offline message queueing.
4. Functional Requirements — Tenancy, Authentication, and Student Verification
4.1 College Tenancy
FR-TEN-01. A super administrator shall create a college tenant with a name, address, latitude and longitude, serviceable radius (default 3 km), and contact details.
FR-TEN-02. Every student, shop, order, task, chat room, and community post shall belong to exactly one college tenant.
FR-TEN-03. The system shall reject any request in which the authenticated user’s college_id differs from that of the requested resource, returning an authorisation error.
FR-TEN-04. An administrator shall be able to adjust the serviceable radius for their college within a permitted range of 1 km to 5 km.
FR-TEN-05. Shops already approved under a previous radius shall remain active when the radius is reduced, but shall be flagged for administrator review.
4.2 Registration and Authentication
FR-AUTH-01. A student shall register by providing full name, mobile number, email address, password, and by selecting their college from a searchable list of active tenants.
FR-AUTH-02. The system shall verify the mobile number by OTP before the registration is submitted.
FR-AUTH-03. Where a college has registered an email domain, the system shall accept only addresses on that domain and shall verify the address by emailed link.
FR-AUTH-04. The system shall reject registration where the mobile number or email is already associated with an active account.
FR-AUTH-05. Authentication shall issue a signed access token with a limited lifetime and a refresh token, and shall support logout and session revocation on all devices.
FR-AUTH-06. The system shall lock an account for a configurable period after five consecutive failed authentication attempts.
FR-AUTH-07. The system shall support password reset through an OTP sent to the verified mobile number.
4.3 Student Identity Verification
FR-SVER-01. After registration a student account shall hold the status PENDING_VERIFICATION and shall have read-only access to shop catalogs; it shall not be able to place orders, enable work mode, or post to the community.
FR-SVER-02. The student shall submit for verification: college roll or enrolment number, department and year of study, a photograph of the front of their college identity card, and a government identity document as specified in Section 11.
FR-SVER-03. The system shall validate that each uploaded image is legible, under the configured file-size limit, and in an accepted format before acceptance.
FR-SVER-04. Submitted documents shall enter the administrator’s student verification queue for the student’s college only.
FR-SVER-05. An administrator shall be able to approve a submission, setting status to VERIFIED, or reject it with a mandatory reason selected from a controlled list plus optional free text.
FR-SVER-06. On rejection the student shall be notified with the reason and shall be permitted to resubmit. The system shall limit a student to three submissions in any seven-day period.
FR-SVER-07. A verified student shall gain full access to ordering, work mode, chat, and community features.
FR-SVER-08. An administrator shall be able to suspend a verified student, immediately terminating active sessions, cancelling any in-flight task assignment, and disabling work mode.
FR-SVER-09. The system shall record an immutable audit entry for every verification decision, capturing the administrator, timestamp, decision, and reason.
4.4 Work Mode
FR-WM-01. Only a student with status VERIFIED and no active disciplinary suspension shall be able to enable work mode.
FR-WM-02. Enabling work mode shall require the student to accept the rider terms of service on first use, with acceptance recorded with a timestamp and version.
FR-WM-03. While work mode is enabled, the student’s device shall report its coarse location to the dispatcher at a configurable interval.
FR-WM-04. A student in work mode shall be eligible to receive task broadcasts for their college only.
FR-WM-05. A student shall be able to disable work mode at any time; disabling shall take effect immediately for new broadcasts but shall not cancel a task already accepted.
FR-WM-06. The system shall automatically disable work mode after a configurable period of inactivity (default 2 hours without a location report or an accepted task).
FR-WM-07. A student shall hold at most one active task at a time in the initial release. Students already holding an active task shall be excluded from new broadcasts.
FR-WM-08. The Work tab shall display lifetime and current-day totals for completed tasks, earnings, and acceptance rate.
5. Functional Requirements — Shop Registration and Catalog
5.1 Shop Registration
FR-SHOP-01. A shop owner shall register by providing shop name, category, owner name, mobile number, email address, and full address.
FR-SHOP-02. The owner shall select the college to which the shop wishes to be attached, from the list of active tenants.
FR-SHOP-03. The owner shall declare the shop’s location type as either ON_CAMPUS or OFF_CAMPUS.
FR-SHOP-04. The system shall determine the shop’s coordinates by geocoding the submitted address, and shall allow the owner to correct the pin by dragging it on a map.
FR-SHOP-05. The system shall compute the geodesic distance between the shop coordinates and the selected college coordinates.
FR-SHOP-06. Where the computed distance exceeds the college’s serviceable radius, the system shall reject the registration and display the measured distance and the permitted limit.
FR-SHOP-07. A shop declared ON_CAMPUS shall additionally require a letter or permit from the college authority as supporting proof.
FR-SHOP-08. The owner shall upload supporting documents: shop establishment licence or registration certificate, GSTIN certificate where applicable, owner government photo identity, and at least one photograph of the shop frontage showing the signboard.
FR-SHOP-09. A newly registered shop shall hold status PENDING_VERIFICATION and shall not be visible to students.
FR-SHOP-10. Submitted shops shall enter the administrator’s shop verification queue, displaying the distance computation, the map pin, and all uploaded documents.
FR-SHOP-11. An administrator shall be able to approve a shop, setting status to ACTIVE, or reject it with a mandatory reason.
FR-SHOP-12. An administrator shall be able to suspend an active shop, which shall immediately hide it from students and block new orders while permitting in-flight orders to complete.
FR-SHOP-13. A single shop may attach to more than one college where it lies within the radius of each, but shall maintain a separate catalog and order queue per college.
5.2 Catalog Management
FR-CAT-01. An active shop shall be able to create, edit, and delete catalog categories.
FR-CAT-02. An active shop shall be able to create a catalog item with name, description, price, category, preparation time, and an optional image.
FR-CAT-03. A shop shall be able to mark an item as available or unavailable without deleting it.
FR-CAT-04. A shop shall be able to define its operating hours per day of the week, and shall be able to set a temporary closure with an expected reopening time.
FR-CAT-05. A shop outside its operating hours or temporarily closed shall be displayed to students as closed and shall not accept orders.
FR-CAT-06. Students shall be able to browse shops filtered by category and sorted by distance, rating, or preparation time, and shall be able to search catalog items by name across all active shops in their college.
6. Functional Requirements — Ordering and Delivery
6.1 Order Placement
FR-ORD-01. A verified student shall be able to add available items from a single shop to a cart. The system shall not permit items from two shops in one cart.
FR-ORD-02. The student shall select a delivery point from campus locations configured by the administrator (hostel blocks, departments, library, gates) or enter a free-text landmark.
FR-ORD-03. The system shall display an order summary showing item subtotal, delivery fee, platform fee if configured, and total, before confirmation.
FR-ORD-04. On confirmation the system shall create an order with status PLACED and notify the shop.
FR-ORD-05. The student shall be able to cancel an order without charge while its status is PLACED or SHOP_ACCEPTED, and shall not be able to cancel once status is PREPARING or later.
FR-ORD-06. The system shall create, alongside the order, a delivery task of type SHOP_ORDER in status CREATED.
6.2 Other Task Types
FR-ORD-07. A verified student shall be able to create a task of type PARCEL_PICKUP by specifying a pickup point, a drop point, a description of the parcel, and any collection reference.
FR-ORD-08. A verified student shall be able to create a task of type PEER_ERRAND by specifying a pickup point, a drop point, a description, and a declared reimbursement amount.
FR-ORD-09. Tasks of type PARCEL_PICKUP and PEER_ERRAND shall carry no shop association and shall proceed directly to broadcast.
FR-ORD-10. The delivery fee for all task types shall be computed from the college’s configured base fee and distance band, and shall be shown to the requester before confirmation.
6.3 Shop Order Handling
FR-SHP-01. The shop dashboard shall display incoming orders in arrival order with an audible and visual alert.
FR-SHP-02. The shop shall accept or reject an order within a configurable window (default 5 minutes). A shop may adjust the stated preparation time on acceptance.
FR-SHP-03. On acceptance the order status shall become SHOP_ACCEPTED and then PREPARING, and the requester shall be notified with the expected ready time.
FR-SHP-04. On rejection, or on expiry of the acceptance window, the order shall be cancelled, the requester notified with the reason, and any held wallet amount released.
FR-SHP-05. The shop shall mark the order READY when the items are packed.
FR-SHP-06. The shop shall confirm handover to the rider, moving the order to PICKED_UP.
6.4 Dispatch and Rider Assignment
FR-DLV-01. For a SHOP_ORDER task, the dispatcher shall broadcast when the order enters PREPARING and the stated preparation time falls below the configured lead threshold, so that the rider arrives close to the ready time. For other task types it shall broadcast immediately on creation.
FR-DLV-02. The dispatcher shall select eligible riders as those students who are, at the moment of broadcast: in the same college tenant, verified and not suspended, in work mode, holding no active task, and within the configured proximity of the pickup point.
FR-DLV-03. The task offer shall be delivered to all eligible riders simultaneously and shall display pickup point, drop point, task type, fee, and a countdown of the acceptance window (default 60 seconds).
FR-DLV-04. The first rider to accept shall be assigned the task. The system shall guarantee that exactly one rider is assigned, using a conditional update or equivalent concurrency control, and shall return a clear “already taken” response to any later acceptance.
FR-DLV-05. On assignment the offer shall be withdrawn from all other riders’ devices.
FR-DLV-06. Where no rider accepts within the acceptance window, the dispatcher shall re-broadcast, widening the proximity radius and increasing the fee by the configured increment, for up to a configured number of rounds (default 3).
FR-DLV-07. Where all broadcast rounds are exhausted, the system shall notify the requester and the shop, and shall offer the requester the choice to continue waiting, to collect in person, or to cancel with a full refund.
FR-DLV-08. An assigned rider shall be able to abandon a task before pickup. The task shall return to broadcast and the abandonment shall be recorded against the rider’s reliability metric.
FR-DLV-09. The system shall record timestamps for broadcast, assignment, pickup, and delivery, for operational reporting.
6.5 Handover and Completion
FR-DLV-10. On assignment the system shall open a task chat room containing the requester and the rider, and additionally the shop for SHOP_ORDER tasks.
FR-DLV-11. The rider shall mark PICKED_UP only after the shop confirms handover, or, for non-shop tasks, after self-confirmation with an optional photograph.
FR-DLV-12. The system shall generate a six-digit handover OTP on pickup and display it to the requester only.
FR-DLV-13. The rider shall enter the OTP at the drop point to complete delivery. The task status shall become DELIVERED and then COMPLETED.
FR-DLV-14. The system shall permit at most five OTP attempts, after which the task shall be escalated to the administrator for manual resolution.
FR-DLV-15. On completion the system shall credit the delivery fee to the rider’s wallet and shall close the task chat room to new messages while retaining history for the configured retention period.
FR-DLV-16. Both the requester and the rider shall be prompted to submit a rating, which shall be optional and skippable.
7. Functional Requirements — Chat and Community
7.1 Messaging
FR-CHAT-01. The system shall provide a single messaging engine supporting rooms of three kinds: task rooms created automatically by dispatch, direct rooms between two students, and group rooms created by students.
FR-CHAT-02. Messages shall support plain text, images, and document attachments up to the configured size limit.
FR-CHAT-03. The system shall display per-message delivery state as sent, delivered, and read.
FR-CHAT-04. Messages composed while offline shall be queued locally and transmitted on reconnection, preserving order.
FR-CHAT-05. Direct and group rooms shall be restricted to members of the same college tenant.
FR-CHAT-06. A student shall be able to create a group room with a name, an optional description, and an initial member list, and shall act as its administrator with the ability to add and remove members.
FR-CHAT-07. A student shall be able to block another student, suppressing direct messages from them, and shall be able to report a user or a message to the administrator with a reason.
FR-CHAT-08. Task rooms shall be archived on task completion and shall not accept new messages. The parties shall retain read access.
FR-CHAT-09. An administrator shall be able to view a reported conversation for the purpose of dispute resolution, with the access recorded in the audit log.
7.2 Community Board
FR-COMM-01. A verified student shall be able to publish a post with a title, body, category, optional attachments, and optional external link.
FR-COMM-02. The system shall support the post categories: Notes and resources, Internships and jobs, Lost and found, Buy and sell, Announcements, and General.
FR-COMM-03. Posts shall be visible only to members of the author’s college tenant.
FR-COMM-04. Students shall be able to comment on posts, to upvote posts, and to save posts to a personal list.
FR-COMM-05. The feed shall support filtering by category and sorting by recency or upvote count, and shall support keyword search across titles and bodies.
FR-COMM-06. An author shall be able to edit or delete their own post. Edited posts shall display an edited marker.
FR-COMM-07. Any student shall be able to report a post or comment. Content reaching a configured report threshold shall be hidden pending administrator review.
FR-COMM-08. An administrator shall be able to remove content, to pin a post to the top of the feed, and to publish announcements attributed to the college.
8. Functional Requirements — Payments, Trust, Administration, Notifications
8.1 Payments and Wallet
FR-PAY-01. The system shall support cash-on-delivery as the default payment method for the academic release.
FR-PAY-02. The system shall maintain an internal wallet balance for each student, recording every credit and debit as an immutable ledger entry with type, amount, counterparty, and reference to the related task.
FR-PAY-03. Delivery fees earned by a rider shall be credited to the rider’s wallet on task completion.
FR-PAY-04. A student shall be able to view a chronological wallet statement with running balance and shall be able to filter it by date range.
FR-PAY-05. A student shall be able to raise a withdrawal request once the balance exceeds the configured minimum. Withdrawals shall be settled manually by the administrator outside the system in this release, with the administrator marking the request as paid.
FR-PAY-06. Where a wallet payment method is used, the order amount shall be held on placement and either captured on completion or released on cancellation.
FR-PAY-07. All monetary values shall be stored as integer minor units to avoid floating-point error.
8.2 Ratings and Trust
FR-TRST-01. After each completed task the requester may rate the rider, and the rider may rate the requester, on a one-to-five scale with optional comment.
FR-TRST-02. The system shall display a rider’s average rating and completed-task count on the task offer and in the task chat.
FR-TRST-03. The system shall compute a reliability metric per rider from acceptance rate, abandonment rate, and average delivery time.
FR-TRST-04. A rider whose rating falls below a configured threshold over a configured minimum number of tasks shall be flagged for administrator review.
FR-TRST-05. A rider shall be automatically barred from work mode for a configurable period after a configured number of abandonments within a rolling window.
FR-TRST-06. Ratings shall not be visible to the rated party as individually attributable; only aggregates shall be shown.
8.3 Administration
FR-ADM-01. The administrator console shall present separate queues for pending student verifications, pending shop verifications, reported content, reported users, escalated tasks, and withdrawal requests.
FR-ADM-02. Each queue item shall display all information required for a decision without navigation to another screen.
FR-ADM-03. The administrator shall be able to configure, per college: serviceable radius, base delivery fee and distance bands, fee increment per re-broadcast round, acceptance window, number of broadcast rounds, work-mode inactivity timeout, and the list of campus delivery points.
FR-ADM-04. The administrator shall be able to resolve an escalated task by marking it delivered, cancelled with refund, or disputed, with a mandatory note.
FR-ADM-05. The console shall present an operational dashboard showing, for a selected date range: orders placed, completion rate, average time from placement to delivery, average time to rider acceptance, number of unfulfilled broadcasts, active riders by hour, and revenue by shop.
FR-ADM-06. Every administrative action affecting a user, shop, order, or wallet shall be recorded in an append-only audit log.
FR-ADM-07. A super administrator shall be able to create and deactivate college tenants and to assign administrators to them.
8.4 Notifications
FR-NOTF-01. The system shall send a push notification for: verification approved or rejected, order accepted or rejected by shop, order ready, rider assigned, rider arrived, delivery completed, new task offer, and new chat message.
FR-NOTF-02. Task offer notifications shall be high priority and shall be capable of alerting a device with the screen locked.
FR-NOTF-03. A student shall be able to configure notification preferences by category, except that task offers cannot be disabled while work mode is on.
FR-NOTF-04. Where a push notification cannot be delivered, the system shall fall back to SMS for order and verification events only.
9. Data Model
9.1 Principal Entities
Entity	Key attributes
college	id, name, address, latitude, longitude, serviceable_radius_m, email_domain, status
user	id, college_id, role, name, mobile, email, password_hash, status, created_at
student_profile	user_id, roll_number, department, year, id_card_url, govt_id_ref, verification_status, verified_by, verified_at
rider_state	user_id, work_mode_on, last_lat, last_lng, last_ping_at, active_task_id
shop	id, college_id, name, category, owner_name, address, latitude, longitude, distance_from_college_m, location_type, status
shop_document	id, shop_id, doc_type, file_url, uploaded_at
shop_hours	shop_id, day_of_week, open_time, close_time
catalog_item	id, shop_id, name, description, price_minor, category, prep_minutes, image_url, is_available
order	id, college_id, student_id, shop_id, status, items_subtotal_minor, delivery_fee_minor, total_minor, payment_method, drop_point, placed_at
order_item	id, order_id, catalog_item_id, name_snapshot, unit_price_minor, quantity
task	id, college_id, type, order_id (nullable), requester_id, rider_id (nullable), status, pickup_point, drop_point, fee_minor, broadcast_round, otp_hash, created_at, assigned_at, picked_up_at, delivered_at
broadcast_log	id, task_id, round, radius_m, fee_minor, eligible_count, sent_at, outcome
chat_room	id, college_id, type, task_id (nullable), name, created_by, is_archived
chat_member	room_id, user_id, joined_at, last_read_message_id
message	id, room_id, sender_id, body, attachment_url, sent_at
post	id, college_id, author_id, category, title, body, attachment_url, link_url, upvote_count, status, created_at
comment	id, post_id, author_id, body, created_at
wallet_entry	id, user_id, direction, amount_minor, type, task_id, balance_after_minor, created_at
rating	id, task_id, rater_id, ratee_id, score, comment, created_at
report	id, reporter_id, target_type, target_id, reason, status, created_at
audit_log	id, actor_id, action, target_type, target_id, detail, created_at
9.2 Key Relationships
college 1 — N user, shop, order, task, post
user 1 — 1 student_profile, 1 — 1 rider_state
shop 1 — N catalog_item, shop_document, shop_hours, order
order 1 — N order_item, and 1 — 1 task where the task type is SHOP_ORDER
task 1 — N broadcast_log, 1 — 1 chat_room of type task, 1 — N rating
chat_room 1 — N chat_member, message
post 1 — N comment
user 1 — N wallet_entry
9.3 Indexing Notes

Composite indexes on (college_id, status) for order, task, and shop; a geospatial index on rider_state(last_lat, last_lng) to support proximity selection at broadcast; an index on task(status, college_id) for the dispatcher poll; and an index on message(room_id, sent_at) for chat paging.

10. Non-Functional Requirements
10.1 Performance
NFR-P-01. Catalog browse and search responses shall complete within 2 seconds at the 95th percentile under normal load.
NFR-P-02. A task broadcast shall reach eligible rider devices within 3 seconds of dispatch.
NFR-P-03. Rider acceptance shall be acknowledged within 1 second, and the offer withdrawn from other devices within 2 seconds.
NFR-P-04. A chat message shall be delivered to an online recipient within 1 second.
NFR-P-05. The system shall support 500 concurrent active users and 50 concurrent orders per college tenant without degradation beyond the stated limits.
10.2 Security
NFR-S-01. All traffic shall be encrypted in transit using TLS 1.2 or higher.
NFR-S-02. Passwords shall be stored using a memory-hard hashing algorithm with a per-user salt.
NFR-S-03. Identity documents shall be encrypted at rest and shall be retrievable only through authenticated administrator endpoints, with every access logged.
NFR-S-04. OTP values shall be stored hashed, shall expire after a configured period, and shall be single-use.
NFR-S-05. Authorisation shall be enforced server-side on every endpoint; the client shall never be trusted to scope data by college or by role.
NFR-S-06. The system shall apply rate limiting to authentication, OTP issue, and task acceptance endpoints.
NFR-S-07. All user-supplied input shall be validated and encoded on output to prevent injection and cross-site scripting.
10.3 Reliability and Availability
NFR-R-01. The system shall target 99 percent availability during college operating hours.
NFR-R-02. No task shall be assignable to more than one rider under any concurrency condition.
NFR-R-03. Wallet ledger entries shall be written within the same transaction as the task completion that causes them.
NFR-R-04. The database shall be backed up daily with a recovery point objective of 24 hours.
NFR-R-05. A dropped WebSocket connection shall reconnect automatically with exponential backoff and shall resynchronise missed task offers and messages.
10.4 Usability
NFR-U-01. A first-time student shall be able to complete registration and verification submission in under 5 minutes.
NFR-U-02. A shop shall be able to accept an order in no more than two taps from the alert.
NFR-U-03. A rider shall be able to accept a task offer in a single tap.
NFR-U-04. Interactive elements shall meet a minimum touch target of 44 by 44 pixels, and text shall meet a contrast ratio of at least 4.5 to 1.
NFR-U-05. Every error message shall state what went wrong and what the user can do next.
10.5 Maintainability and Portability
NFR-M-01. Business rules expressed as thresholds, fees, radii, and timeouts shall reside in configuration, not in code.
NFR-M-02. The codebase shall maintain a documented API contract, and backward-incompatible API changes shall be versioned.
NFR-M-03. The server shall be deployable on any Linux host meeting the stated runtime and database versions, without dependence on a specific cloud provider.
11. Legal and Privacy Constraints
11.1 Government Identity Documents — Important Design Note

The requirement to collect Aadhaar as a student identity document carries legal and practical risk that should be settled before implementation.

Under the Aadhaar Act, 2016 and the regulations made under it, the collection, storage, and use of Aadhaar numbers by private entities is restricted, and storing the Aadhaar number or an image of the Aadhaar card in an application database is generally not permitted for a private party without an authorised use case. Separately, the Digital Personal Data Protection Act, 2023 imposes duties of purpose limitation, minimisation, security, and breach notification on anyone holding personal data of this kind. A student project that stores a database of Aadhaar card images is holding a high-value target with no legal basis for holding it.

This document is not legal advice, and the project team should raise the point with the project guide. The recommended design is:

FR-ID-01 (recommended). The system shall verify student identity using the college identity card together with a verified mobile number and, where available, a verified institutional email address. This is sufficient to establish that the person belongs to the college, which is the actual requirement.
FR-ID-02 (recommended). Where a secondary government identity document is required by the college for riders handling cash or goods, the system shall accept any one of a driving licence, voter identity card, or passport, and shall store only the document type, the last four characters of the document number, and a verification decision — never the full number or the image.
FR-ID-03 (alternative, if Aadhaar is mandated). Where the college mandates Aadhaar, the system shall accept only a masked Aadhaar image in which the first eight digits are obscured, shall store only the last four digits and the verification decision, shall delete the uploaded image within 24 hours of the administrator’s decision, and shall record the student’s explicit consent with timestamp and purpose statement.
11.2 General Privacy Requirements
FR-PRIV-01. The system shall present a privacy notice at registration stating what data is collected, the purpose, the retention period, and the contact point for grievances.
FR-PRIV-02. A rider’s precise location shall be visible only to the requester of their current task and only between assignment and delivery.
FR-PRIV-03. A student’s mobile number shall not be exposed to other students; contact between the parties to a task shall take place through in-app chat or a masked calling facility.
FR-PRIV-04. Verification documents shall be deleted after the configured retention period following account closure, and in any case within the period stated in the privacy notice.
FR-PRIV-05. A student shall be able to request export of their personal data and deletion of their account, subject to retention of transaction records required for settlement and dispute resolution.
12. Assumptions, Dependencies, Exclusions, and Phasing
12.1 Exclusions

The following are explicitly outside the scope of this release: integration with a live payment gateway; automated settlement to shop or student bank accounts; turn-by-turn navigation; scheduled, recurring, or group orders; multi-rider batched deliveries; cross-college ordering; and any public, non-student access.

12.2 Release Phasing

Phase 1 — Core delivery. College tenancy, registration and authentication, student verification, shop registration with radius validation, catalog, order placement, dispatch and first-accept assignment, OTP handover, cash payment, basic admin queues. This phase alone constitutes a complete, demonstrable system.

Phase 2 — Communication and trust. Chat engine with task rooms, direct messages, and groups; ratings and reliability metrics; wallet ledger and withdrawal requests; notification preferences.

Phase 3 — Community and breadth. Community board with all categories; parcel pickup and peer errand task types; reporting and moderation; operational analytics dashboard.

12.3 Acceptance Criteria for Phase 1

A build is accepted for Phase 1 when a tester can, in a single session: register a student, be verified by an administrator, register and verify a shop at a known address within the radius and observe rejection of one outside it, place an order from that shop, have the shop accept and mark it ready, observe the broadcast reach a second student in work mode, accept it from that second device, complete handover with OTP, and see the fee reflected in the rider’s wallet and the order in the administrator’s report.

13. Appendices
Appendix A — Task State Machine
From	Event	To
CREATED	Shop accepts and lead time reached, or non-shop task created	BROADCASTING
BROADCASTING	Rider accepts	ASSIGNED
BROADCASTING	Window expires, rounds remain	BROADCASTING (round + 1)
BROADCASTING	All rounds exhausted	UNFULFILLED
ASSIGNED	Rider abandons	BROADCASTING
ASSIGNED	Pickup confirmed	PICKED_UP
PICKED_UP	Valid OTP entered	DELIVERED
PICKED_UP	OTP attempts exhausted	ESCALATED
DELIVERED	Settlement written	COMPLETED
CREATED, BROADCASTING	Requester or shop cancels	CANCELLED
ESCALATED	Administrator resolves	COMPLETED or CANCELLED
Appendix B — Use Case Summary
ID	Use case	Primary actor
UC-01	Register and submit for verification	Student
UC-02	Verify student	Administrator
UC-03	Register shop with radius validation	Shop owner
UC-04	Verify shop	Administrator
UC-05	Manage catalog	Shop owner
UC-06	Place order	Student (customer)
UC-07	Accept and prepare order	Shop owner
UC-08	Enable work mode	Student (rider)
UC-09	Accept task offer	Student (rider)
UC-10	Complete delivery with OTP	Student (rider)
UC-11	Message counterparty	All
UC-12	Publish community post	Student
UC-13	Withdraw wallet balance	Student (rider)
UC-14	Resolve escalated task	Administrator
UC-15	Configure college parameters	Administrator
Appendix C — Traceability

Each functional requirement identifier in Sections 4 to 8 shall be referenced in the design document, in at least one test case, and in the test report, so that coverage can be demonstrated at evaluation. The identifier prefixes are: TEN (tenancy), AUTH (authentication), SVER (student verification), WM (work mode), SHOP (shop registration), CAT (catalog), ORD (ordering), SHP (shop order handling), DLV (dispatch and delivery), CHAT (messaging), COMM (community), PAY (payments), TRST (trust), ADM (administration), NOTF (notifications), ID (identity documents), PRIV (privacy).

Two things worth your attention before you build: the Aadhaar point in Section 11 is the one I’d raise with your guide first, because the simpler design is also the safer one and costs you nothing in marks. And the concurrency rule in FR-DLV-04 is where most projects like this break during the demo — two riders tapping accept at the same instant. Solve it with a conditional database update, not with application-level checking.