import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The project launch scripts open the app at 127.0.0.1 rather than
  // localhost. Next's dev server only trusts its own hostname by default,
  // so dev resources (notably the HMR websocket used during hydration)
  // are blocked on the loopback alias without this entry.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
