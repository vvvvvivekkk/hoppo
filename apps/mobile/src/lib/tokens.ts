import * as SecureStore from 'expo-secure-store';
import type { TokenPair, TokenStore } from '@hoppo/api-client';

const KEY = 'hoppo.tokens';

/**
 * Token storage on a phone.
 *
 * `expo-secure-store` rather than AsyncStorage: this is the Keychain on iOS
 * and the Keystore-backed EncryptedSharedPreferences on Android, so the
 * refresh token is not sitting in a plain file that any backup or a rooted
 * device hands over. A refresh token lives for thirty days and can mint
 * access tokens for the whole period, so it is worth protecting properly.
 *
 * The in-memory cache matters for a different reason: SecureStore is async,
 * and the API client's `TokenStore.get()` is synchronous because it is called
 * on every request. So the value is loaded once at startup and kept in memory
 * afterwards, with writes going to both.
 */
let cached: TokenPair | null = null;
let loaded = false;

export async function loadStoredTokens(): Promise<TokenPair | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    cached = raw ? (JSON.parse(raw) as TokenPair) : null;
  } catch {
    // A corrupt or unreadable store means "not signed in", not a crash on
    // launch — which is the worst possible moment to crash.
    cached = null;
  }
  loaded = true;
  return cached;
}

export function createTokenStore(onChange?: () => void): TokenStore {
  return {
    get() {
      if (!loaded) {
        // Reached only if a request is made before the startup load finishes.
        // Returning null makes it an anonymous request, which the caller
        // handles, rather than blocking on a promise it cannot await.
        return null;
      }
      return cached;
    },

    async set(tokens: TokenPair) {
      cached = tokens;
      loaded = true;
      try {
        await SecureStore.setItemAsync(KEY, JSON.stringify(tokens));
      } catch {
        // Memory-only for this session rather than failing the login.
      }
      onChange?.();
    },

    async clear() {
      cached = null;
      loaded = true;
      try {
        await SecureStore.deleteItemAsync(KEY);
      } catch {
        /* nothing useful to do */
      }
      onChange?.();
    },
  };
}
