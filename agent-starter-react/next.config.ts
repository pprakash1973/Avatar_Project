import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Strict Mode double-invokes useSession's connect effect in dev, joining two
  // participants and tripping a livekit-client crash on Room.connect().
  reactStrictMode: false,
};

export default nextConfig;
