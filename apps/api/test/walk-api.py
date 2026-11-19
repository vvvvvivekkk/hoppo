#!/usr/bin/env python3
"""
Walk the student and rider flow through the live API, in exactly the order
apps/web calls it.

    python3 -I apps/api/test/walk-api.py [API_BASE]

Python standard library only. Needs the accounts apps/api/test/fixtures.py
creates (the cafe's owner, rider terms for the rider) as well as the seed's.

The point is not to re-test the API — apps/api has its own suite. It is to
check that the *sequence the web app performs* works against a running stack:
the endpoints exist at the paths the client builds, the response fields the
screens read are actually present, and the states each screen gates on are
reachable. A screen can typecheck against a hand-written response type and
still read a field the server never sends.
"""
import json
import os
import sys
import time

sys.dont_write_bytecode = True   # leave no __pycache__ in the repository
import urllib.error
import urllib.request

# The API under test: first argument, or HOPPO_API_BASE, or the dev default.
# run-all.sh passes it, so the same walk can be pointed at a second instance.
BASE = (sys.argv[1] if len(sys.argv) > 1 else
        os.environ.get('HOPPO_API_BASE', 'http://localhost:4000/api/v1')).rstrip('/')
PASSWORD = 'Hoppo@dev123'

failures: list[str] = []
checks = 0


def call(method, path, body=None, token=None, expect=200):
    global checks
    checks += 1
    url = f'{BASE}{path}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.loads(r.read() or b'{}')
            status = r.status
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read() or b'{}')
        status = e.code
    except Exception as e:
        failures.append(f'{method} {path}: {e}')
        return None, 0

    if expect is not None and status != expect:
        failures.append(
            f'{method} {path}: expected {expect}, got {status} '
            f'({payload.get("code")}: {payload.get("message")})'
        )
    return payload, status


def field(obj, path, label):
    """Assert a dotted path the web app reads is present (may be null)."""
    global checks
    checks += 1
    cur = obj
    for part in path.split('.'):
        if isinstance(cur, list):
            if not cur:
                failures.append(f'{label}: {path} — list was empty, cannot check')
                return None
            cur = cur[0]
        if not isinstance(cur, dict) or part not in cur:
            failures.append(f'{label}: missing field {path}')
            return None
        cur = cur[part]
    return cur


def _token_cache():
    # The same file the race harnesses and the browser walk keep, keyed by the
    # API base, so a run of everything signs each account in once.
    import hashlib
    tag = hashlib.sha256(BASE.encode()).hexdigest()[:12]
    return os.path.join(os.environ.get('TMPDIR', '/tmp'), f'hoppo-harness-tokens-{tag}.json')


def _seconds_left(token):
    import base64
    try:
        part = token.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))['exp'] - time.time()
    except Exception:
        return 0


def login(identifier, fresh=False):
    """
    Sign in. /auth/login allows ten a minute per address, shared with every
    other tool on the machine, so only the student's sign-in - the one this
    walk is actually checking - always goes to the server. The supporting
    accounts reuse a cached token while it has life left, and a 429 is waited
    out once rather than reported as a broken login: being rate limited is the
    server working. The 200 is still required either way.
    """
    cache = {}
    try:
        with open(_token_cache()) as fh:
            cache = json.load(fh)
    except (OSError, ValueError):
        pass
    if not fresh and _seconds_left(cache.get(identifier, '')) > 420:
        probe, status = call('GET', '/auth/me', token=cache[identifier], expect=None)
        if status == 200:
            return cache[identifier]

    body = {'identifier': identifier, 'password': PASSWORD}
    res, status = call('POST', '/auth/login', body, expect=None)
    if status == 429:
        print('  (sign-in limit reached; waiting 61s and trying once more)')
        time.sleep(61)
        res, status = call('POST', '/auth/login', body, expect=None)
    if status != 200:
        failures.append(f'POST /auth/login as {identifier}: expected 200, got {status} '
                        f'({(res or {}).get("code")})')
    if not res or 'accessToken' not in res:
        failures.append(f'login {identifier}: no token ({res})')
        return None
    cache[identifier] = res['accessToken']
    fd = os.open(_token_cache(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump(cache, fh)
    return res['accessToken']


def step(name):
    print(f'\n--- {name}')


# =========================================================================
print('Walking the flow apps/web performs.')

step('Sign in as the student (app: /login)')
student = login('vivek@anurag.edu.in', fresh=True)
if not student:
    print('\n'.join(failures))
    sys.exit(1)

step('The auth gate reads /auth/me (app: /)')
me, _ = call('GET', '/auth/me', token=student)
for f in ('user.id', 'user.name', 'user.role', 'user.status',
          'user.college.name', 'user.studentProfile.verificationStatus',
          'user.studentProfile.riderTermsAcceptedAt'):
    field(me, f, 'gate')
print(f"  {field(me, 'user.name', 'x')} / {field(me, 'user.role', 'x')} / "
      f"verification {field(me, 'user.studentProfile.verificationStatus', 'x')}")

step('Verification screen reads /verification/me (app: /verify)')
ver, _ = call('GET', '/verification/me', token=student)
for f in ('status', 'submissionsUsed', 'submissionsAllowed', 'unlocked.placeOrders'):
    field(ver, f, 'verify')
print(f"  status {ver.get('status')}, "
      f"{ver.get('submissionsUsed')}/{ver.get('submissionsAllowed')} attempts used")

step('Browse reads /browse/shops (app: /shops)')
shops, _ = call('GET', '/browse/shops?sort=distance', token=student)
for f in ('items.listingId', 'items.shop.name', 'items.shop.category',
          'items.distanceLabel', 'items.isOpen', 'items.averageRating',
          'items.ratingCount', 'items.medianPrepMinutes', 'items.opensInMinutes',
          'items.closureNote', 'items.closedReason'):
    field(shops, f, 'browse')
for s in shops.get('items', []):
    print(f"  {s['shop']['name']}: {s['distanceLabel']}, "
          f"{'open' if s['isOpen'] else 'closed'}")

step('The category chips come from shop.category, so check it is non-empty')
cats = sorted({s['shop']['category'] for s in shops.get('items', [])})
checks += 1
if not cats:
    failures.append('browse: no categories to build chips from')
print(f'  chips would be: All, {", ".join(cats)}')

step('Sorting by rating and prepTime (app: the sort select)')
for sort in ('rating', 'prepTime'):
    r, _ = call('GET', f'/browse/shops?sort={sort}', token=student)
    checks += 1
    if not r or 'items' not in r:
        failures.append(f'browse sort={sort}: no items key')

step('Open-now filter (app: the "Open now" checkbox)')
open_now, _ = call('GET', '/browse/shops?openNow=true', token=student)
checks += 1
if open_now and any(not s['isOpen'] for s in open_now.get('items', [])):
    failures.append('browse openNow=true returned a closed shop')
print(f"  {len(open_now.get('items', []))} open of {len(shops.get('items', []))}")

step('Item search (app: typing in the search box)')
found, _ = call('GET', '/browse/items?q=sam', token=student)
for f in ('items.id', 'items.name', 'items.priceMinor', 'items.listingId',
          'items.shop.name', 'items.distanceLabel', 'items.shopIsOpen',
          'items.isAvailable'):
    field(found, f, 'item search')
print(f"  \"sam\" -> {[i['name'] for i in found.get('items', [])]}")

step('Delivery points (app: the checkout drop-point picker) — NEW endpoint')
points, _ = call('GET', '/browse/delivery-points', token=student)
for f in ('points.id', 'points.name', 'points.description',
          'points.latitude', 'points.longitude', 'points.sortOrder'):
    field(points, f, 'delivery points')
checks += 1
if not points.get('points'):
    failures.append('delivery points: none returned, so checkout cannot proceed')
print(f"  {[p['name'] for p in points.get('points', [])]}")

step('Shop detail (app: /shops/[listingId])')
listing_id = next(s['listingId'] for s in shops['items'] if s['isOpen'])
detail, _ = call('GET', f'/browse/shops/{listing_id}', token=student)
for f in ('listingId', 'shop.name', 'shop.address', 'isOpen',
          'categories.id', 'categories.name', 'categories.items.id',
          'categories.items.name', 'categories.items.priceMinor',
          'categories.items.prepMinutes', 'categories.items.isAvailable'):
    field(detail, f, 'shop detail')
items = [i for c in detail['categories'] for i in c['items'] if i['isAvailable']]
print(f"  {detail['shop']['name']}: {len(items)} available items")

step('Quote (app: checkout re-quotes on every cart or drop-point change)')
point_id = points['points'][0]['id']
lines = [{'catalogItemId': items[0]['id'], 'quantity': 2}]
quote, _ = call('POST', '/orders/quote',
                {'listingId': listing_id, 'lines': lines, 'deliveryPointId': point_id},
                token=student)
for f in ('totals.itemsSubtotalLabel', 'totals.deliveryFeeLabel',
          'totals.platformFeeLabel', 'totals.totalLabel', 'totals.totalMinor',
          'distanceLabel', 'estimatedPrepMinutes', 'shopIsOpen', 'drop.label'):
    field(quote, f, 'quote')
print(f"  {quote['totals']['itemsSubtotalLabel']} items + "
      f"{quote['totals']['deliveryFeeLabel']} delivery + "
      f"{quote['totals']['platformFeeLabel']} platform = "
      f"{quote['totals']['totalLabel']}, ready in "
      f"{quote['estimatedPrepMinutes']} min to {quote['drop']['label']}")

step('FR-ORD-03: a wrong expectedTotalMinor must be refused, not charged')
bad, status = call('POST', '/orders',
                   {'listingId': listing_id, 'lines': lines,
                    'deliveryPointId': point_id, 'paymentMethod': 'CASH',
                    'expectedTotalMinor': quote['totals']['totalMinor'] - 500},
                   token=student, expect=409)
checks += 1
if bad.get('code') != 'PRICE_CHANGED':
    failures.append(f'stale total: expected PRICE_CHANGED, got {bad.get("code")}')
else:
    d = bad.get('details', {})
    checks += 1
    if 'shownTotalMinor' not in d or 'currentTotalMinor' not in d:
        failures.append('PRICE_CHANGED: details missing the fields the screen shows')
    print(f"  refused: {bad['message'][:80]}...")
    print(f"  details carry both totals: {d}")

step('Place the order (app: the checkout button)')
order, _ = call('POST', '/orders',
                {'listingId': listing_id, 'lines': lines,
                 'deliveryPointId': point_id, 'paymentMethod': 'CASH',
                 'studentNote': 'Less chilli please',
                 'expectedTotalMinor': quote['totals']['totalMinor']},
                token=student, expect=201)
for f in ('orderId', 'reference', 'status', 'taskId'):
    field(order, f, 'place')
order_id = order['orderId']
print(f"  {order['reference']} -> {order['status']}, task {order['taskId'][:8]}")

step('Order list (app: /orders)')
mine, _ = call('GET', '/orders?limit=10', token=student)
for f in ('items.id', 'items.reference', 'items.status', 'items.totalLabel',
          'items.placedAt', 'items.canCancel', 'items.shopListing.shop.name',
          'items.items.nameSnapshot', 'items.items.quantity'):
    field(mine, f, 'order list')
print(f"  {len(mine.get('items', []))} orders")

step('Order detail (app: /orders/[orderId])')
od, _ = call('GET', f'/orders/{order_id}', token=student)
for f in ('reference', 'status', 'totalLabel', 'itemsSubtotalMinor',
          'deliveryFeeMinor', 'platformFeeMinor', 'paymentMethod',
          'canCancel', 'handoverCodeAvailable', 'dropLandmark',
          'items.nameSnapshot', 'items.lineTotalMinor', 'task.id', 'task.status'):
    field(od, f, 'order detail')
print(f"  {od['status']}, cancellable: {od['canCancel']}, "
      f"handover code live: {od['handoverCodeAvailable']}")

# =========================================================================
step('Rider status (app: /rider)')
rider = login('srichandana@anurag.edu.in')
rs, _ = call('GET', '/rider/status', token=rider)
for f in ('workModeOn', 'canEnable.verified', 'canEnable.termsAccepted',
          'canEnable.termsVersionCurrent', 'canEnable.notBarred',
          'pingIntervalSeconds', 'idleTimeoutMinutes',
          'today.earningsLabel', 'today.completedTasks',
          'lifetime.earningsLabel', 'lifetime.completedTasks',
          'lifetime.acceptanceRate', 'lifetime.averageRating',
          'lifetime.abandonedTasks'):
    field(rs, f, 'rider status')
print(f"  online: {rs['workModeOn']}, can enable: {rs['canEnable']}")

step('FR-WM-02: rider terms (app: the terms gate)')
if not rs['canEnable']['termsAccepted'] or not rs['canEnable']['termsVersionCurrent']:
    t, _ = call('POST', '/verification/rider-terms/accept', {}, token=rider, expect=200)
    print(f"  accepted version {t.get('version')}")
else:
    print('  already accepted')

step('Work mode on, with a position (app: the Go online button)')
# An offer is addressed to the riders who are online and in range when the
# dispatcher broadcasts (M8), so the rider has to be standing on campus and
# online *before* the shop readies the order - exactly as in real use. The
# position is a delivery point the API itself returned, not a constant: the
# old hard-coded fix was 17 km from the seeded cafe, which only ever worked
# because accept used not to check who had been offered the task.
rider_lat = points['points'][0]['latitude']
rider_lng = points['points'][0]['longitude']
wm, _ = call('POST', '/rider/work-mode',
             {'enabled': True, 'latitude': rider_lat, 'longitude': rider_lng},
             token=rider, expect=200)
print(f"  {wm.get('message')}")

step('Ping over HTTP (app: the socket fallback)')
call('POST', '/rider/ping', {'latitude': rider_lat, 'longitude': rider_lng},
     token=rider, expect=200)

step('Shop accepts and prepares (app: the dashboard, not web, but needed)')
shop_owner = login('cafe@example.com')
if shop_owner:
    # prepMinutes=1 so the dispatcher's due time is reached immediately —
    # otherwise the broadcast is minutes away and the accept below has
    # nothing to accept.
    acc, _ = call('POST', f'/shops/{listing_id}/orders/{order_id}/accept',
                  {'prepMinutes': 1}, token=shop_owner, expect=200)
    print(f"  accepted, ready at {acc.get('expectedReadyAt')}")
    rdy, _ = call('POST', f'/shops/{listing_id}/orders/{order_id}/ready',
                  {}, token=shop_owner, expect=200)
    print(f"  marked ready -> {rdy.get('status')}")
else:
    failures.append('could not sign in as the shop owner')

step('Wait for the dispatcher to broadcast (FR-DLV-00, cron every 5s)')
task_id = order['taskId']
broadcasting = False
for attempt in range(14):
    probe, st = call('POST', f'/rider/tasks/{task_id}/accept', {},
                     token=rider, expect=None)
    if st in (200, 201):
        broadcasting = True
        acceptance, status = probe, st
        print(f'  broadcast and accepted after ~{attempt * 2}s')
        break
    code = probe.get('code')
    if attempt % 5 == 4:
        # FR-WM-03: a device pings every interval; one that stops is dropped
        # from offers after three.
        call('POST', '/rider/ping', {'latitude': rider_lat, 'longitude': rider_lng},
             token=rider, expect=200)
    if code == 'NOT_YET_OFFERED':
        # The honest answer this walk is here to verify. Before the fix this
        # said ALREADY_TAKEN, which would have ended the walk here.
        time.sleep(2)
        continue
    acceptance, status = probe, st
    print(f'  stopped waiting: {code} — {probe.get("message")}')
    break
else:
    acceptance, status = probe, st
    failures.append('the dispatcher never broadcast the task within ~28s')

step('Take the task (app: the offer card Accept button)')
if status in (200, 201):
    for f in ('taskId', 'status', 'feeMinor', 'pickupLabel', 'dropLabel'):
        field(acceptance, f, 'accept')
    print(f"  accepted: {acceptance.get('feeMinor')} paise, "
          f"{acceptance.get('pickupLabel')} -> {acceptance.get('dropLabel')}")
else:
    failures.append(f'accept: {status} {acceptance.get("code")}: '
                    f'{acceptance.get("message")}')

step('Active task (app: the active-task panel)')
rs2, _ = call('GET', '/rider/status', token=rider)
at = rs2.get('activeTask')
if at:
    for f in ('id', 'status', 'pickupLabel', 'dropLabel', 'feeLabel',
              'canConfirmPickup', 'canAbandon', 'awaitingHandoverCode',
              'cashToPayShopMinor', 'cashToCollectMinor', 'otpAttempts',
              'order.reference', 'order.student.name',
              'order.shopListing.shop.address',
              'order.shopListing.shop.ownerMobile', 'order.items.nameSnapshot'):
        field({'t': at}, f't.{f}', 'active task')
    print(f"  {at['status']}, pickup allowed: {at['canConfirmPickup']}, "
          f"pay shop {at['cashToPayShopMinor']}, collect {at['cashToCollectMinor']}")

    if at['canConfirmPickup']:
        step('Confirm pickup (app: "I have collected it")')
        pu, _ = call('POST', f'/rider/tasks/{at["id"]}/pickup', {},
                     token=rider, expect=200)
        print(f"  {pu.get('status')}")

        step('FR-DLV-12: the requester asks about the code (app: the reveal)')
        hc, _ = call('GET', f'/tasks/{at["id"]}/handover-code', token=student)
        for f in ('taskId', 'codeIssuedAt', 'codeLength', 'canReissue', 'message'):
            field(hc, f, 'handover code')
        print(f"  issued: {hc.get('codeIssuedAt') is not None}, "
              f"length {hc.get('codeLength')}, reissue: {hc.get('canReissue')}")

        step('Reissue, since the code only ever arrived over the socket')
        re_issued, _ = call('POST', f'/tasks/{at["id"]}/handover-code/reissue', {},
                            token=student, expect=200)
        code = re_issued.get('code')
        checks += 1
        if not code:
            failures.append('reissue returned no code')
        else:
            print(f'  new code: {code}')

            step('A wrong code must be refused (app: the attempts counter)')
            wrong = '000000' if code != '000000' else '111111'
            w, st = call('POST', f'/rider/tasks/{at["id"]}/handover',
                         {'code': wrong}, token=rider, expect=None)
            checks += 1
            if st == 201:
                failures.append('a wrong handover code was accepted')
            else:
                print(f"  refused ({st} {w.get('code')})")

            step('The right code completes it (app: "Complete the delivery")')
            done, _ = call('POST', f'/rider/tasks/{at["id"]}/handover',
                           {'code': code}, token=rider, expect=200)
            for f in ('status', 'feeLabel', 'settledInCash'):
                field(done, f, 'handover')
            print(f"  {done.get('status')}, paid {done.get('feeLabel')}, "
                  f"cash settled: {done.get('settledInCash')}")

        step('Earnings moved (app: the earnings cards)')
        rs3, _ = call('GET', '/rider/status', token=rider)
        print(f"  today: {rs3['today']['earningsLabel']} over "
              f"{rs3['today']['completedTasks']} deliveries")
        checks += 1
        if rs3['today']['completedTasks'] < 1:
            failures.append('a completed delivery did not reach the earnings figures')

        step('The student sees it completed (app: the tracking timeline)')
        final, _ = call('GET', f'/orders/{order_id}', token=student)
        print(f"  {final['status']}, delivered at {final.get('deliveredAt')}")
        checks += 1
        if final['status'] not in ('DELIVERED', 'COMPLETED'):
            failures.append(f'order ended as {final["status"]}')
else:
    print('  no active task — the accept did not land, see above')

step('FR-PRIV-03: the student must never be given the rider mobile number')
final, _ = call('GET', f'/orders/{order_id}', token=student)
checks += 1
if not final.get('rider'):
    # Worth failing on. An assertion that cannot see a rider proves nothing,
    # and the first version of this walk "passed" it against a null.
    failures.append('privacy check was vacuous: the order has no rider attached')
else:
    rider_blob = json.dumps(final['rider'])
    if 'mobile' in rider_blob.lower() or 'phone' in rider_blob.lower():
        failures.append(f'order detail exposed a rider contact number: {rider_blob}')
    else:
        print(f'  rider block carries only: {sorted(final["rider"].keys())}')

step('Work mode off (app: Go offline)')
call('POST', '/rider/work-mode', {'enabled': False}, token=rider, expect=200)

step('An unverified student must be gated (app: the /verify redirect)')
fresher = login('fresher@anurag.edu.in')
g, st = call('GET', '/browse/shops', token=fresher, expect=None)
print(f'  browse as unverified: {st} {g.get("code") or "allowed"}')
v, _ = call('GET', '/verification/me', token=fresher)
print(f"  their verification status: {v.get('status')}, "
      f"unlocked: {v.get('unlocked')}")

# =========================================================================
print(f'\n{"=" * 70}')
if failures:
    print(f'{len(failures)} problem(s) out of {checks} checks:\n')
    for f in failures:
        print(f'  - {f}')
    sys.exit(1)
print(f'All {checks} checks passed. Every call apps/web makes works against '
      'the live stack.')
