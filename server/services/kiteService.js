const axios = require('axios');
const store = require('../store');

const KITE_BASE = 'https://api.kite.trade';

function buildHeaders() {
  const { kite } = store.getConfig();
  if (!kite.apiKey || !kite.accessToken) {
    throw new Error('Kite API key and access token are not configured');
  }
  return {
    'X-Kite-Version': '3',
    Authorization: `token ${kite.apiKey}:${kite.accessToken}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function toFormData(params) {
  return new URLSearchParams(params).toString();
}

/**
 * Place a regular or SL order.
 * params: { tradingsymbol, exchange, transaction_type, quantity, product,
 *           order_type, price?, trigger_price?, trailing_stoploss? }
 */
async function placeOrder(params) {
  const variety = params.variety || 'regular';
  const response = await axios.post(
    `${KITE_BASE}/orders/${variety}`,
    toFormData(params),
    { headers: buildHeaders() },
  );
  return response.data;
}

/**
 * Place a GTT (Good Till Triggered) order.
 * params: { type, tradingsymbol, exchange, trigger_values[], last_price, orders[] }
 */
async function placeGTT(params) {
  const response = await axios.post(
    `${KITE_BASE}/gtt/triggers`,
    toFormData({
      type: params.type || 'single',
      tradingsymbol: params.tradingsymbol,
      exchange: params.exchange,
      trigger_values: JSON.stringify(params.trigger_values),
      last_price: params.last_price,
      orders: JSON.stringify(params.orders),
    }),
    { headers: buildHeaders() },
  );
  return response.data;
}

async function getOrders() {
  const response = await axios.get(`${KITE_BASE}/orders`, { headers: buildHeaders() });
  return response.data;
}

async function getOrder(orderId) {
  const response = await axios.get(`${KITE_BASE}/orders/${orderId}`, { headers: buildHeaders() });
  return response.data;
}

module.exports = { placeOrder, placeGTT, getOrders, getOrder };
