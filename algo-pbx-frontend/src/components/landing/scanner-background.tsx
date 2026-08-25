"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// Full-bleed animated background for the landing page: React Bits
// <Scanner /> (ogl), tuned to Algo PBX brand colors. Client-only WebGL.
//
// Same discipline as the previous ShaderGradient background:
//  - next/dynamic({ ssr:false }) keeps the module graph client-side — and
//    that only works because src/app/page.tsx is itself a "use client"
//    component (ssr:false inside a Server Component is silently ignored
//    by Next 14's server-bundle tracing).
//  - prefers-reduced-motion or missing WebGL -> static CSS gradient
//    fallback instead of an animated canvas.

const Scanner = dynamic(() => import("./scanner").then((m) => m.default), { ssr: false });

export function ScannerBackground() {
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setEnabled(false);
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      setSupported(Boolean(gl));
      setEnabled(Boolean(gl));
    } catch {
      setSupported(false);
      setEnabled(false);
    }
  }, []);

  if (!enabled) {
    return (
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          background: supported
            ? "radial-gradient(circle at 20% 20%, #0891B2 0%, #0B0F19 55%)"
            : "linear-gradient(135deg, #06B6D4 0%, #2563EB 50%, #0B0F19 100%)",
        }}
      />
    );
  }

  return (
    <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden">
      <Scanner
        color1="#06B6D4"
        color2="#2563EB"
        color3="#FFFFFF"
        speed={0.45}
        sweepSpeed={0.22}
        sweepWidth={1.8}
        sweepFalloff={6}
        scale={1.6}
        frequency={2}
        ripple={0.22}
        bandDensity={11}
        lineSharpness={5.5}
        glow={0.22}
        scanDirection="vertical"
        colorSpread={0.55}
        brightness={1.0}
        contrast={1.2}
        softness={1.4}
        vignette={0.5}
        scanline
        grain
        grainIntensity={0.05}
        opacity={1}
        mouseInteraction
        mouseRadius={0.5}
        mouseStrength={0.5}
      />
    </div>
  );
}
