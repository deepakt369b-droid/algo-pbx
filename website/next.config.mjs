/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export: this site is plain HTML served by Caddy's file_server,
  // no Node runtime in production, no shared deploy surface with
  // algo-pbx-frontend's standalone Next server.
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
