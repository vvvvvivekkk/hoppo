import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { TAP, colour, radius, space, text } from '@/lib/theme';

/**
 * The app's primitives.
 *
 * Nothing interactive is below the 44 px floor NFR-U-04 asks for, and every
 * control carries an accessibility label or role — a student using TalkBack
 * or VoiceOver has to be able to accept a task offer, not just see one.
 */

type Tone = 'primary' | 'secondary' | 'danger' | 'quiet' | 'good';

export function Button({
  children,
  onPress,
  tone = 'primary',
  loading = false,
  disabled = false,
  large = false,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress: () => void;
  tone?: Tone;
  loading?: boolean;
  disabled?: boolean;
  large?: boolean;
  accessibilityLabel?: string;
}) {
  const palette: Record<Tone, { bg: string; fg: string; border?: string }> = {
    primary: { bg: colour.accent, fg: '#fff' },
    good: { bg: colour.good, fg: '#fff' },
    secondary: { bg: colour.surface, fg: colour.ink, border: colour.line },
    danger: { bg: colour.surface, fg: colour.danger, border: colour.danger },
    quiet: { bg: 'transparent', fg: colour.inkSoft },
  };

  const p = palette[tone];
  const off = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: off, busy: loading }}
      style={({ pressed }) => [
        styles.button,
        large && styles.buttonLarge,
        {
          backgroundColor: p.bg,
          borderColor: p.border ?? 'transparent',
          borderWidth: p.border ? 2 : 0,
          opacity: off ? 0.55 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={p.fg} />
      ) : (
        <Text style={[styles.buttonLabel, large && styles.buttonLabelLarge, { color: p.fg }]}>
          {children}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  error,
  ...rest
}: TextInputProps & { label: string; hint?: string; error?: string }) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={styles.label}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <TextInput
        {...rest}
        accessibilityLabel={label}
        placeholderTextColor={colour.inkFaint}
        style={[styles.input, error ? { borderColor: colour.danger } : null, rest.style]}
      />
      {error ? (
        // role=alert so the problem is announced rather than only seen.
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Card({
  children,
  tone,
  style,
}: {
  children: ReactNode;
  tone?: 'waiting' | 'live' | 'good' | 'danger';
  style?: object;
}) {
  const edge =
    tone === 'waiting'
      ? colour.waiting
      : tone === 'live'
        ? colour.live
        : tone === 'good'
          ? colour.good
          : tone === 'danger'
            ? colour.danger
            : undefined;

  return (
    <View
      style={[
        styles.card,
        edge ? { borderLeftWidth: 6, borderLeftColor: edge } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A status chip that always carries its own words, never colour alone. */
export function Chip({
  children,
  tone = 'plain',
}: {
  children: ReactNode;
  tone?: 'plain' | 'waiting' | 'live' | 'good' | 'danger';
}) {
  const map = {
    plain: { bg: colour.surfaceSunken, fg: colour.inkSoft },
    waiting: { bg: colour.waitingBg, fg: colour.waiting },
    live: { bg: colour.liveBg, fg: colour.live },
    good: { bg: colour.goodBg, fg: colour.good },
    danger: { bg: colour.dangerBg, fg: colour.danger },
  }[tone];

  return (
    <View style={[styles.chip, { backgroundColor: map.bg }]}>
      <Text style={[styles.chipText, { color: map.fg }]}>{children}</Text>
    </View>
  );
}

export function Banner({
  children,
  tone = 'live',
}: {
  children: ReactNode;
  tone?: 'live' | 'waiting' | 'danger' | 'good';
}) {
  const map = {
    live: { bg: colour.liveBg, fg: colour.live },
    waiting: { bg: colour.waitingBg, fg: colour.waiting },
    danger: { bg: colour.dangerBg, fg: colour.danger },
    good: { bg: colour.goodBg, fg: colour.good },
  }[tone];

  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
      style={[styles.banner, { backgroundColor: map.bg, borderLeftColor: map.fg }]}
    >
      <Text style={{ color: map.fg, fontWeight: '600', fontSize: text.body }}>{children}</Text>
    </View>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colour.accent} />
      <Text style={{ color: colour.inkFaint, marginTop: space.sm }}>{label}</Text>
    </View>
  );
}

export function Heading({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text accessibilityRole="header" style={styles.heading}>
        {children}
      </Text>
      {sub ? <Text style={{ color: colour.inkFaint, fontSize: text.body }}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: TAP,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLarge: { minHeight: 60 },
  buttonLabel: { fontSize: text.body, fontWeight: '700' },
  buttonLabelLarge: { fontSize: text.title },
  label: { fontSize: text.body, fontWeight: '700', color: colour.ink, marginBottom: space.xs },
  hint: { fontSize: text.small, color: colour.inkFaint, marginBottom: space.xs },
  input: {
    minHeight: TAP,
    borderWidth: 2,
    borderColor: colour.line,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    fontSize: text.body + 2,
    color: colour.ink,
    backgroundColor: colour.surface,
  },
  error: { color: colour.danger, fontSize: text.small, fontWeight: '600', marginTop: space.xs },
  card: {
    backgroundColor: colour.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colour.line,
    padding: space.lg,
    marginBottom: space.md,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: text.small, fontWeight: '700' },
  banner: {
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
  },
  empty: { paddingVertical: space.xxl * 2, paddingHorizontal: space.xl, alignItems: 'center' },
  emptyTitle: { fontSize: text.title, fontWeight: '700', color: colour.ink, textAlign: 'center' },
  emptyBody: {
    fontSize: text.body,
    color: colour.inkFaint,
    textAlign: 'center',
    marginTop: space.sm,
  },
  loading: { paddingVertical: space.xxl * 2, alignItems: 'center' },
  heading: { fontSize: text.display, fontWeight: '800', color: colour.ink, letterSpacing: -0.5 },
});
