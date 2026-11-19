import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { AUTH_OTP_LENGTH } from '@hoppo/shared';
import { Banner, Button, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { colour, space, text } from '@/lib/theme';

/**
 * S-03 and S-04 in one screen.
 *
 * FR-AUTH-02 requires the mobile number to be verified by OTP *before* the
 * registration is submitted, so the challenge id earned here is carried
 * forward to the profile step. Splitting it across two screens would mean
 * holding that state in a store for no benefit — the number and the code it
 * confirms belong together.
 *
 * In development the API returns the code so the flow can be walked without
 * an SMS provider. It is shown on screen with an explicit label saying why,
 * because a code appearing by itself would be alarming in a real build.
 */
export default function PhoneScreen() {
  const { api } = useApi();
  const router = useRouter();

  const [mobile, setMobile] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // A resend timer, so the student is not left tapping a button that is rate
  // limited server-side with no explanation (NFR-S-06 allows three a minute).
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (secondsLeft <= 0) {
      if (tick.current) clearInterval(tick.current);
      return;
    }
    tick.current = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, [secondsLeft]);

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.auth.requestMobileOtp(mobile.trim());
      setChallengeId(result.challengeId);
      setDevCode(result.devCode ?? null);
      setSecondsLeft(30);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.verifyMobileOtp(challengeId, code.trim());
      // FR-AUTH-01: the verified challenge is what the registration proves
      // the number with, so it travels to the next step.
      router.push({
        pathname: '/(auth)/profile',
        params: { mobile: mobile.trim(), challengeId },
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ padding: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}

        {!challengeId ? (
          <>
            <Text
              style={{ fontSize: text.body, color: colour.inkSoft, marginBottom: space.lg }}
            >
              We send a code to confirm it is you. Your number is never shown to other
              students.
            </Text>

            <Field
              label="Mobile number"
              hint="A 10-digit Indian number is fine"
              value={mobile}
              onChangeText={setMobile}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              placeholder="9876543210"
              returnKeyType="go"
              onSubmitEditing={() => void sendCode()}
            />

            <Button large loading={busy} disabled={mobile.length < 10} onPress={() => void sendCode()}>
              Send code
            </Button>
          </>
        ) : (
          <>
            <Text
              style={{ fontSize: text.body, color: colour.inkSoft, marginBottom: space.lg }}
            >
              Enter the {AUTH_OTP_LENGTH}-digit code sent to {mobile}.
            </Text>

            {devCode ? (
              <View style={{ marginBottom: space.lg }}>
                <Banner tone="waiting">
                  Development build: no SMS provider is configured, so the code is {devCode}
                </Banner>
              </View>
            ) : null}

            <Field
              label="Code"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              maxLength={AUTH_OTP_LENGTH}
              // Lets Android fill the code straight from the SMS.
              autoComplete="sms-otp"
              textContentType="oneTimeCode"
              returnKeyType="go"
              onSubmitEditing={() => void verify()}
            />

            <Button
              large
              loading={busy}
              disabled={code.length !== AUTH_OTP_LENGTH}
              onPress={() => void verify()}
            >
              Confirm
            </Button>

            <View style={{ marginTop: space.md }}>
              <Button
                tone="quiet"
                disabled={secondsLeft > 0 || busy}
                onPress={() => void sendCode()}
              >
                {secondsLeft > 0 ? `Resend in ${secondsLeft}s` : 'Resend code'}
              </Button>
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
