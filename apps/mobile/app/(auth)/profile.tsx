import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { College } from '@hoppo/api-client';
import { Banner, Button, Field, Loading } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { TAP, colour, radius, space, text } from '@/lib/theme';

/**
 * S-05 and S-06: pick the college, then create the account.
 *
 * The college comes first because it changes the rest of the form —
 * FR-AUTH-03 restricts registration to a college's own email domain where one
 * is set, and telling a student that after they have typed a Gmail address is
 * worse than telling them before.
 */
export default function ProfileScreen() {
  const { api, setTokens } = useApi();
  const router = useRouter();
  const params = useLocalSearchParams<{ mobile: string; challengeId: string }>();

  const [colleges, setColleges] = useState<College[] | null>(null);
  const [collegeId, setCollegeId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { colleges: list } = await api.auth.colleges();
        setColleges(list);
      } catch (e) {
        setError(describeError(e));
        setColleges([]);
      }
    })();
  }, [api]);

  const college = colleges?.find((c) => c.id === collegeId);

  // FR-AUTH-03, checked before submitting so the message arrives at the field
  // rather than as a rejection after.
  const domainMismatch =
    college?.emailDomain && email.includes('@')
      ? email.split('@')[1]?.toLowerCase() !== college.emailDomain.toLowerCase()
      : false;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const tokens = await api.auth.register({
        name: name.trim(),
        mobile: params.mobile,
        email: email.trim().toLowerCase(),
        password,
        collegeId,
        mobileOtpChallengeId: params.challengeId,
      });
      await setTokens(tokens);
      // FR-SVER-01: the account starts unverified, so the next stop is the
      // verification flow rather than the home screen.
      router.replace('/(verify)/submit');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (colleges === null) return <Loading label="Loading colleges…" />;

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

        <Text style={{ fontSize: text.body, fontWeight: '700', marginBottom: space.sm }}>
          Your college
        </Text>

        <View style={{ gap: space.sm, marginBottom: space.xl }}>
          {colleges.map((c) => {
            const selected = c.id === collegeId;
            return (
              <Pressable
                key={c.id}
                onPress={() => setCollegeId(c.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                style={{
                  minHeight: TAP,
                  borderWidth: 2,
                  borderColor: selected ? colour.accent : colour.line,
                  backgroundColor: selected ? colour.accentSoft : colour.surface,
                  borderRadius: radius.md,
                  padding: space.md,
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: text.body, fontWeight: '700', color: colour.ink }}>
                  {c.name}
                </Text>
                <Text style={{ fontSize: text.small, color: colour.inkFaint }}>
                  {c.city}
                  {c.emailDomain ? ` · needs an @${c.emailDomain} address` : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Field
          label="Your full name"
          hint="As it appears on your college ID card"
          value={name}
          onChangeText={setName}
          autoComplete="name"
          returnKeyType="next"
        />

        <Field
          label="Email"
          hint={college?.emailDomain ? `Must end in @${college.emailDomain}` : undefined}
          error={domainMismatch ? `${college?.name} requires an @${college?.emailDomain} address` : undefined}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          returnKeyType="next"
        />

        <Field
          label="Password"
          hint="At least 10 characters. Length matters more than symbols."
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />

        <Button
          large
          loading={busy}
          disabled={!collegeId || !name || !email || password.length < 10 || Boolean(domainMismatch)}
          onPress={() => void submit()}
        >
          Create account
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
