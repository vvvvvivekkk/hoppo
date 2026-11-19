/**
 * Configuration loading and validation.
 *
 * Every environment variable the application reads is declared and validated
 * here, at startup. The alternative — `process.env.SOMETHING` scattered
 * through the code — means a missing variable surfaces as `undefined` in the
 * middle of a request, hours after deploy, usually as a confusing error far
 * from the cause.
 *
 * NFR-M-01 says business rules belong in configuration rather than code. The
 * distinction this file draws: things that vary by *environment* (database
 * URLs, API keys, secrets) live here; things that vary by *college* (fees,
 * radii, timeouts) live in the `college_config` table, because an
 * administrator changes those without a deployment.
 */

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Secrets must be long enough to be worth having. A 16-character JWT secret
  // is a rounding error to brute-force, so the floor is enforced rather than
  // suggested.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // FR-AUTH-06
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET_PUBLIC: z.string().default('hoppo-public'),
  S3_BUCKET_PRIVATE: z.string().default('hoppo-private'),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  DOCUMENT_ENCRYPTION_KEY: z.string().optional(),

  // Optional in development: with no key, OTPs are logged instead of sent.
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().default('HOPPO'),
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),

  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  FCM_PRIVATE_KEY: z.string().optional(),

  GOOGLE_MAPS_API_KEY: z.string().optional(),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
  POSTHOG_API_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

/**
 * Called by ConfigModule at startup. Throwing here stops the process, which
 * is the correct response to misconfiguration: a server that starts without
 * a database URL is worse than one that refuses to start.
 */
export function loadConfiguration(): AppConfig {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const config = parsed.data;

  // Production-only checks. These are warnings in development so that a
  // first-time setup is not blocked by things that only matter live.
  if (config.NODE_ENV === 'production') {
    const required: (keyof AppConfig)[] = [
      'MSG91_AUTH_KEY',
      'DOCUMENT_ENCRYPTION_KEY',
      'GOOGLE_MAPS_API_KEY',
    ];
    const missing = required.filter((k) => !config[k]);
    if (missing.length > 0) {
      throw new Error(`Missing in production: ${missing.join(', ')}`);
    }
    if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
      throw new Error(
        'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ: sharing them lets an ' +
          'access token be replayed as a refresh token.',
      );
    }
  }

  return config;
}

export const isProduction = (c: AppConfig) => c.NODE_ENV === 'production';
