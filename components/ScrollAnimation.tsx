"use client";
import { useEffect, useRef } from "react";

const TOTAL_FRAMES = 96;

const frameUrls = Array.from(
  { length: TOTAL_FRAMES },
  (_, i) => `/frames/frame-${String(i + 1).padStart(3, "0")}.webp`
);

export default function ScrollAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Preload all images
    const images: HTMLImageElement[] = [];
    let loadCount = 0;
    let currentFrame = -1;

    function drawFrame(index: number) {
      if (index === currentFrame) return;
      const img = images[index];
      if (!img || !img.complete || !canvas) return;
      currentFrame = index;

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const iw = img.naturalWidth, ih = img.naturalHeight;
      const imgR = iw / ih, canR = rect.width / rect.height;
      let dw, dh;
      if (imgR > canR) { dw = rect.width * 0.85; dh = dw / imgR; }
      else { dh = rect.height * 0.85; dw = dh * imgR; }
      ctx.drawImage(img, (rect.width - dw) / 2, (rect.height - dh) / 2, dw, dh);
    }

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const img = new Image();
      img.src = frameUrls[i];
      img.onload = () => { loadCount++; if (loadCount === 1) drawFrame(0); };
      images[i] = img;
    }

    // Scroll handler — full rotation within first 33% of page
    function onScroll() {
      const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrollZone = docHeight * 0.10; // Only first 33% of page
      const progress = Math.max(0, Math.min(1, scrollY / scrollZone));
      const frame = Math.min(TOTAL_FRAMES - 1, Math.round(progress * (TOTAL_FRAMES - 1)));
      drawFrame(frame);
    }

    // Listen on both window AND document for maximum compatibility
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("scroll", onScroll, { passive: true });

    // Also listen on the page-wrap div (Next.js sometimes scrolls a container)
    const pageWrap = document.querySelector(".page-wrap");
    if (pageWrap) {
      pageWrap.addEventListener("scroll", onScroll, { passive: true });
    }

    // Initial draw + periodic check for first 2 seconds
    const checks = [0, 100, 300, 500, 1000, 2000];
    checks.forEach(ms => setTimeout(() => { onScroll(); }, ms));

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("scroll", onScroll);
      if (pageWrap) pageWrap.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", pointerEvents: "none", display: "block" }}
    />
  );
}
