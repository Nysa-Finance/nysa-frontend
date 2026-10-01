import { init, track } from '@plausible-analytics/tracker'

let enabled = false

// Cookie-less analytics, self-hosted on the VPS (Plausible, see docker-compose.yml). Production builds only; ignores localhost.
// Never send wallet addresses, signatures or amounts: outbound links (Solscan URLs contain both) are reduced to their host.
export function startAnalytics() {
  if (!import.meta.env.PROD) return
  init({
    domain: 'app.nysa.finance',
    endpoint: 'https://analytics.nysa.finance/api/event',
    outboundLinks: true,
    transformRequest: (req) => {
      if (req.p?.url) req.p.url = new URL(req.p.url).host
      return req
    },
  })
  enabled = true
}

export const event = (name, props) => { if (enabled) track(name, { props }) }
