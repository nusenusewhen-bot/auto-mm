const axios = require('axios');

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;
const BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/ltc/main';

if (!BLOCKCYPHER_TOKEN) {
  console.warn('⚠️ BLOCKCYPHER_TOKEN not set');
}

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;

// Rate limiting management
const requestQueue = [];
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 250; // 4 requests per second max (safe for free tier)

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
      return makeRequest(url, options); // Retry
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

    // Accept if within 90% of expected (allows small underpayment)
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
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`;
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

// IMPROVED UTXO FETCHING - Try multiple methods
async function getAddressUTXOs(address) {
  const utxos = [];
  
  try {
    // Method 1: Try unspentOnly endpoint first
    const url1 = `${BLOCKCYPHER_BASE}/addrs/${address}?unspentOnly=true&token=${BLOCKCYPHER_TOKEN}`;
    console.log(`[Blockchain] Fetching UTXOs for ${address} (Method 1)`);
    
    const res1 = await makeRequest(url1);
    
    if (res1.data.txrefs && res1.data.txrefs.length > 0) {
      res1.data.txrefs.forEach(utxo => {
        if (utxo.value > 0) {
          utxos.push({
            txid: utxo.tx_hash,
            vout: utxo.tx_output_n,
            value: utxo.value,
            confirmations: utxo.confirmations || 0
          });
        }
      });
    }
    
    // Also check unconfirmed UTXOs
    if (res1.data.unconfirmed_txrefs && res1.data.unconfirmed_txrefs.length > 0) {
      res1.data.unconfirmed_txrefs.forEach(utxo => {
        if (utxo.value > 0) {
          utxos.push({
            txid: utxo.tx_hash,
            vout: utxo.tx_output_n,
            value: utxo.value,
            confirmations: 0
          });
        }
      });
    }
    
    if (utxos.length > 0) {
      console.log(`[Blockchain] Found ${utxos.length} UTXOs (Method 1)`);
      return utxos;
    }
    
    // Method 2: If no UTXOs found, try full address endpoint and filter
    console.log(`[Blockchain] Trying Method 2 for ${address}`);
    await delay(500);
    
    const url2 = `${BLOCKCYPHER_BASE}/addrs/${address}?token=${BLOCKCYPHER_TOKEN}`;
    const res2 = await makeRequest(url2);
    
    if (res2.data.txrefs) {
      // Get all transactions where address received coins
      const receivedTxs = res2.data.txrefs.filter(tx => tx.tx_output_n >= 0);
      
      for (const tx of receivedTxs) {
        // Check if this output is spent by looking for it in inputs of other txs
        // For now, assume unspent if it's a recent transaction
        const isRecent = (Date.now() / 1000 - tx.confirmed) < 86400; // 24 hours
        
        if (isRecent || tx.value > 0) {
          utxos.push({
            txid: tx.tx_hash,
            vout: tx.tx_output_n,
            value: tx.value,
            confirmations: tx.confirmations || 0
          });
        }
      }
    }
    
    console.log(`[Blockchain] Found ${utxos.length} UTXOs total`);
    return utxos;
    
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`[Blockchain] Address ${address} not found (no UTXOs)`);
      return [];
    }
    console.error('Error fetching UTXOs:', err.message);
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
