const axios = require('axios');

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;

if (!BLOCKCYPHER_TOKEN) {
  console.warn('⚠️ BLOCKCYPHER_TOKEN not set. Payment checking will fail.');
}

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;

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
  if (!BLOCKCYPHER_TOKEN || !address) return null;
  
  try {
    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 10000 }
    );
    
    if (res.data.unconfirmed_n_tx > 0 && res.data.unconfirmed_txrefs && res.data.unconfirmed_txrefs.length > 0) {
      return res.data.unconfirmed_txrefs[0].tx_hash;
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

async function checkPayment(address, expectedUsd) {
  if (!BLOCKCYPHER_TOKEN) {
    console.error('BLOCKCYPHER_TOKEN not configured');
    return false;
  }

  try {
    const price = await getLtcPriceUSD();
    if (price === 0) {
      console.error('Cannot check payment: LTC price unavailable');
      return false;
    }

    console.log(`[Payment Check] Checking: ${address}, Expecting: $${expectedUsd}, LTC Price: $${price}`);

    const res = await axios.get(
     
