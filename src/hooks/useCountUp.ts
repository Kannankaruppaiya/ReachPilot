import { useEffect, useRef, useState } from "react"
import { COUNT_UP_DURATION_MS } from "@/constants"

/** Animate a number from 0 → target with an ease-out cubic over `duration` ms. */
export function useCountUp(target: number, duration = COUNT_UP_DURATION_MS) {
  const [value, setValue] = useState(0)
  const frameRef = useRef<number | null>(null)
  useEffect(() => {
    const start = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration)
      setValue(Math.round(target * (1 - Math.pow(1 - progress, 3))))
      if (progress < 1) frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
    }
  }, [target, duration])
  return value
}
