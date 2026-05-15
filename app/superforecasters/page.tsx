import { SuperforecasterTable } from './SuperforecasterTable'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Superforecasters — Arena',
  description: 'Bayesian-shrinkage ranking of traders by Sharpe-vs-BTC.',
}

export default function SuperforecastersPage() {
  return (
    <main style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto', color: '#e8e8e8' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0 }}>Superforecasters</h1>
        <p style={{ color: '#9aa', marginTop: 8, maxWidth: 760 }}>
          Empirical-Bayes shrinkage applied to <em>Sharpe-vs-BTC</em>. Traders
          with little evidence are pulled toward the population mean; traders
          with many trades retain their observed score. The probability that a
          trader is a true "superforecaster" is computed against a
          population-calibrated 5% cutoff.
        </p>
      </header>
      <SuperforecasterTable />
    </main>
  )
}
