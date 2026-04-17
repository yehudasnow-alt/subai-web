"use client";
import { useEffect, useRef } from "react";

const TOTAL_FRAMES = 96;

const frameUrls = Array.from(
  { length: TOTAL_FRAMES },
  (_, i) => `/frames/frame-${String(i + 1).padStart(3, "0")}.webp`
);

export default function ScrollAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const frameRef = useRef(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const images: HTMLImageElement[] = [];
    let loadedCount = 0;

    const drawFrame = (index: number) => {
      const img = images[index];
      if (!img || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const imgAspect = img.width / img.height;
      const canvasAspect = rect.width / rect.height;
      let drawW, drawH, drawX, drawY;
      if (imgAspect > canvasAspect) {
        drawW = rect.width * 0.85;
        drawH = drawW / imgAspect;
      } else {
        drawH = rect.height * 0.85;
        drawW = drawH * imgAspect;
      }
      drawX = (rect.width - drawW) / 2;
      drawY = (rect.height - drawH) / 2;
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    };

    frameUrls.forEach((url, i) => {
      const img = new Image();
      img.src = url;
      img.onload = () => {
        loadedCount++;
        if (loadedCount === 1) drawFrame(0);
      };
      images[i] = img;
    });
    imagesRef.current = images;

    const handleScroll = () => {
      const scrollY = window.scrollY;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const progress = Math.max(0, Math.min(1, scrollY / maxScroll));
      const newFrame = Math.round(progress * (TOTAL_FRAMES - 1));
      if (newFrame !== frameRef.current) {
        frameRef.current = newFrame;
        drawFrame(newFrame);
      }
    };

    const onScroll = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(handleScroll);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => drawFrame(frameRef.current));

    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}
