'use client'

import * as React from 'react'

// Animated number counter — eases from 0 to target when element enters viewport
export function useCountUp(target: number, duration = 1500, start = false) {
  const [value, setValue] = React.useState(0)
  const startedRef = React.useRef(false)
  const rafRef = React.useRef<number>(0)

  React.useEffect(() => {
    if (!start || startedRef.current) return
    startedRef.current = true
    const startTime = performance.now()
    const animate = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(Math.round(eased * target))
      if (progress < 1) rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(rafRef.current)
  }, [start, target, duration])

  return value
}

// useInView — returns true once the element first scrolls into view
export function useInView<T extends HTMLElement>(options?: IntersectionObserverInit) {
  const ref = React.useRef<T>(null)
  const [inView, setInView] = React.useState(false)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true)
          obs.disconnect()
        }
      },
      { threshold: 0.2, ...options },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [options])
  return { ref, inView }
}
