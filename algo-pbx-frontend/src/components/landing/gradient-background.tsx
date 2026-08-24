"use client";

import { useEffect, useState } from "react";
import { ShaderGradient, ShaderGradientCanvas } from "@shadergradient/react";

// Full-bleed animated background for the landing page
// (github.com/ruucm/shadergradient — MIT). Client-only: WebGL has no
// server-rendered equivalent, and R3F/three must never touch SSR.
// Respects prefers-reduced-motion and falls back to a static CSS gradient
// when the user has that set, or when WebGL itself is unavailable (older
// browsers, some locked-down enterprise machines, headless test runners).
export function GradientBackground() {
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
      <ShaderGradientCanvas style={{ position: "absolute", inset: 0 }} pointerEvents="none">
        <ShaderGradient
          control="query"
          urlString="https://www.shadergradient.co/customize?animate=on&axesHelper=off&bgColor1=%23000000&bgColor2=%23000000&brightness=1.1&cAzimuthAngle=180&cDistance=3.6&cPolarAngle=90&cameraZoom=1&color1=%2306B6D4&color2=%232563EB&color3=%230B0F19&destination=onCanvas&embedMode=off&envPreset=city&format=gif&fov=45&frameRate=10&grain=on&lightType=3d&pixelDensity=1&positionX=0&positionY=0&positionZ=0&range=enabled&rangeEnd=40&rangeStart=0&reflection=0.1&rotationX=0&rotationY=0&rotationZ=0&shader=defaults&type=waterPlane&uAmplitude=1.2&uDensity=1.3&uFrequency=5.5&uSpeed=0.15&uStrength=2.4&uTime=0&wireframe=false"
        />
      </ShaderGradientCanvas>
    </div>
  );
}
