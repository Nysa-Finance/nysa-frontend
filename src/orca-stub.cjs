// Stand-in for @orca-so/whirlpools-core (a WASM module that kliquidity-sdk pulls into klend-sdk).
// Only Kamino's liquidity-strategy code calls it; the lending flow never does. Fail loudly if that changes.
module.exports = new Proxy({}, {
  get: (_, name) => (name === '__esModule' ? false : () => { throw new Error(`@orca-so/whirlpools-core.${String(name)} is stubbed out in this build`) }),
})
