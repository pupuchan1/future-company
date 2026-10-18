import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { LiveLanguage } from "@/features/live/types";

const photos = ["haas-office", "haas-craft", "haas-studio"];
const frames = [photos[photos.length - 1], ...photos, photos[0]];
const motionQuery = "(prefers-reduced-motion: reduce)";

export function ReceptionHeroCarousel({ language }: { language: LiveLanguage }) {
  const [position, setPosition] = useState(1);
  const [animate, setAnimate] = useState(true);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(motionQuery).matches,
  );
  const region = useRef<HTMLDivElement>(null);
  const gesture = useRef<number | null>(null);
  const current = (position - 1 + photos.length) % photos.length;
  const text = (ja: string, en: string) => language === "ja" ? ja : en;

  useEffect(() => {
    const query = window.matchMedia(motionQuery);
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!region.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(region.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (paused || reducedMotion || !visible) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setPosition((p) => Math.min(p + 1, photos.length + 1));
    }, 6000);
    return () => window.clearInterval(timer);
  }, [paused, reducedMotion, visible]);

  useEffect(() => {
    if (animate) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [animate]);

  function finishLoop() {
    if (position !== 0 && position !== photos.length + 1) return;
    setAnimate(false);
    setPosition(position === 0 ? photos.length : 1);
  }

  function move(direction: number) {
    setPaused(true);
    setAnimate(true);
    setPosition((p) => reducedMotion
      ? ((p - 1 + direction + photos.length) % photos.length) + 1
      : Math.max(0, Math.min(photos.length + 1, p + direction)));
  }

  function beginGesture(event: PointerEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest("button")) return;
    gesture.current = event.clientX;
  }

  function finishGesture(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current === null) return;
    const distance = event.clientX - gesture.current;
    gesture.current = null;
    if (Math.abs(distance) > 50) move(distance < 0 ? 1 : -1);
  }

  return (
    <div
      ref={region}
      className="haas-hero-backdrop"
      role="group"
      aria-roledescription={text("カルーセル", "carousel")}
      aria-label={text("職場のイメージ写真", "Illustrative office photos")}
      data-slide={current + 1}
      data-autoplay={!(paused || reducedMotion || !visible)}
      onFocusCapture={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest(".haas-carousel-pause")) setPaused(true);
      }}
      onPointerLeave={() => { gesture.current = null; }}
      onPointerDown={beginGesture}
      onPointerUp={finishGesture}
      onPointerCancel={() => { gesture.current = null; }}
    >
      <div
        className="haas-carousel-track"
        aria-hidden="true"
        style={{
          transform: `translate3d(-${position * 100}%, 0, 0)`,
          transition: animate && !reducedMotion ? "transform 720ms cubic-bezier(.25,.6,.25,1)" : "none",
        }}
        onTransitionEnd={(event) => { if (event.target === event.currentTarget) finishLoop(); }}
      >
        {frames.map((photo, index) => (
          <img
            key={`${photo}-${index}`}
            src={`/images/${photo}-1440.jpg`}
            srcSet={`/images/${photo}-960.jpg 960w, /images/${photo}-1440.jpg 1440w`}
            sizes="100vw"
            width="1440"
            height="960"
            alt=""
            draggable={false}
            fetchPriority={index === 1 ? "high" : "low"}
          />
        ))}
      </div>
      <div className="haas-carousel-controls">
        <span className="haas-carousel-count" aria-hidden="true">0{current + 1} / 03</span>
        <div className="haas-carousel-dots" role="group" aria-label={text("写真を選択", "Choose a photo")}>
          {photos.map((photo, index) => (
            <button
              key={photo}
              type="button"
              aria-label={text(`写真${index + 1}を表示`, `Show photo ${index + 1}`)}
              aria-pressed={current === index}
              onClick={() => { setPaused(true); setAnimate(true); setPosition(index + 1); }}
            ><span /></button>
          ))}
        </div>
        {!reducedMotion && <button
          type="button"
          className="haas-carousel-pause"
          aria-label={paused ? text("写真の自動切り替えを再開", "Resume photo rotation") : text("写真の自動切り替えを停止", "Pause photo rotation")}
          onClick={() => setPaused((value) => !value)}
        ><span aria-hidden="true">{paused ? "▶" : "Ⅱ"}</span></button>}
        <span className="haas-carousel-credit">{text("写真はイメージです", "Illustrative images")}</span>
      </div>
    </div>
  );
}
