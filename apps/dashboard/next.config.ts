import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than a build, so Next
  // has to compile them. Without this they arrive as untranspiled TS and the
  // build fails on the first `import type`.
  transpilePackages: ['@hoppo/shared', '@hoppo/api-client'],
  typescript: {
    // A type error should fail the build, not be deferred to runtime.
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default config;
