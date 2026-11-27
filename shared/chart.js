import { EPSILON } from './finance.js'

export function niceTicks(max) {
  const m = Math.max(max, EPSILON)
  const magnitude = 10 ** Math.floor(Math.log10(m / 5))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * magnitude).find((s) => m / s <= 6)
  const top = Math.ceil(m / step - EPSILON) * step
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) }
}

// Negative values count as 0.
export function pieSlices(values) {
  const total = values.reduce((s, v) => s + Math.max(v, 0), 0)
  let at = 0
  return values.map((v) => {
    const share = total > 0 ? Math.max(v, 0) / total : 0
    const start = at
    at += share * 2 * Math.PI
    return { share: share * 100, start, end: at }
  })
}

// A whole circle (or within ~0.02% of one) is drawn as two half arcs: an SVG arc whose ends round to the same point
// isn't drawn at all.
const FULL = 2 * Math.PI - 1e-3
export function arcPath(cx, cy, r, ri, start, end) {
  if (end - start >= FULL)
    return (
      arcPath(cx, cy, r, ri, start, start + Math.PI) +
      arcPath(cx, cy, r, ri, start + Math.PI, start + 2 * Math.PI - 1e-2)
    )
  const pt = (rad, a) => `${(cx + rad * Math.sin(a)).toFixed(2)},${(cy - rad * Math.cos(a)).toFixed(2)}`
  const large = end - start > Math.PI ? 1 : 0
  return `M${pt(r, start)}A${r},${r} 0 ${large} 1 ${pt(r, end)}L${pt(ri, end)}A${ri},${ri} 0 ${large} 0 ${pt(ri, start)}Z`
}
