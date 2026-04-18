"use client";
import { useEffect, useRef } from "react";

interface Props {
  framesDir?: string;
  totalFrames?: number;
  scrollStart?: number;  // Start animation at this % of page (0-1)
  scrollEnd?: number;    // End animation at this % of page (0-1)
}

export default function ScrollAnimation({ 
  framesDir = "/frames", 
  totalFrames = 96,
  scrollStart = 0,
  scrollEnd = 0.18
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const images: HTMLImageElement[] = [];
    let loadCount = 0;
    let currentFrame = -1;

    const frameUrls = Array.from(
      { length: totalFrames },
      (_, i) => `${framesDir}/frame-${String(i + 1).padStart(3, "0")}.webp`
    );

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

    for (let i = 0; i < totalFrames; i++) {
      const img = new Image();
      img.src = frameUrls[i];
      img.onload = () => { loadCount++; if (loadCount === 1) drawFrame(0); };
      images[i] = img;
    }

    function onScroll() {
      const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const startPx = docHeight * scrollStart;
      const endPx = docHeight * scrollEnd;
      const range = endPx - startPx;
      
      let progress = 0;
      if (range > 0) {
        progress = (scrollY - startPx) / range;
      }
      progress = Math.max(0, Math.min(1, progress));
      
      const frame = Math.min(totalFrames - 1, Math.round(progress * (totalFrames - 1)));
      drawFrame(frame);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("scroll", onScroll, { passive: true });
    const pageWrap = document.querySelector(".page-wrap");
    if (pageWrap) pageWrap.addEventListener("scroll", onScroll, { passive: true });

    const checks = [0, 100, 300, 500, 1000, 2000];
    checks.forEach(ms => setTimeout(onScroll, ms));

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("scroll", onScroll);
      if (pageWrap) pageWrap.removeEventListener("scroll", onScroll);
    };
  }, [framesDir, totalFrames, scrollStart, scrollEnd]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", pointerEvents: "none", display: "block" }}
    />
  );
}
