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
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 10000 }
    );

    console.log(`[Payment Check] Raw data: total_received=${res.data.total_received}, unconfirmed_received=${res.data.unconfirmed_received}, n_tx=${res.data.n_tx}, unconfirmed_n_tx=${res.data.unconfirmed_n_tx}`);

    const confirmedLtc = (res.data.total_received || 0) / 1e8;
    const confirmedUsd = confirmedLtc * price;
    const unconfirmedLtc = (res.data.unconfirmed_received || 0) / 1e8;
    const unconfirmedUsd = unconfirmedLtc * price;
    const totalLtc = confirmedLtc + unconfirmedLtc;
    const totalUsd = confirmedUsd + unconfirmedUsd;

    console.log(
      `[Payment Check] ${address}: ${confirmedLtc.toFixed(8)} LTC ($${confirmedUsd.toFixed(4)}) confirmed + ` +
      `${unconfirmedLtc.toFixed(8)} LTC ($${unconfirmedUsd.toFixed(4)}) unconfirmed = ` +
      `${totalLtc.toFixed(8)} LTC ($${totalUsd.toFixed(4)}) total`
    );

    const minAmount = expectedUsd * 0.90;
    const maxAmount = expectedUsd * 1.20;
    
    console.log(`[Payment Check] Acceptable range: $${minAmount.toFixed(4)} - $${maxAmount.toFixed(4)}, Have: $${totalUsd.toFixed(4)}`);

    if (totalUsd >= minAmount && totalUsd <= maxAmount && totalLtc > 0) {
      if (res.data.unconfirmed_n_tx > 0) {
        console.log(`[Payment Check] ✅ Found transaction! ${res.data.unconfirmed_n_tx} unconfirmed`);
      } else {
        console.log(`[Payment Check] ✅ Payment confirmed!`);
      }
      return true;
    }

    if (totalUsd > maxAmount) {
      console.log(`[Payment Check] ⚠️ Overpayment detected: $${totalUsd.toFixed(4)} > $${maxAmount.toFixed(4)}`);
      return true;
    }

    if (totalUsd < minAmount) {
      console.log(`[Payment Check] ❌ Underpayment: $${totalUsd.toFixed(4)} < $${minAmount.toFixed(4)}`);
    }

    console.log(`[Payment Check] ❌ Not enough funds yet`);
    return false;

  } catch (err) {
    if (err.response?.status === 429) {
      console.error('BlockCypher rate limit hit');
    } else if (err.response?.status === 404) {
      console.log(`[Payment Check] ${address}: No transactions yet (404)`);
      return false;
    } else {
      console.error('Error checking payment:', err.message);
      if (err.response?.data) {
        console.error('Response:', JSON.stringify(err.response.data));
      }
    }
    return false;
  }
}

async function getAddressInfo(address) {
  try {
    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 10000 }
    );
    return res.data;
  } catch (err) {
    console.error('Error fetching address info:', err.message);
    return null;
  }
}

async function getTransaction(txid) {
  try {
    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/txs/${txid}?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 10000 }
    );
    return res.data;
  } catch (err) {
    console.error('Error fetching transaction:', err.message);
    return null;
  }
}

module.exports = { checkPayment, getLtcPriceUSD, getAddressInfo, getTransaction, checkTransactionMempool };
