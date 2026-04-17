"use client";
import { useEffect, useRef, useCallback } from "react";

const TOTAL_FRAMES = 96;
const SCROLL_RANGE = 2500;

const frameUrls = Array.from(
  { length: TOTAL_FRAMES },
  (_, i) => `/frames/frame-${String(i + 1).padStart(3, "0")}.webp`
);

export default function ScrollAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const currentFrame = useRef(0);
  const loaded = useRef(false);

  const drawFrame = useCallback((index: number) => {
    const canvas = canvasRef.current;
    const img = imagesRef.current[index];
    if (!canvas || !img || !img.complete) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const imgAspect = img.naturalWidth / img.naturalHeight;
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
  }, []);

  useEffect(() => {
    // Preload all images
    const images: HTMLImageElement[] = [];
    let count = 0;

    frameUrls.forEach((url, i) => {
      const img = new Image();
      img.src = url;
      img.onload = () => {
        count++;
        if (count === TOTAL_FRAMES) {
          loaded.current = true;
          drawFrame(currentFrame.current);
        } else if (count === 1) {
          // Draw first frame as soon as it loads
          drawFrame(0);
        }
      };
      images[i] = img;
    });
    imagesRef.current = images;

    // Scroll handler
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          const scrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
          const progress = Math.max(0, Math.min(1, scrollY / SCROLL_RANGE));
          const newFrame = Math.min(TOTAL_FRAMES - 1, Math.round(progress * (TOTAL_FRAMES - 1)));

          if (newFrame !== currentFrame.current) {
            currentFrame.current = newFrame;
            drawFrame(newFrame);
          }
          ticking = false;
        });
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => drawFrame(currentFrame.current));

    // Initial draw
    setTimeout(() => drawFrame(0), 100);

    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, [drawFrame]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        display: "block",
      }}
    />
  );
}
