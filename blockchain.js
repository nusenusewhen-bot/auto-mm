const axios = require('axios');

// Updated BlockCypher token
const BLOCKCYPHER_TOKEN = '275f4d25900e4b399ddfb9dc4b410fcc';

// Fetch LTC price in USD
async function getLtcPriceUSD() {
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd'
    );
    return res.data.litecoin.usd;
  } catch (err) {
    console.error('Failed to fetch LTC price:', err.message);
    return 0;
  }
}

// Check if LTC deposit has reached the expected USD amount
async function checkPayment(address, expectedUsd) {
  try {
    const price = await getLtcPriceUSD();
    if (price === 0) return false;

    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`
    );

    const receivedLtc = res.data.total_received / 1e8; // Convert satoshis to LTC
    const receivedUsd = receivedLtc * price;

    console.log(
      `[Payment Check] ${address} received $${receivedUsd.toFixed(
        2
      )} (expected $${expectedUsd})`
    );

    return receivedUsd >= expectedUsd;
  } catch (err) {
    console.error('Error checking payment:', err.message);
    return false;
  }
}

module.exports = { checkPayment };
