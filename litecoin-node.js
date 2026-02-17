const axios = require('axios');

const NODE_URL = process.env.LITECOIN_NODE_URL;
const RPC_USER = process.env.LITECOIN_RPC_USER || 'user';
const RPC_PASS = process.env.LITECOIN_RPC_PASSWORD || 'pass';

// Check if node is configured
function isNodeConfigured() {
  return !!NODE_URL;
}

// Make RPC call to your own node
async function rpcCall(method, params = []) {
  if (!isNodeConfigured()) return null;
  
  try {
    const res = await axios.post(NODE_URL, {
      jsonrpc: '2.0',
      id: 'ltc-bot',
      method: method,
      params: params
    }, {
      auth: {
        username: RPC_USER,
        password: RPC_PASS
      },
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (res.data.error) {
      throw new Error(res.data.error.message);
    }
    
    return res.data.result;
  } catch (err) {
    console.error(`[LTC Node] RPC ${method} failed:`, err.message);
    return null;
  }
}

// Get balance for address using your own node
async function getAddressBalanceNode(address) {
  try {
    // Import address to watch (does nothing if already imported)
    await rpcCall('importaddress', [address, '', false]);
    
    // Get unspent outputs for address
    const utxos = await rpcCall('listunspent', [0, 9999999, [address]]);
    
    if (!utxos || !Array.isArray(utxos)) {
      return { confirmed: 0, unconfirmed: 0, total: 0, source: 'own-node' };
    }
    
    let confirmed = 0;
    let unconfirmed = 0;
    
    for (const utxo of utxos) {
      if (utxo.confirmations > 0) {
        confirmed += utxo.amount;
      } else {
        unconfirmed += utxo.amount;
      }
    }
    
    return {
      confirmed,
      unconfirmed,
      total: confirmed + unconfirmed,
      source: 'own-node'
    };
  } catch (err) {
    console.error('[LTC Node] Balance check failed:', err.message);
    return null;
  }
}

// Get UTXOs from your own node
async function getAddressUTXOsNode(address) {
  try {
    // Import address to watch
    await rpcCall('importaddress', [address, '', false]);
    
    // Get unspent outputs
    const utxos = await rpcCall('listunspent', [0, 9999999, [address]]);
    
    if (!utxos || !Array.isArray(utxos)) return [];
    
    return utxos.map(utxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: Math.floor(utxo.amount * 1e8),
      confirmations: utxo.confirmations
    }));
  } catch (err) {
    console.error('[LTC Node] UTXO fetch failed:', err.message);
    return [];
  }
}

// Get raw transaction from your node
async function getTransactionHexNode(txid) {
  try {
    return await rpcCall('getrawtransaction', [txid]);
  } catch (err) {
    console.error('[LTC Node] Get raw tx failed:', err.message);
    return null;
  }
}

// Broadcast transaction through your node
async function broadcastTransactionNode(txHex) {
  try {
    const txid = await rpcCall('sendrawtransaction', [txHex]);
    return { success: true, txid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Check if node is synced
async function isNodeSynced() {
  if (!isNodeConfigured()) return false;
  
  try {
    const info = await rpcCall('getblockchaininfo');
    if (!info) return false;
    return info.blocks >= info.headers - 10;
  } catch (err) {
    return false;
  }
}

// Get mempool info (for pending transactions)
async function getMempoolInfo() {
  try {
    return await rpcCall('getmempoolinfo');
  } catch (err) {
    return null;
  }
}

module.exports = {
  isNodeConfigured,
  getAddressBalanceNode,
  getAddressUTXOsNode,
  getTransactionHexNode,
  broadcastTransactionNode,
  isNodeSynced,
  getMempoolInfo,
  rpcCall
};
