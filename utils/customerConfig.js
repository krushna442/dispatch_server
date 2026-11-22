/**
 * customerConfig.js
 * Central customer mapping, vendor codes, official display names, and email subject formatting.
 */

export const CUSTOMERS = [
  {
    code: '7201012',
    shortName: 'ALL_P',
    displayName: 'Ashok Leyland Pantnagar',
    presetName: 'ASL PNR MBP',
    aliases: ['asl pnr', 'all_p', 'pantnagar', 'mbp', '7201012', 'asl pnr mbp']
  },
  {
    code: '7205761',
    shortName: 'ALL',
    displayName: 'Ashok Leyland Alwar',
    presetName: 'ASL ALW MBP',
    aliases: ['asl alw', 'all', 'alwar', '7205761', 'asl alw mbp']
  },
  {
    code: '7200868',
    shortName: 'ALL_H',
    displayName: 'Ashok Leyland Hosur',
    presetName: 'ASL ALH MBP',
    aliases: ['asl alh', 'all_h', 'hosur', '7200868', 'asl alh mbp']
  },
  {
    code: '7207001',
    shortName: 'SWITCH',
    displayName: 'Switch Mobility Lucknow',
    presetName: 'Switch Mobility',
    aliases: ['switch', 'switch mobility', '7207001', 'switch mobility lucknow']
  },
  {
    code: 'R64535',
    shortName: 'TML',
    displayName: 'Tata Motors Lucknow',
    presetName: 'Tata Motors (TML)',
    aliases: ['tml', 'tata', 'tata motors', 'r64535', 'tata motors lucknow']
  },
  {
    code: '10830-6',
    shortName: 'IPLT',
    displayName: 'IPLT',
    presetName: 'IPLT',
    aliases: ['iplt', '10830-6']
  },
  {
    code: 'V113072',
    shortName: 'VECV',
    displayName: 'VE Commercial Vehicles',
    presetName: 'VE Commercial Vehicles (VECV)',
    aliases: ['vecv', 'vecb', 'v113072', '113072', 've commercial vehicles']
  }
];

/**
 * Resolves customer info by matching customer name, vendor code, or alias
 * @param {string|null} customerName 
 * @param {string|null} vendorCode 
 * @returns {typeof CUSTOMERS[0]|null}
 */
export function getCustomerInfo(customerName, vendorCode) {
  const normCode = (vendorCode || '').trim().toUpperCase();
  const normCodeNoV = normCode.replace(/^V/, '');
  const normName = (customerName || '').trim().toLowerCase();

  for (const c of CUSTOMERS) {
    const cCode = c.code.toUpperCase();
    const cCodeNoV = cCode.replace(/^V/, '');
    
    // Direct code match
    if (normCode && (normCode === cCode || normCodeNoV === cCodeNoV)) {
      return c;
    }

    // Direct name match
    if (normName && (
      c.presetName.toLowerCase() === normName ||
      c.displayName.toLowerCase() === normName ||
      c.shortName.toLowerCase() === normName
    )) {
      return c;
    }

    // Alias match
    if (normName) {
      for (const alias of c.aliases) {
        if (normName.includes(alias)) {
          return c;
        }
      }
    }
  }

  // Fallback if not strictly recognized
  if (customerName || vendorCode) {
    return {
      code: vendorCode || 'UNKNOWN',
      shortName: (customerName || vendorCode || '').toUpperCase().slice(0, 8),
      displayName: customerName || `Vendor ${vendorCode}`,
      presetName: customerName || `Vendor ${vendorCode}`,
      aliases: []
    };
  }

  return null;
}

/**
 * Formats email subject with customer's name first, then activity
 * Example: "[Ashok Leyland Pantnagar] - Part Scanned: FEA73900 (SN: 009781)"
 * @param {string} activity Activity title/description
 * @param {string|null} customerName 
 * @param {string|null} vendorCode 
 * @returns {string}
 */
export function formatSubject(activity, customerName = null, vendorCode = null) {
  const info = getCustomerInfo(customerName, vendorCode);
  const custPrefix = info ? info.displayName : 'RSB Despatch';
  return `[${custPrefix}] - ${activity}`;
}
