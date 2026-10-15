import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Parametri di Simulazione
const INITIAL_BALANCE = parseFloat(process.env.INITIAL_BALANCE_SOL || '1.0');
const TRADE_SIZE = parseFloat(process.env.TRADE_SIZE_SOL || '0.1');
const TAKE_PROFIT = parseFloat(process.env.PROFIT_TARGET_PERCENT || '0.02');
const STOP_LOSS = parseFloat(process.env.STOP_LOSS_PERCENT || '0.05');
const FEE = parseFloat(process.env.FEE_PERCENT || '0.004');
const MIN_LIQUIDITY = parseFloat(process.env.MIN_LIQUIDITY_USD || '25000');
const MIN_VOLUME_24H = parseFloat(process.env.MIN_VOLUME_24H_USD || '20000');
const MAX_HOLD_MS = parseFloat(process.env.MAX_HOLD_MINUTES || '30') * 60_000;
const RISK_SCORE_MAX = parseFloat(process.env.RUGCHECK_MAX_SCORE || '500');
const MIN_PAIR_AGE_MS = parseFloat(process.env.MIN_PAIR_AGE_MINUTES || '30') * 60_000;
const MAX_PAIR_AGE_MS = parseFloat(process.env.MAX_PAIR_AGE_HOURS || '24') * 3_600_000;

let virtualBalance = INITIAL_BALANCE;
let isTrading = false;

let wins = 0;
let losses = 0;

const triedTokens = new Set<string>();
const safetyCache = new Map<string, boolean>();

interface TokenOpportunity {
  chainId?: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  priceUsd: string;
  liquidity: { usd: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Controllo Sicurezza (Anti-Scam)
async function isSafeToken(mintAddress: string): Promise<boolean> {
  const cached = safetyCache.get(mintAddress);
  if (cached !== undefined) return cached;

  let safe = false;
  try {
    const response = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
      { timeout: 8000 }
    );
    const score: number = response.data?.score ?? 1000;
    const risks: any[] = response.data?.risks ?? [];
    const hasDanger = risks.some((r) => r?.level === 'danger');

    if (score < RISK_SCORE_MAX && !hasDanger) {
      console.log(`✅ [SAFETY CHECK] Token sicuro! Score: ${score}`);
      safe = true;
    } else {
      console.log(`⚠️ [SAFETY CHECK] Scartato. Punteggio Rischio: ${score}${hasDanger ? ' (rischi "danger")' : ''}`);
    }
  } catch (error) {
    console.log(`❌ [SAFETY CHECK] Errore verifica RugCheck per ${mintAddress}. Scartato per sicurezza.`);
    return false;
  }
  safetyCache.set(mintAddress, safe);
  return safe;
}

// 2. Simulatore di Gestione Posizione (Paper Trade)
async function simulateTrade(token: TokenOpportunity) {
  const entryPrice = parseFloat(token.priceUsd);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;

  triedTokens.add(token.baseToken.address);
  console.log(`\n🚀 [PAPER BUY] Acquistato: ${token.baseToken.symbol}`);
  console.log(`💵 Prezzo di Entrata: $${entryPrice} | Importo Virtuale: ${TRADE_SIZE} SOL`);

  let currentPrice = entryPrice;
  const deadline = Date.now() + MAX_HOLD_MS;

  while (true) {
    await sleep(2000);

    try {
      const res = await axios.get(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${token.pairAddress}`,
        { timeout: 8000 }
      );
      const pairData = res.data?.pair ?? res.data?.pairs?.[0];
      const p = parseFloat(pairData?.priceUsd);
      if (Number.isFinite(p) && p > 0) currentPrice = p;
    } catch (err) {
      console.log('Errore aggiornamento prezzo...');
    }

    const net = (currentPrice * (1 - FEE)) / (entryPrice * (1 + FEE)) - 1;
    const profitPercent = (net * 100).toFixed(2);

    console.log(`📊 [LIVE] ${token.baseToken.symbol}: $${currentPrice} (${profitPercent}% netto)`);

    let reason: string | null = null;
    if (net >= TAKE_PROFIT) reason = 'TAKE PROFIT';
    else if (net <= -STOP_LOSS) reason = 'STOP LOSS';
    else if (Date.now() >= deadline) reason = 'TIMEOUT';

    if (reason) {
      const pnlSol = TRADE_SIZE * net;
      virtualBalance += pnlSol;
      if (pnlSol >= 0) wins++; else losses++;

      console.log(`${pnlSol >= 0 ? '🎯' : '🛑'} [${reason}] CHIUSO (${profitPercent}%) | PnL: ${pnlSol.toFixed(4)} SOL`);
      console.log(`💰 Nuovo Saldo Virtuale: ${virtualBalance.toFixed(4)} SOL | Trade: ${wins + losses} (W:${wins} / L:${losses})`);
      return;
    }
  }
}

// 3. Scanner delle Nuove Coppie su Solana
async function fetchNewPairs(): Promise<TokenOpportunity[]> {
  const prof = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 8000 });
  const profiles: any[] = Array.isArray(prof.data) ? prof.data : [];

  const addresses = [
    ...new Set<string>(
      profiles.filter((t) => t?.chainId === 'solana' && t?.tokenAddress).map((t) => t.tokenAddress)
    ),
  ]
    .filter((a) => !triedTokens.has(a))
    .slice(0, 30);
  if (addresses.length === 0) return [];

  const res = await axios.get(
    `https://api.dexscreener.com/tokens/v1/solana/${addresses.join(',')}`,
    { timeout: 8000 }
  );
  const pairs: TokenOpportunity[] = Array.isArray(res.data) ? res.data : [];

  const best = new Map<string, TokenOpportunity>();
  for (const p of pairs) {
    const addr = p?.baseToken?.address;
    if (!addr) continue;
    const cur = best.get(addr);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(addr, p);
  }
  return [...best.values()].sort((a, b) => (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0));
}

async function scanMarket() {
  if (isTrading) return;
  isTrading = true;

  try {
    if (virtualBalance < TRADE_SIZE) {
      console.log('⛔ Saldo virtuale insufficiente per un altro trade.');
      return;
    }

    console.log('\n🔎 Ricerca nuove coppie/shitcoin su Solana...');
    const pairs = await fetchNewPairs();

    for (const pair of pairs) {
      if (pair.chainId !== 'solana') continue;
      if (triedTokens.has(pair.baseToken.address)) continue;
      if (!pair.pairCreatedAt) continue;
      const age = Date.now() - pair.pairCreatedAt;
      if (age < MIN_PAIR_AGE_MS || age > MAX_PAIR_AGE_MS) continue;
      if (!pair.liquidity || pair.liquidity.usd < MIN_LIQUIDITY) continue;
      if ((pair.volume?.h24 ?? 0) < MIN_VOLUME_24H) continue;

      console.log(`\n💡 Trovata Opportunità: ${pair.baseToken.name} (${pair.baseToken.symbol})`);

      const safe = await isSafeToken(pair.baseToken.address);
      if (safe) {
        await simulateTrade(pair);
        break;
      }
    }
  } catch (error) {
    console.error('Errore durante lo scan di mercato.');
  } finally {
    isTrading = false;
  }
}

console.log(`=== INIZIO SIMULAZIONE BOT SOLANA ===`);
console.log(`Capitale Iniziale: ${virtualBalance} SOL`);
console.log(`TP: ${TAKE_PROFIT * 100}% | SL: ${STOP_LOSS * 100}% | Fee/lato: ${FEE * 100}% | Max hold: ${MAX_HOLD_MS / 60000} min`);
setInterval(scanMarket, 10000);
