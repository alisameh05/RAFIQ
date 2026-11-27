'use client';

import Image from 'next/image';
import { useEffect, useRef, type RefObject } from 'react';

const frameWidth = 384;
const frameHeight = 448;
const framesPerSheet = 12;
const frameCount = 120;

export function Miibot({ chapters }: { chapters: RefObject<HTMLDivElement | null> }) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = stage.current;
    const art = canvas.current;
    const story = chapters.current;
    if (!host || !art || !story) return;

    const motion = window.matchMedia('(min-width: 56rem) and (min-height: 35rem) and (prefers-reduced-motion: no-preference)');
    const context = art.getContext('2d');
    if (!context) return;

    const sheets = new Map<number, Promise<HTMLImageElement>>();
    let request = 0;
    let sequence = 0;
    let currentFrame = -1;
    let visible = false;
    let failed = false;

    function loadSheet(index: number) {
      let sheet = sheets.get(index);
      if (!sheet) {
        const image = new window.Image();
        image.src = `/landing/turntable/pose-${index}.webp`;
        sheet = image.decode().then(() => image);
        sheets.set(index, sheet);
      }
      return sheet;
    }

    const hideMotion = () => {
      sequence += 1;
      currentFrame = -1;
      host.removeAttribute('data-motion');
    };

    const draw = async () => {
      if (!motion.matches || !visible || failed) return;

      const rect = story.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, (window.innerHeight / 2 - rect.top) / rect.height));
      const frame = Math.round(progress * (frameCount - 1));
      if (frame === currentFrame) return;
      currentFrame = frame;
      const drawing = ++sequence;
      if (!host.hasAttribute('data-motion')) host.dataset.motion = 'loading';

      try {
        const sheet = await loadSheet(Math.floor(frame / framesPerSheet));
        if (drawing !== sequence) return;
        const cell = frame % framesPerSheet;
        context.clearRect(0, 0, frameWidth, frameHeight);
        context.drawImage(sheet, cell % 4 * frameWidth, Math.floor(cell / 4) * frameHeight,
          frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
        host.dataset.motion = 'ready';
      } catch {
        if (drawing !== sequence) return;
        failed = true;
        hideMotion();
      }
    };

    function refresh() {
      if (!motion.matches) hideMotion();
      if (!visible || !motion.matches || failed) return;
      cancelAnimationFrame(request);
      request = requestAnimationFrame(() => { void draw(); });
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (!visible && host.dataset.motion === 'loading') hideMotion();
      refresh();
    });
    observer.observe(host);
    motion.addEventListener('change', refresh);
    window.addEventListener('scroll', refresh, { passive: true });
    window.addEventListener('resize', refresh);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', refresh);
      window.removeEventListener('scroll', refresh);
      window.removeEventListener('resize', refresh);
      cancelAnimationFrame(request);
      hideMotion();
    };
  }, [chapters]);

  return (
    <figure className="landing-miibot">
      <div className="landing-miibot-stage" ref={stage}>
        <Image className="landing-miibot-still" src="/landing/robot-still.png"
          alt="Miibot, the graphite RAFIQ companion with cyan eyes" width={528} height={625} unoptimized />
        <canvas ref={canvas} width={frameWidth} height={frameHeight} aria-hidden="true" />
        <Image className="landing-miibot-loader" src="/landing/compact.svg" alt=""
          width={24} height={24} aria-hidden="true" unoptimized />
      </div>
      <figcaption>Miibot · RAFIQ Agent</figcaption>
    </figure>
  );
}
