import {useEffect, useState} from 'react';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 仅在忙碌时驱动 90ms 一帧的盲文 spinner，空闲时停止计时器。 */
export function useSpinner(active: boolean): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setIndex(value => (value + 1) % frames.length), 90);
    return () => clearInterval(timer);
  }, [active]);
  return frames[index] ?? frames[0]!;
}
