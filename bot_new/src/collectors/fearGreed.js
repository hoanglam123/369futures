'use strict';

/**
 * Lấy chỉ số Fear & Greed (Sợ hãi & Tham lam) từ Alternative.me
 * API miễn phí, không cần key: https://alternative.me/crypto/fear-and-greed-index/
 *
 * Ý nghĩa chỉ số:
 *  0–24   : Sợ hãi cực độ (Extreme Fear) 😱
 *  25–44  : Sợ hãi (Fear) 😨
 *  45–55  : Trung lập (Neutral) 😐
 *  56–75  : Tham lam (Greed) 😊
 *  76–100 : Tham lam cực độ (Extreme Greed) 🤑
 */

const axios = require('axios');

// Bảng dịch sang tiếng Việt
const CLASSIFICATION_VI = {
  'Extreme Fear': 'Sợ hãi cực độ',
  'Fear': 'Sợ hãi',
  'Neutral': 'Trung lập',
  'Greed': 'Tham lam',
  'Extreme Greed': 'Tham lam cực độ'
};

/**
 * Lấy chỉ số Fear & Greed hiện tại
 * @returns {{ value: number, classification: string, classificationVi: string }}
 */
async function getFearGreedIndex() {
  const { data } = await axios.get('https://api.alternative.me/fng/', {
    params: { limit: 1 },
    timeout: 10000,
    headers: { 'User-Agent': 'crypto-news-bot/1.0' }
  });

  const entry = data.data?.[0];
  if (!entry) throw new Error('Không có dữ liệu Fear & Greed');

  const value = parseInt(entry.value, 10);
  const classification = entry.value_classification;

  return {
    value,
    classification,
    classificationVi: CLASSIFICATION_VI[classification] || classification
  };
}

module.exports = { getFearGreedIndex };
