const axios = require('axios');

async function checkPayment(address, expectedAmount) {
  try {
    const res = await axios.get(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance`);
    const received = res.data.total_received / 1e8;
    return received >= expectedAmount;
  } catch (err) {
    return false;
  }
}

module.exports = { checkPayment };
