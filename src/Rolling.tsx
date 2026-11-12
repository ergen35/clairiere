import { useLayoutEffect, useRef } from 'react';

const TURNS = 3;
const CELL_EM = 1.2;

function place(el: HTMLElement, pos: number, animate: boolean) {
  if (!animate) {
    el.style.transition = 'none';
    el.style.transform = `translateY(${-pos * CELL_EM}em)`;
    void el.offsetHeight; // Apply the jump before the transition comes back.
    el.style.transition = '';
    return;
  }
  el.style.transform = `translateY(${-pos * CELL_EM}em)`;
}

/**
 * One drum of an odometer. It always turns forward (9 rolls on to 0), and quietly comes back
 * one turn when it has gone far enough: the strip repeats 0-9 three times, so nothing shows.
 */
function Wheel({ digit }: { digit: number }) {
  const strip = useRef<HTMLSpanElement>(null);
  const pos = useRef(digit);
  const shown = useRef(digit);

  useLayoutEffect(() => {
    const el = strip.current;
    if (!el || digit === shown.current) return;
    const delta = (digit - shown.current + 10) % 10;
    shown.current = digit;
    if (pos.current + delta >= TURNS * 10) {
      pos.current %= 10;
      place(el, pos.current, false);
    }
    pos.current += delta;
    place(el, pos.current, true);
  }, [digit]);

  const settle = () => {
    if (strip.current && pos.current >= 10) {
      pos.current %= 10;
      place(strip.current, pos.current, false);
    }
  };

  return (
    <span className="wheel" aria-hidden="true">
      <span className="wheel-strip" ref={strip} style={{ transform: `translateY(${-digit * CELL_EM}em)` }} onTransitionEnd={settle}>
        {Array.from({ length: TURNS * 10 }, (_, i) => (
          <span key={i}>{i % 10}</span>
        ))}
      </span>
    </span>
  );
}

/** A figure whose digits roll like a drum counter instead of flashing from one value to the next. */
export function Rolling({ text }: { text: string }) {
  const chars = [...text];
  return (
    <span className="rolling">
      <span className="sr-only">{text}</span>
      {chars.map((c, i) => {
        // Counted from the right, so the units keep their drum when the number grows.
        const slot = chars.length - i;
        return /[0-9]/.test(c)
          ? <Wheel key={`d${slot}`} digit={Number(c)} />
          : <span key={`c${slot}${c}`} className="rolling-char" aria-hidden="true">{c}</span>;
      })}
    </span>
  );
}
