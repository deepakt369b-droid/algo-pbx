/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Security headers, including CSP. The original hydration bug was caused
  // by a static `script-src 'self'` with no `'unsafe-inline'` and no nonce:
  // Next.js App Router ships its RSC payload as inline
  // `<script>self.__next_f.push(...)</script>` tags, which the browser
  // silently dropped, so React never hydrated. Nonce-based CSP would be
  // preferable, but Next.js 14.2 does not automatically nonce its own
  // external `<script src>` chunks in production standalone output; with
  // `'strict-dynamic'` those chunks were blocked too. `'self'` plus
  // `'unsafe-inline'` is the pragmatic, production-verified fix for this
  // self-hosted setup. HSTS is set assuming HTTPS termination in Nginx.
  async headers() {
    const isDev = process.env.NODE_ENV === "development";
    const csp = [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'" + (isDev ? " 'unsafe-eval'" : ""),
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' blob:",
      "connect-src 'self' wss: turn: turns: stun:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
          // preload is NOT set here — that's a one-way, hard-to-reverse
          // commitment to the browser preload list and shouldn't be turned
          // on by a config default; add it deliberately once the domain is
          // confirmed stable.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
