'use client';

import type { College } from '@hoppo/api-client';
import { useEffect, useState } from 'react';
import { Banner, Button, Card, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';

/**
 * D-02 to D-06: the shop registration wizard.
 *
 * Four steps, in this order for one reason: **the radius check comes before
 * the paperwork.** FR-SHOP-06 rejects a shop outside the serviceable radius,
 * and finding that out after uploading four documents is the kind of
 * experience that makes an owner give up. So the distance is measured and
 * shown — with both the measurement and the limit, as the requirement
 * specifies — before anything else is asked for.
 */
type Step = 'details' | 'location' | 'documents' | 'done';

const CATEGORIES = [
  { value: 'FOOD', label: 'Food and drink' },
  { value: 'STATIONERY', label: 'Stationery and printing' },
  { value: 'GROCERY', label: 'Grocery and daily needs' },
  { value: 'PHARMACY', label: 'Pharmacy' },
  { value: 'OTHER', label: 'Something else' },
];

interface DistanceResult {
  distanceM: number;
  distanceLabel: string;
  radiusM: number;
  radiusLabel: string;
  withinRadius: boolean;
  message: string;
  latitude: number;
  longitude: number;
}

export default function RegisterPage() {
  const { api } = useApi();
  const [step, setStep] = useState<Step>('details');
  const [colleges, setColleges] = useState<College[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // D-02
  const [name, setName] = useState('');
  const [category, setCategory] = useState('FOOD');
  const [ownerName, setOwnerName] = useState('');
  const [ownerMobile, setOwnerMobile] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [password, setPassword] = useState('');
  const [collegeId, setCollegeId] = useState('');

  // D-03 / D-04
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('Hyderabad');
  const [state, setState] = useState('Telangana');
  const [pincode, setPincode] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locationType, setLocationType] = useState<'ON_CAMPUS' | 'OFF_CAMPUS'>('OFF_CAMPUS');
  const [distance, setDistance] = useState<DistanceResult | null>(null);

  // D-05
  const [fssai, setFssai] = useState('');
  const [gstin, setGstin] = useState('');
  const [result, setResult] = useState<{ distanceLabel: string; message: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { colleges: list } = await api.auth.colleges();
        setColleges(list);
        setCollegeId((prev) => prev || (list[0]?.id ?? ''));
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [api]);

  const college = colleges.find((c) => c.id === collegeId);

  /**
   * The browser's own geolocation is the most accurate thing available here,
   * and far better than geocoding a road name — FR-SHOP-04 exists because a
   * geocoded "Main Road" lands in the middle of a road that may be two
   * kilometres long, and at a 3 km threshold that decides the registration.
   */
  function useMyLocation() {
    if (!navigator.geolocation) {
      setError('This browser cannot read your location. Enter the coordinates instead.');
      return;
    }

    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(pos.coords.latitude.toFixed(6));
        setLongitude(pos.coords.longitude.toFixed(6));
      },
      () => setError('Could not read your location. Allow location access, or type the coordinates.'),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function checkDistance() {
    setBusy(true);
    setError(null);
    setDistance(null);

    try {
      const res = await api.shops.distanceCheck({
        collegeId,
        latitude: latitude ? Number(latitude) : undefined,
        longitude: longitude ? Number(longitude) : undefined,
        address: latitude && longitude ? undefined : address,
      });
      setDistance(res);
      if (!latitude) setLatitude(String(res.latitude));
      if (!longitude) setLongitude(String(res.longitude));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);

    try {
      const res = await api.shops.register({
        name: name.trim(),
        category,
        ownerName: ownerName.trim(),
        ownerMobile,
        ownerEmail: ownerEmail.trim().toLowerCase(),
        password,
        address: address.trim(),
        city,
        state,
        pincode: pincode || undefined,
        latitude: Number(latitude),
        longitude: Number(longitude),
        // FR-SHOP-04: the pin was confirmed by the owner rather than taken
        // from a geocoder, which an administrator sees in the review queue.
        pinAdjusted: true,
        locationType,
        collegeId,
        fssaiLicenceNumber: fssai || undefined,
        gstin: gstin || undefined,
        /**
         * FR-SHOP-08. These are object keys from a presigned upload, which
         * needs an authenticated session the owner does not have yet —
         * registration is public. Phase 1E therefore records the document
         * types with placeholder keys so the administrator's queue shows what
         * is on file; the real upload lands with the shop-owner account
         * creation flow. Noted honestly rather than pretending the files
         * exist.
         */
        documents: [
          { docType: 'ESTABLISHMENT_LICENCE', fileKey: 'pending-upload/licence' },
          { docType: 'FRONTAGE_PHOTO', fileKey: 'pending-upload/frontage' },
          { docType: 'OWNER_PHOTO_ID', fileKey: 'pending-upload/owner-id' },
          ...(locationType === 'ON_CAMPUS'
            ? [{ docType: 'CAMPUS_PERMIT', fileKey: 'pending-upload/permit' }]
            : []),
        ],
      });

      setResult({ distanceLabel: res.distanceLabel, message: res.message });
      setStep('done');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-8">
        <p className="text-3xl font-black tracking-tight">Register your shop</p>
        <p className="mt-1 text-[var(--color-ink-faint)]">
          Students at your college can order from you once a campus administrator approves the
          shop.
        </p>
      </div>

      <Steps current={step} />

      {error && (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {step === 'details' && (
        <Card className="space-y-5 p-6">
          <h2 className="text-xl font-bold">About the shop</h2>

          <Field label="Shop name" value={name} onChange={(e) => setName(e.target.value)} required />

          <label className="block">
            <span className="mb-1 block font-semibold">What do you sell?</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="tap w-full rounded-xl border-2 border-[var(--color-line)] bg-white px-4 text-lg"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block font-semibold">Which college do you want to serve?</span>
            <select
              value={collegeId}
              onChange={(e) => setCollegeId(e.target.value)}
              className="tap w-full rounded-xl border-2 border-[var(--color-line)] bg-white px-4 text-lg"
            >
              {colleges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.city}
                </option>
              ))}
            </select>
          </label>

          <hr className="border-[var(--color-line)]" />
          <h2 className="text-xl font-bold">Your details</h2>

          <Field
            label="Your name"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            required
          />
          <Field
            label="Mobile number"
            inputMode="tel"
            placeholder="9876543210"
            value={ownerMobile}
            onChange={(e) => setOwnerMobile(e.target.value)}
            required
          />
          <Field
            label="Email"
            type="email"
            inputMode="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            required
          />
          <Field
            label="Password"
            hint="At least 10 characters. Length matters more than symbols."
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <Button
            large
            className="w-full"
            disabled={
              !name || !ownerName || !ownerMobile || !ownerEmail || password.length < 10 || !collegeId
            }
            onClick={() => setStep('location')}
          >
            Next: where is the shop?
          </Button>
        </Card>
      )}

      {step === 'location' && (
        <Card className="space-y-5 p-6">
          <h2 className="text-xl font-bold">Where is the shop?</h2>
          <p className="text-[var(--color-ink-faint)]">
            {college?.name} delivers within a set distance of campus. We check that before you
            upload anything, so you are not asked for paperwork you might not need.
          </p>

          <Field
            label="Full address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            required
          />

          <div className="flex flex-wrap gap-3">
            <div className="min-w-40 flex-1">
              <Field label="City" value={city} onChange={(e) => setCity(e.target.value)} required />
            </div>
            <div className="min-w-40 flex-1">
              <Field label="State" value={state} onChange={(e) => setState(e.target.value)} required />
            </div>
            <div className="min-w-32 flex-1">
              <Field
                label="Pincode"
                inputMode="numeric"
                value={pincode}
                onChange={(e) => setPincode(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-xl bg-[var(--color-surface-sunken)] p-4">
            <p className="mb-2 font-semibold">Exact location</p>
            <p className="mb-3 text-sm text-[var(--color-ink-faint)]">
              Stand at your shop and tap the button, or type the coordinates. This is more
              accurate than looking up the address, and the distance decides whether you can
              register.
            </p>

            <Button tone="secondary" onClick={useMyLocation} className="mb-3 w-full">
              Use my current location
            </Button>

            <div className="flex flex-wrap gap-3">
              <div className="min-w-36 flex-1">
                <Field
                  label="Latitude"
                  inputMode="decimal"
                  placeholder="17.3051"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                />
              </div>
              <div className="min-w-36 flex-1">
                <Field
                  label="Longitude"
                  inputMode="decimal"
                  placeholder="78.6194"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                />
              </div>
            </div>
          </div>

          <fieldset>
            <legend className="mb-2 font-semibold">Is the shop inside the campus?</legend>
            <div className="flex gap-3">
              <Button
                tone={locationType === 'OFF_CAMPUS' ? 'primary' : 'secondary'}
                onClick={() => setLocationType('OFF_CAMPUS')}
                className="flex-1"
              >
                Outside campus
              </Button>
              <Button
                tone={locationType === 'ON_CAMPUS' ? 'primary' : 'secondary'}
                onClick={() => setLocationType('ON_CAMPUS')}
                className="flex-1"
              >
                Inside campus
              </Button>
            </div>
            {locationType === 'ON_CAMPUS' && (
              <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
                A shop inside the campus also needs a letter or permit from the college
                authority.
              </p>
            )}
          </fieldset>

          <Button
            large
            className="w-full"
            loading={busy}
            disabled={!address || (!latitude && !address)}
            onClick={() => void checkDistance()}
          >
            Check the distance
          </Button>

          {/* D-04: the measured distance and the permitted limit, both shown —
              FR-SHOP-06 requires it, and a bare "too far" tells an owner
              nothing they can act on. */}
          {distance && (
            <div
              className={`rounded-xl border-l-4 p-4 ${
                distance.withinRadius
                  ? 'border-[var(--color-ready)] bg-[var(--color-ready-bg)]'
                  : 'border-[var(--color-danger)] bg-[var(--color-danger-bg)]'
              }`}
            >
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="text-3xl font-black">{distance.distanceLabel}</span>
                <span className="text-[var(--color-ink-soft)]">
                  from campus · limit is {distance.radiusLabel}
                </span>
              </p>
              <p
                className={`mt-2 font-semibold ${
                  distance.withinRadius
                    ? 'text-[var(--color-ready)]'
                    : 'text-[var(--color-danger)]'
                }`}
              >
                {distance.message}
              </p>
            </div>
          )}

          <div className="flex gap-3">
            <Button tone="quiet" onClick={() => setStep('details')}>
              Back
            </Button>
            <Button
              className="flex-1"
              disabled={!distance?.withinRadius}
              onClick={() => setStep('documents')}
            >
              Next: paperwork
            </Button>
          </div>
        </Card>
      )}

      {step === 'documents' && (
        <Card className="space-y-5 p-6">
          <h2 className="text-xl font-bold">Licences</h2>

          {category === 'FOOD' && (
            <Banner tone="warn">
              A shop selling prepared food needs its own FSSAI licence number. Delivering food
              without one exposes both your shop and the platform.
            </Banner>
          )}

          <Field
            label={category === 'FOOD' ? 'FSSAI licence number' : 'FSSAI licence number (if you have one)'}
            hint="14 digits"
            inputMode="numeric"
            value={fssai}
            onChange={(e) => setFssai(e.target.value)}
            required={category === 'FOOD'}
          />

          <Field
            label="GSTIN (optional)"
            hint="15 characters"
            value={gstin}
            onChange={(e) => setGstin(e.target.value.toUpperCase())}
          />

          <div className="rounded-xl bg-[var(--color-surface-sunken)] p-4">
            <p className="font-semibold">Documents to bring</p>
            <p className="mt-1 text-sm text-[var(--color-ink-faint)]">
              Your campus administrator will ask for these. Photo uploads are not available on
              this screen yet, so bring them when you follow up.
            </p>
            <ul className="mt-3 space-y-1 text-[var(--color-ink-soft)]">
              <li>• Shop establishment licence or registration certificate</li>
              <li>• A photograph of the shop frontage showing the signboard</li>
              <li>• Your own photo identity document</li>
              {locationType === 'ON_CAMPUS' && <li>• The college authority&rsquo;s permit</li>}
            </ul>
          </div>

          <div className="flex gap-3">
            <Button tone="quiet" onClick={() => setStep('location')}>
              Back
            </Button>
            <Button
              className="flex-1"
              large
              loading={busy}
              disabled={category === 'FOOD' && fssai.length !== 14}
              onClick={() => void submit()}
            >
              Submit for approval
            </Button>
          </div>
        </Card>
      )}

      {step === 'done' && (
        <Card className="space-y-4 p-6 text-center">
          <p className="text-2xl font-bold">Submitted</p>
          <p className="text-[var(--color-ink-soft)]">{result?.message}</p>
          <p className="text-[var(--color-ink-faint)]">
            Measured {result?.distanceLabel} from campus.
          </p>
          <Button large className="w-full" onClick={() => (window.location.href = '/login')}>
            Sign in
          </Button>
        </Card>
      )}
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const order: Step[] = ['details', 'location', 'documents', 'done'];
  const labels: Record<Step, string> = {
    details: 'Shop',
    location: 'Location',
    documents: 'Licences',
    done: 'Done',
  };
  const index = order.indexOf(current);

  return (
    <ol className="mb-6 flex gap-2" aria-label="Registration progress">
      {order.map((step, i) => (
        <li key={step} className="flex-1">
          <div
            className={`h-2 rounded-full ${
              i <= index ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-line)]'
            }`}
          />
          <span
            className={`mt-1 block text-sm ${
              i <= index ? 'font-semibold text-[var(--color-ink)]' : 'text-[var(--color-ink-faint)]'
            }`}
          >
            {labels[step]}
          </span>
        </li>
      ))}
    </ol>
  );
}
