import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Banner, Button, Field } from '@/components/ui';
import { describeError, useApi } from '@/lib/api';
import { space } from '@/lib/theme';

export default function Login() {
  const { login } = useApi();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await login(identifier.trim(), password);
      router.replace('/');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      // Without this the keyboard covers the submit button on iOS, which is
      // the sort of thing that only shows up on a device.
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ padding: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}

        <Field
          label="Mobile number or email"
          value={identifier}
          onChangeText={setIdentifier}
          autoCapitalize="none"
          autoComplete="username"
          keyboardType="email-address"
          returnKeyType="next"
        />

        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />

        <Button large loading={busy} onPress={() => void submit()}>
          Log in
        </Button>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
