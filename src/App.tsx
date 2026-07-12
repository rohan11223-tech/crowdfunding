import { useEffect, useMemo, useRef, useState } from 'react'
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk'
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils'
import { Networks } from '@stellar/stellar-sdk'
import './App.css'
import type { DonationEvent, SyncStatus, TransactionStatus, WalletErrorInfo, WalletOption } from './types'
import {
  CONTRACT_ID,
  TESTNET_NETWORK_PASSPHRASE,
  buildDonationTransaction,
  formatAmount,
  getContractSnapshot,
  submitSignedTransaction,
  testnetExplorerUrl,
} from './lib/stellar'

const DEFAULT_GOAL = 25000
const INITIAL_RAISED = 0
const POLL_INTERVAL_MS = 12000
const DEFAULT_REWARD_CONTRACT_ID = 'CDXUZNGUPVZMX3QQLSDRFRRYTSZVWLSQFQZDC7OSQJ2QB5BWHGT2KJA6'

function App() {
  const configuredRewardContractId = import.meta.env.VITE_REWARD_CONTRACT_ID?.trim()
  const rewardContractId = configuredRewardContractId || DEFAULT_REWARD_CONTRACT_ID
  const [address, setAddress] = useState('')
  const [selectedWallet, setSelectedWallet] = useState('')
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([])
  const [status, setStatus] = useState<TransactionStatus>('idle')
  const [, setSyncStatus] = useState<SyncStatus>('idle')
  const [message, setMessage] = useState('Connect a Stellar wallet to donate and track the campaign.')
  const [errorInfo, setErrorInfo] = useState<WalletErrorInfo | null>(null)
  const [amount, setAmount] = useState('150')
  const [goal, setGoal] = useState(DEFAULT_GOAL)
  const [raised, setRaised] = useState(INITIAL_RAISED)
  const [contractOwner, setContractOwner] = useState('Loading...')
  const [txHash, setTxHash] = useState('')
  const [contractEvents, setContractEvents] = useState<DonationEvent[]>([])
  const [walletsReady, setWalletsReady] = useState(false)
  const hasBootedRef = useRef(false)

  const percent = useMemo(() => Math.min(100, Math.round((raised / goal) * 100)), [goal, raised])
  const remaining = Math.max(goal - raised, 0)
  const isFunded = raised >= goal
  const selectedWalletOption = walletOptions.find((wallet) => wallet.id === selectedWallet) ?? walletOptions[0]
  const availableWalletCount = walletOptions.filter((wallet) => wallet.isAvailable).length
  const shortAddress = address ? `${address.slice(0, 8)}...${address.slice(-6)}` : 'Not connected'
  const campaignState = isFunded ? 'Goal reached' : `${formatAmount(remaining)} XLM remaining`
  const summaryItems = [
    {
      label: 'Raised',
      value: `${formatAmount(raised)} XLM`,
    },
    {
      label: 'Goal',
      value: `${goal.toLocaleString()} XLM`,
    },
  ]

  useEffect(() => {
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: Networks.TESTNET,
      authModal: {
        showInstallLabel: true,
        hideUnsupportedWallets: false,
      },
    })

    void StellarWalletsKit.refreshSupportedWallets()
      .then((wallets) => {
        const mappedWallets = wallets.map((wallet) => ({
          id: wallet.id,
          name: wallet.name,
          type: wallet.type,
          icon: wallet.icon,
          url: wallet.url,
          isAvailable: wallet.isAvailable,
        }))

        setWalletOptions(mappedWallets)
        const firstAvailableWallet = mappedWallets.find((wallet) => wallet.isAvailable)
        setSelectedWallet((currentSelected) => {
          if (currentSelected && mappedWallets.some((wallet) => wallet.id === currentSelected)) {
            return currentSelected
          }

          return firstAvailableWallet?.id ?? mappedWallets[0]?.id ?? ''
        })
      })
      .finally(() => {
        setWalletsReady(true)
      })
  }, [])

  useEffect(() => {
    const restoreState = async () => {
      setSyncStatus('pending')
      try {
        const snapshot = await getContractSnapshot()
        setGoal(snapshot.goal)
        setRaised(snapshot.raised)
        setContractOwner(snapshot.owner)
        setSyncStatus('success')
      } catch (error) {
        setSyncStatus('error')
        setMessage(error instanceof Error ? error.message : 'Unable to read contract state.')
      }
    }

    if (!hasBootedRef.current) {
      hasBootedRef.current = true
      void restoreState()
    }

    const timer = window.setInterval(() => {
      void restoreState()
    }, POLL_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])

  const markError = (code: WalletErrorInfo['code'], message: string) => {
    setStatus('error')
    setErrorInfo({ code, message })
    setMessage(message)
  }

  const pushDebugStep = (step: string) => {
    console.debug(`[ui] ${step}`)
  }

  const buildWalletError = (rawMessage: string) => {
    const normalized = rawMessage.toLowerCase()

    if (normalized.includes('reject')) {
      return {
        code: 'user-rejected' as const,
        message: 'You rejected the wallet request. Please approve it in your wallet app and try again.',
      }
    }

    if (normalized.includes('not found') || normalized.includes('not installed') || normalized.includes('missing')) {
      return {
        code: 'wallet-not-found' as const,
        message: `No available ${selectedWalletOption?.name?.toUpperCase() ?? 'wallet'} wallet was found. Install, unlock, or switch to a supported wallet.`,
      }
    }

    return {
      code: 'wallet-unavailable' as const,
      message: `The selected ${selectedWalletOption?.name?.toUpperCase() ?? 'wallet'} wallet could not be reached. Open it, unlock it, and retry.`,
    }
  }

  const isWalletAvailable = (walletId: string) => walletOptions.find((wallet) => wallet.id === walletId)?.isAvailable ?? false

  const connectWallet = async () => {
    setErrorInfo(null)
    setStatus('pending')
    setMessage('Opening the wallet selector...')
    pushDebugStep(`Connecting with ${selectedWalletOption?.name?.toUpperCase() ?? 'wallet'}`)

    if (!selectedWallet || !isWalletAvailable(selectedWallet)) {
      markError(
        'wallet-not-found',
        `The selected wallet is not available in this browser. Choose one of the available Stellar wallets below.`,
      )
      pushDebugStep('Wallet unavailable in browser')
      return
    }

    try {
      StellarWalletsKit.setWallet(selectedWallet)
      const { address: walletAddress } = await StellarWalletsKit.fetchAddress()
      setAddress(walletAddress)
      setStatus('success')
      setMessage(`Connected to ${selectedWalletOption?.name ?? 'wallet'} and ready to sign.`)
      pushDebugStep(`Wallet connected: ${walletAddress.slice(0, 8)}...`)
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Wallet connection failed.'
      const walletError = buildWalletError(rawMessage)
      markError(walletError.code, walletError.message)
      pushDebugStep(`Wallet connection failed: ${rawMessage}`)
    }
  }

  const readAmount = () => {
    const donationAmount = Number(amount)
    if (!Number.isFinite(donationAmount) || donationAmount <= 0) {
      throw new Error('Enter a valid donation amount.')
    }

    if (donationAmount > 1000000) {
      throw new Error('Donation amount is too large for this testnet example.')
    }

    return donationAmount
  }

  const donate = async () => {
    if (!address) {
      markError('wallet-not-found', 'Connect a wallet before donating.')
      pushDebugStep('Donation blocked: no connected wallet')
      return
    }

    let donationAmount = 0
    try {
      donationAmount = readAmount()
    } catch (error) {
      markError('insufficient-balance', error instanceof Error ? error.message : 'Enter a valid donation amount.')
      pushDebugStep('Donation blocked: invalid amount')
      return
    }

    setStatus('pending')
    setTxHash('')
    setMessage('Preparing a real Soroban contract call on testnet...')
    setSyncStatus('pending')
    pushDebugStep(`Preparing donation for ${donationAmount} XLM`)

    try {
      pushDebugStep('Building donation transaction')
      const tx = await buildDonationTransaction({
        donor: address,
        amount: donationAmount,
        rewardContractId,
      })

      pushDebugStep('Signing donation transaction')
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(tx.toXDR(), {
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
        address,
      })

      pushDebugStep('Submitting signed transaction')
      const submit = await submitSignedTransaction(signedTxXdr)
      setStatus(submit.status === 'ERROR' ? 'error' : 'success')
      setMessage(
        submit.status === 'PENDING'
          ? 'Transaction signed and submitted. The network is still confirming it.'
          : submit.status === 'ERROR'
            ? 'The network rejected the submitted transaction.'
            : 'Donation accepted by the network.',
      )

      setTxHash(submit.hash ?? `pending:${address.slice(0, 8)}:${Date.now()}`)
      setRaised((current) => current + donationAmount)
      setContractEvents((events) => [
        {
          id: `donation-${Date.now()}`,
          kind: 'donation',
          donor: address,
          amount: donationAmount,
          status: submit.status === 'ERROR' ? 'error' : 'success',
        },
        ...events,
      ])

      try {
        pushDebugStep('Refreshing contract snapshot')
        const snapshot = await getContractSnapshot()
        setGoal(snapshot.goal)
        setRaised(snapshot.raised)
        setContractOwner(snapshot.owner)
        setSyncStatus('success')
        pushDebugStep('Donation flow completed')
      } catch (snapshotError) {
        const snapshotMessage =
          snapshotError instanceof Error ? snapshotError.message : 'Unable to refresh contract state.'
        setSyncStatus('error')
        setMessage(snapshotMessage)
        pushDebugStep(`Snapshot refresh failed: ${snapshotMessage}`)
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Donation transaction failed.'
      const normalized = rawMessage.toLowerCase()

      if (normalized.includes('unsupported reward contract address') || normalized.includes('[reward-contract]')) {
        markError('contract-address-invalid', rawMessage)
      } else if (normalized.includes('insufficient')) {
        markError('insufficient-balance', rawMessage)
      } else if (normalized.includes('reject')) {
        markError('user-rejected', rawMessage)
      } else {
        markError('wallet-unavailable', rawMessage)
      }
      setSyncStatus('error')
      pushDebugStep(`Donation failed: ${rawMessage}`)
    }
  }

  return (
    <main className="page-shell">
      <section className="dashboard-grid">
        <article className="dashboard-card summary-card">
          <div className="card-head">
            <div>
              <h1><strong>crowdfunding</strong></h1>
            </div>
          </div>

          <div className="summary-grid" aria-label="Campaign summary">
            {summaryItems.map((item) => (
              <div key={item.label} className="summary-item">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>

          <div className="progress-panel">
            <div className="progress-label-row">
              <span>{campaignState}</span>
              <strong>{percent}%</strong>
            </div>
            <div className="progress-bar" aria-label="Crowdfunding progress">
              <div style={{ width: `${percent}%` }} />
            </div>
          </div>

          <div className="wallet-section">
            <div className="section-heading compact">
              <div>
                <h2>Wallets</h2>
              </div>
              <strong>{availableWalletCount} ready</strong>
            </div>

            <div className="wallet-option-grid">
              {walletOptions.length === 0 ? (
                <div className="wallet-empty">Scanning supported wallets...</div>
              ) : (
                walletOptions.map((wallet) => (
                  <button
                    key={wallet.id}
                    type="button"
                    className={`${selectedWallet === wallet.id ? 'wallet-chip active' : 'wallet-chip'}${
                      !wallet.isAvailable ? ' disabled' : ''
                    }`}
                    onClick={() => setSelectedWallet(wallet.id)}
                    disabled={!wallet.isAvailable}
                  >
                    <div className="wallet-chip-top">
                      <img src={wallet.icon} alt="" aria-hidden="true" />
                      <span className={`wallet-badge ${wallet.isAvailable ? 'available' : 'unavailable'}`}>
                        {wallet.isAvailable ? 'Installed' : 'Install'}
                      </span>
                    </div>
                    <strong>{wallet.name}</strong>
                  </button>
                ))
              )}
            </div>
          </div>
        </article>

        <article className="dashboard-card action-card">
          <div className="card-head">
            <div>
              <h2>Sign and send</h2>
            </div>
            <span className={`status-pill status-${status}`}>{status.toUpperCase()}</span>
          </div>

          <p className="lead compact-lead">{message}</p>

          <div className="button-row">
            <button type="button" onClick={connectWallet} className="primary-btn" disabled={!walletsReady}>
              {address ? 'Switch wallet' : 'Connect wallet'}
            </button>
          </div>

          <label className="field">
            <span>Amount</span>
            <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="1" />
          </label>

          <button type="button" onClick={donate} className="primary-btn donate-btn">
            Donate
          </button>

          {errorInfo ? (
            <div className="error-box">
              <strong>{errorInfo.code}</strong>
              <p>{errorInfo.message}</p>
            </div>
          ) : null}

          <div className="compact-details">
            <div>
              <span>Wallet</span>
              <code>{selectedWalletOption?.name ?? 'Select'}</code>
            </div>
            <div>
              <span>Address</span>
              <code>{shortAddress}</code>
            </div>
            <div>
              <span>Contract</span>
              <code>{CONTRACT_ID}</code>
            </div>
            <div>
              <span>Events</span>
              <code>{contractEvents.length}</code>
            </div>
            <div>
              <span>Owner</span>
              <code>{contractOwner}</code>
            </div>
            <div>
              <span>Explorer</span>
              <a href={testnetExplorerUrl(CONTRACT_ID)} target="_blank" rel="noreferrer">
                View on Explorer
              </a>
            </div>
          </div>

          {txHash ? (
            <div className="tx-box">
              <span>Transaction</span>
              <code>{txHash}</code>
            </div>
          ) : null}
        </article>
      </section>
    </main>
  )
}

export default App
