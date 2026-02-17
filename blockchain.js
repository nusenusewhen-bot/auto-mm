const axios = require('axios');

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;
const BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/ltc/main';

if (!BLOCKCYPHER_TOKEN) {
  console.warn('⚠️ BLOCKCYPHER_TOKEN not set');
}

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;

// Rate limiting management
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 250;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequest(url, options = {}) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await delay(MIN_REQUEST_INTERVAL - timeSinceLastRequest);
  }
  
  try {
    lastRequestTime = Date.now();
    const res = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'LTC-Bot/1.0' },
      ...options
    });
    return res;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[Blockchain] Rate limited, waiting 2s...');
      await delay(2000);
      return makeRequest(url, options);
    }
    throw err;
  }
}

async function getLtcPriceUSD() {
  const now = Date.now();
  if (now - priceCache.timestamp < CACHE_DURATION && priceCache.value > 0) {
    return priceCache.value;
  }

  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd',
      { timeout: 5000 }
    );
    priceCache = { value: res.data.litecoin.usd, timestamp: now };
    return priceCache.value;
  } catch (err) {
    console.error('Failed to fetch LTC price:', err.message);
    return priceCache.value || 0;
  }
}

async function checkTransactionMempool(address) {
  if (!address) return null;
  
  try {
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}?token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);
    
    if (res.data.unconfirmed_n_tx > 0 && res.data.unconfirmed_txrefs?.length > 0) {
      return res.data.unconfirmed_txrefs[0].tx_hash;
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function checkPayment(address, expectedUsd) {
  try {
    const price = await getLtcPriceUSD();
    if (price === 0) return false;

    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);

    const confirmedLtc = (res.data.balance || 0) / 1e8;
    const unconfirmedLtc = (res.data.unconfirmed_balance || 0) / 1e8;
    const totalLtc = confirmedLtc + unconfirmedLtc;
    const totalUsd = totalLtc * price;

    const minAmount = expectedUsd * 0.85;
    
    if (totalUsd >= minAmount && totalLtc > 0) return true;
    return false;

  } catch (err) {
    console.error('Error checking payment:', err.message);
    return false;
  }
}

async function getAddressInfo(address) {
  try {
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}?token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);
    return res.data;
  } catch (err) {
    console.error('Error fetching address info:', err.message);
    return null;
  }
}

async function getTransaction(txid) {
  try {
    const url = `${BLOCKCYPHER_BASE}/txs/${txid}?token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);
    return res.data;
  } catch (err) {
    console.error('Error fetching transaction:', err.message);
    return null;
  }
}

// IMPROVED UTXO FETCHING - Use full address endpoint and filter
async function getAddressUTXOs(address) {
  const utxos = [];
  
  try {
    // Use full address endpoint instead of unspentOnly (more reliable)
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}?token=${BLOCKCYPHER_TOKEN}`;
    console.log(`[Blockchain] Fetching address data for ${address}`);
    
    const res = await makeRequest(url);
    const data = res.data;
    
    console.log(`[Blockchain] Address data: balance=${data.balance}, unconfirmed=${data.unconfirmed_balance}, n_tx=${data.n_tx}`);
    
    // Method 1: Use txrefs (all transactions)
    if (data.txrefs && data.txrefs.length > 0) {
      for (const tx of data.txrefs) {
        // Only include outputs (tx_output_n >= 0) that are unspent
        if (tx.tx_output_n >= 0) {
          utxos.push({
            txid: tx.tx_hash,
            vout: tx.tx_output_n,
            value: tx.value,
            confirmations: tx.confirmations || 0
          });
        }
      }
    }
    
    // Method 2: Also check unconfirmed transactions
    if (data.unconfirmed_txrefs && data.unconfirmed_txrefs.length > 0) {
      for (const tx of data.unconfirmed_txrefs) {
        if (tx.tx_output_n >= 0) {
          // Check if already added
          const exists = utxos.some(u => u.txid === tx.tx_hash && u.vout === tx.tx_output_n);
          if (!exists) {
            utxos.push({
              txid: tx.tx_hash,
              vout: tx.tx_output_n,
              value: tx.value,
              confirmations: 0
            });
          }
        }
      }
    }
    
    console.log(`[Blockchain] Found ${utxos.length} UTXOs total`);
    return utxos;
    
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[Blockchain] Address ${address} not found (no transactions yet)`);
      return [];
    }
    console.error('[Blockchain] Error fetching UTXOs:', err.message);
    return [];
  }
}

// Get transaction hex for building transactions
async function getTransactionHex(txid) {
  try {
    const url = `${BLOCKCYPHER_BASE}/txs/${txid}?includeHex=true&token=${BLOCKCYPHER_TOKEN}`;
    const res = await makeRequest(url);
    return res.data.hex;
  } catch (err) {
    console.error(`[Blockchain] Failed to get tx hex for ${txid}:`, err.message);
    return null;
  }
}

module.exports = { 
  checkPayment, 
  getLtcPriceUSD, 
  getAddressInfo, 
  getTransaction, 
  checkTransactionMempool, 
  getAddressUTXOs,
  getTransactionHex,
  delay
};
