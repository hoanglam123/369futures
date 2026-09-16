'use strict';

/**
 * Economic Calendar Guard — PP369
 * Giám sát các sự kiện vĩ mô biến động cực đại của Mỹ (CPI, FOMC, NFP)
 * Cung cấp Blackout Window tự động đóng băng lệnh trước/sau giờ tin tức.
 */

// Danh sách các mốc sự kiện lớn của Mỹ (UTC timestamp hoặc YYYY-MM-DD HH:mm UTC)
// FOMC: 18:00 UTC (Tuyên bố lãi suất) & 18:30 UTC (Họp báo)
// CPI & NFP: 12:30 UTC (13:30 mùa đông)
const RECURRING_HIGH_IMPACT_EVENTS_2025_2026 = [
  // 2026 High Impact Events (UTC)
  '2026-01-09 13:30', // NFP
  '2026-01-14 13:30', // CPI
  '2026-01-28 19:00', // FOMC Rate Decision
  '2026-02-06 13:30', // NFP
  '2026-02-11 13:30', // CPI
  '2026-03-06 13:30', // NFP
  '2026-03-11 12:30', // CPI
  '2026-03-18 18:00', // FOMC Rate Decision
  '2026-04-03 12:30', // NFP
  '2026-04-10 12:30', // CPI
  '2026-05-01 12:30', // NFP
  '2026-05-06 18:00', // FOMC Rate Decision
  '2026-05-13 12:30', // CPI
  '2026-06-05 12:30', // NFP
  '2026-06-10 12:30', // CPI
  '2026-06-17 18:00', // FOMC Rate Decision
  '2026-07-02 12:30', // NFP
  '2026-07-15 12:30', // CPI
  '2026-07-29 18:00', // FOMC Rate Decision
  '2026-08-07 12:30', // NFP
  '2026-08-12 12:30', // CPI
  '2026-09-04 12:30', // NFP
  '2026-09-11 12:30', // CPI
  '2026-09-16 18:00', // FOMC Rate Decision
  '2026-10-02 12:30', // NFP
  '2026-10-14 12:30', // CPI
  '2026-11-05 19:00', // FOMC Rate Decision
  '2026-11-06 13:30', // NFP
  '2026-11-12 13:30', // CPI
  '2026-12-04 13:30', // NFP
  '2026-12-09 13:30', // CPI
  '2026-12-16 19:00', // FOMC Rate Decision
  // 2025 High Impact Events (UTC)
  '2025-01-15 13:30', '2025-01-29 19:00', '2025-02-12 13:30',
  '2025-03-12 12:30', '2025-03-19 18:00', '2025-04-10 12:30',
  '2025-05-07 18:00', '2025-05-14 12:30', '2025-06-11 12:30',
  '2025-06-18 18:00', '2025-07-16 12:30', '2025-07-30 18:00',
  '2025-08-13 12:30', '2025-09-10 12:30', '2025-09-17 18:00',
  '2025-10-15 12:30', '2025-10-29 18:00', '2025-11-12 13:30',
  '2025-12-10 13:30', '2025-12-17 19:00'
];

// Chuyển đổi sang timestamp millisecond
const EVENT_TIMESTAMPS = RECURRING_HIGH_IMPACT_EVENTS_2025_2026.map(dStr => {
  const [datePart, timePart] = dStr.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, 0);
}).sort((a, b) => a - b);

/**
 * Kiểm tra xem một thời điểm có nằm trong vùng Blackout Window của tin đỏ hay không.
 * @param {number|Date} [targetTime=Date.now()] - Thời điểm kiểm tra (ms hoặc Date)
 * @param {number} [windowMinutes=30] - Khoảng thời gian đệm trước và sau tin (mặc định 30 phút)
 * @returns {{ isBlackout: boolean, eventName: string, minutesToEvent: number }}
 */
function checkEconomicBlackout(targetTime = Date.now(), windowMinutes = 30) {
  const checkMs = typeof targetTime === 'number' ? targetTime : new Date(targetTime).getTime();
  const windowMs = windowMinutes * 60 * 1000;

  for (const eventMs of EVENT_TIMESTAMPS) {
    const diffMs = eventMs - checkMs;
    const absDiffMs = Math.abs(diffMs);

    if (absDiffMs <= windowMs) {
      const minutesTo = Math.round(diffMs / 60000);
      let eventType = 'US CPI / NFP / FOMC';
      const eventDate = new Date(eventMs);
      const hoursUtc = eventDate.getUTCHours();
      if (hoursUtc >= 18) {
        eventType = 'FOMC Rate Decision & Press Conference';
      } else {
        eventType = 'US Inflation (CPI) / Employment (NFP)';
      }

      return {
        isBlackout: true,
        eventName: eventType,
        minutesToEvent: minutesTo,
        eventTimeIso: eventDate.toISOString()
      };
    }
  }

  return {
    isBlackout: false,
    eventName: 'CALENDAR_SAFE',
    minutesToEvent: 9999,
    eventTimeIso: null
  };
}

module.exports = {
  checkEconomicBlackout,
  EVENT_TIMESTAMPS
};
