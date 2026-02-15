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

    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 10000 }
    );

    const confirmedLtc = res.data.total_received / 1e8;
    const confirmedUsd = confirmedLtc * price;
    const unconfirmedLtc = res.data.unconfirmed_received / 1e8;
    const unconfirmedUsd = unconfirmedLtc * price;
    const totalUsd = confirmedUsd + unconfirmedUsd;

    console.log(
      `[Payment Check] ${address}: $${confirmedUsd.toFixed(2)} confirmed + $${unconfirmedUsd.toFixed(2)} unconfirmed = $${totalUsd.toFixed(2)} / $${expectedUsd} expected`
    );

    const tolerance = expectedUsd * 0.01;
    const requiredAmount = expectedUsd - tolerance;

    if (totalUsd >= requiredAmount) {
      if (res.data.unconfirmed_n_tx > 0) {
        console.log(`[Payment Check] Payment detected with ${res.data.unconfirmed_n_tx} unconfirmed tx(s)`);
      }
      return true;
    }

    return false;

  } catch (err) {
    if (err.response?.status === 429) {
      console.error('BlockCypher rate limit hit');
    } else if (err.response?.status === 404) {
      console.log(`[Payment Check] ${address}: No transactions yet`);
      return false;
    } else {
      console.error('Error checking payment:', err.message);
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

module.exports = { checkPayment, getLtcPriceUSD, getAddressInfo, getTransaction };
