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

/**
 * Normalizes customer name and vendor code strictly to standard preset names.
 * Wherever vendor code is 7201012 or customer name mentions MBP/Pantnagar/ASL & Switch,
 * it returns 'ASL PNR MBP' (7201012).
 */
export function normalizeCustomerPreset(customerName, vendorCode) {
  const v = (vendorCode || '').trim();
  const c = (customerName || '').trim();
  const vUpper = v.toUpperCase();
  const cLower = c.toLowerCase();

  // 1. Pantnagar (7201012)
  if (
    v === '7201012' ||
    cLower.includes('7201012') ||
    cLower === 'mbp' ||
    cLower.includes('asl & switch') ||
    cLower.includes('pantnagar') ||
    cLower.includes('all_p') ||
    (cLower.includes('asl') && cLower.includes('pnr'))
  ) {
    return { customer_name: 'ASL PNR MBP', vendor_code: '7201012' };
  }

  // 2. Alwar (7205761)
  if (
    v === '7205761' ||
    cLower.includes('7205761') ||
    cLower.includes('alwar') ||
    (cLower.includes('asl') && cLower.includes('alw'))
  ) {
    return { customer_name: 'ASL ALW MBP', vendor_code: '7205761' };
  }

  // 3. Hosur (7200868)
  if (
    v === '7200868' ||
    cLower.includes('7200868') ||
    cLower.includes('hosur') ||
    (cLower.includes('asl') && cLower.includes('alh'))
  ) {
    return { customer_name: 'ASL ALH MBP', vendor_code: '7200868' };
  }

  // 4. Switch Mobility (7207001)
  if (
    v === '7207001' ||
    cLower.includes('7207001') ||
    (cLower.includes('switch') && !cLower.includes('&') && !cLower.includes('7201012'))
  ) {
    return { customer_name: 'Switch Mobility', vendor_code: '7207001' };
  }

  // 5. Tata Motors (R64535)
  if (
    vUpper === 'R64535' ||
    cLower.includes('r64535') ||
    cLower.includes('tml') ||
    cLower.includes('tata')
  ) {
    return { customer_name: 'Tata Motors (TML)', vendor_code: 'R64535' };
  }

  // 6. IPLT (10830-6)
  if (
    v === '10830-6' ||
    cLower.includes('10830-6') ||
    cLower.includes('iplt')
  ) {
    return { customer_name: 'IPLT', vendor_code: '10830-6' };
  }

  // 7. VECV (V113072)
  if (
    vUpper === 'V113072' ||
    v === '113072' ||
    cLower.includes('v113072') ||
    cLower.includes('113072') ||
    cLower.includes('vecv') ||
    cLower.includes('commercial vehicles')
  ) {
    return { customer_name: 'VE Commercial Vehicles (VECV)', vendor_code: 'V113072' };
  }

  return { customer_name: c || null, vendor_code: v || null };
}
