import { init, track } from '@plausible-analytics/tracker'

let enabled = false
let skipPageview = false
const early = [] // events sent before startAnalytics() (e.g. while reading a wallet app's answer on load)

// Cookie-less analytics, self-hosted on the VPS (Plausible, see docker-compose.yml). Production builds only; ignores localhost.
// Never send wallet addresses, signatures or amounts: outbound links (Solscan URLs contain both) are reduced to their host.
export function startAnalytics() {
  if (!import.meta.env.PROD) return
  init({
    domain: 'app.nysa.finance',
    endpoint: 'https://analytics.nysa.finance/api/event',
    outboundLinks: true,
    transformRequest: (req) => {
      if (req.n === 'pageview' && skipPageview) { skipPageview = false; return null }
      if (req.p?.url) req.p.url = new URL(req.p.url).host
      return req
    },
  })
  enabled = true
  for (const [name, props] of early.splice(0)) track(name, { props })
}

// Coming back from a wallet app (iOS deeplink) reloads the page: that's not a new visit.
export const skipNextPageview = () => { skipPageview = true }

export function event(name, props) {
  if (enabled) track(name, { props })
  else if (import.meta.env.PROD) early.push([name, props])
}
