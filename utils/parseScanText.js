/**
 * parseScanText.js
 * Parses scanned barcode text into structured fields.
 *
 * Supported formats:
 *  F1 – "FEA73900Rev No# 72057610426002246"
 *       PART_NO + "Rev No#" + REV(variable) + VENDOR(8) + MM(2) + YY(2) + SL(6)
 *       Customer: ASL & Switch Mobility
 *
 *  F2 – "$"-delimited
 *       "7205761$FEA73900$002246$07.04.2026$NA$NA$REV$..."
 *        [0]=VENDOR [1]=PART_NO [2]=SL [3]=DATE [4..5]=NA [6]=REV
 *
 *  F3 – Fixed-width numeric block (no spaces / delimiters)
 *       00 + PART_NO(12) + REV(2) + VENDOR(6|7|8) + MM(2) + YY(2) + SL(6)
 *       Leading "00" is stripped from the 14-char block to get the real 12-digit part number.
 *       Customer: TML
 *
 *  F4 – "#"-delimited with P/T/V prefix markers
 *       "PID628567A#T15042026005687#V113072#"
 *        P[plant][PART_NO] # T[DD][MM][YYYY][SL] # V[VENDOR] #
 *       Customer: VECB
 *
 *  F5 – Fixed-width with embedded "V" vendor marker (no delimiters)
 *       "ID628567AV113072150426005688"
 *        [plant(1)] + [PART_NO(8)] + V + [VENDOR(6)] + [DD(2)] + [MM(2)] + [YY(2)] + [SL(6)]
 *       Customer: VECB (alternate label format)
 *
 *  F6 – Same structure as F1 but vendor code contains a hyphen (e.g. "10830-6")
 *       "H07050005Rev No#2 10830-60426005459"
 *       PART_NO + "Rev No#" + REV(variable) + VENDOR(with hyphen) + MM(2) + YY(2) + SL(6)
 *       The hyphen in the vendor code is preserved as-is.
 *       Customer: IPLT
 *
 *  F7 – Fixed-width, no delimiters; VENDOR prefix + PART_NO + SL + REV + YY(2)
 *       Field widths (partNoLen, slLen) are defined per vendor in F7_KNOWN_VENDORS.
 *       "7201012FEA73900009781D26"       → vendor=7201012 part=FEA73900    sl=009781  rev=#D yy=2026
 *       "R645355147411201040009780D26"   → vendor=R64535  part=514741120104 sl=0009780 rev=#D yy=2026
 *       "R645355147411201040009779D26"   → vendor=R64535  part=514741120104 sl=0009779 rev=#D yy=2026
 *       REV = bytes remaining between SL and the final YY (typically 1-2 chars).
 *       No month field — dispatchDate is set to YYYY-01-01.
 *       Customer: MBP (R64535 / 7201012 vendors)
 */

/**
 * @typedef {Object} ParsedScan
 * @property {'F1'|'F2'|'F3'|'F4'|'F5'|'F6'|'F7'} format
 * @property {string} partNo
 * @property {string} revNo        – normalised to "#", "#1", "#A", etc.
 * @property {string} vendorCode
 * @property {string} partSlNo
 * @property {string|null} dispatchDate  – "YYYY-MM-DD" when parseable, else null
 */



/**
 * Normalise a raw rev token so different representations compare equal.
 *  "Rev No# " → "#"
 *  "#1"       → "#1"
 *  "# "       → "#"
 */
function normaliseRev(raw = '') {
  // Strip leading "Rev No" / "Rev No#" noise, then trim
  let s = raw.replace(/rev\s*no\s*/i, '').trim();
  // Ensure it starts with '#'
  if (!s.startsWith('#')) s = '#' + s;
  return s.toUpperCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Format detectors
// ---------------------------------------------------------------------------

/** F2: contains '$' delimiters */
function isF2(text) {
  return text.includes('$');
}

/**
 * F4: starts with 'P', uses '#' as delimiter (not '$'), and contains 'T' and 'V' sections.
 * Example: "PID628567A#T15042026005687#V113072#"
 */
function isF4(text) {
  return (
    text.startsWith('P') &&
    text.includes('#') &&
    !text.includes('$') &&
    /^P.+#T\d+#V\w+#/.test(text)
  );
}

/**
 * F1 / F6: contains "Rev No#" (case-insensitive) but NOT '$'.
 * F6 is distinguished from F1 after parsing by the presence of a hyphen in the vendor code.
 */
function isF1orF6(text) {
  return /rev\s*no\s*/i.test(text) && !text.includes('$');
}

/**
 * F5: fixed-width, all alphanumeric, exactly 28 chars, starts with a letter (plant code),
 * and has 'V' at index 9 as the vendor marker.
 * Example: "ID628567AV113072150426005688"
 */
function isF5(text) {
  return (
    text.length === 28 &&
    /^[A-Z0-9]+$/i.test(text) &&
    /^[A-Z]/i.test(text[0]) &&
    text[9] === 'V' &&
    !text.startsWith('00')
  );
}


/**
 * F3: everything else that looks like a long numeric+alpha fixed block.
 * Accepted when length is 30–36 and no spaces.
 */
function isF3(text) {
  const t = text.trim();

  return (
    t.startsWith('00') &&          // strong indicator
    /^[A-Z0-9]+$/i.test(t) &&     // no delimiters
    t.length >= 30
  );
}

// ---------------------------------------------------------------------------
// Individual parsers
// ---------------------------------------------------------------------------

/**
 * Shared F1/F6 core parser.
 * Returns the raw result with vendor code; the caller labels it F1 or F6
 * based on whether the vendor code contains a hyphen.
 */
function parseF1core(text) {
  // Match: PART_NO + "Rev No" + optional '#' + optional_rev_digits + space? + REST
  // REST = VENDOR + MM(2) + YY(2) + SL(6)
  const match = text.match(/^(.+?)\s*rev\s*no\s*#?([^\s]*)\s*(.+)$/i);
  if (!match) return null;

  const partNo    = match[1].trim();
  const revSuffix = match[2].trim();   // e.g. "" | "1" | "2" | "A"
  const rest      = match[3].trim();

  // Collapse spaces inside rest (some scanners insert spaces)
  const restClean = rest.replace(/\s+/g, '');

  // Read from the right: SL=6, YY=2, MM=2 → 10 fixed chars
  if (restClean.length < 12) return null;

  const sl     = restClean.slice(-6);
  const year   = '20' + restClean.slice(-8, -6);
  const month  = restClean.slice(-10, -8);
  const vendor = restClean.slice(0, restClean.length - 10);

  const rev = revSuffix ? normaliseRev('#' + revSuffix) : '#';
  const dispatchDate = buildDate(year, month, null);

  return { partNo, revNo: rev, vendorCode: vendor, partSlNo: sl, dispatchDate };
}

function parseF1(text) {
  const result = parseF1core(text);
  if (!result) return null;
  return { format: 'F1', ...result };
}

function parseF2(text) {
  const parts = text.split('$').map(s => s.trim());
  // [0]=VENDOR [1]=PART_NO [2]=SL [3]=DATE [4..5]=NA [6]=REV ...
  if (parts.length < 4) return null;

  const vendor  = parts[0];
  const partNo  = parts[1];
  const sl      = parts[2];
  const dateRaw = parts[3]; // "DD.MM.YYYY" or "NA"

  // REV is typically at index 6; fall back to first '#'-containing token
  let revRaw = parts[6] ?? '';
  if (!revRaw || revRaw.toUpperCase() === 'NA') {
    revRaw = parts.find(p => p.includes('#')) ?? '#';
  }
  const rev = normaliseRev(revRaw);

  let dispatchDate = null;
  if (dateRaw && dateRaw.toUpperCase() !== 'NA') {
    // Expect "DD.MM.YYYY"
    const [dd, mm, yyyy] = dateRaw.split('.');
    dispatchDate = buildDate(yyyy, mm, dd);
  }

  return { format: 'F2', partNo, revNo: rev, vendorCode: vendor, partSlNo: sl, dispatchDate };
}

function parseF3(text) {
  const t = text.trim();

  /**
   * Supported fixed-width layouts (all numeric+alpha, no delimiters):
   *   Layout A: 00+partNo(12) + rev(2) + vendor(6) + MM(2) + YY(2) + SL(6)  = 32
   *   Layout B: 00+partNo(12) + rev(2) + vendor(7) + MM(2) + YY(2) + SL(6)  = 33
   *   Layout C: 00+partNo(12) + rev(2) + vendor(8) + MM(2) + YY(2) + SL(6)  = 34
   *
   * The first 14 chars are consumed as a block; the leading "00" is stripped
   * to yield the real 12-digit part number.
   */
  const layouts = [
    { partLen: 14, vendorLen: 6 },  // total 32
    { partLen: 14, vendorLen: 7 },  // total 33
    { partLen: 14, vendorLen: 8 },  // total 34
  ];

  for (const { partLen, vendorLen } of layouts) {
    const total = partLen + 2 + vendorLen + 2 + 2 + 6;
    if (t.length !== total) continue;

    let offset = 0;
    const partNo = t.slice(offset, offset + partLen).replace(/^00/, ''); offset += partLen;
    const revRaw = t.slice(offset, offset + 2);         offset += 2;
    const vendor = t.slice(offset, offset + vendorLen); offset += vendorLen;
    const month  = t.slice(offset, offset + 2);         offset += 2;
    const year   = '20' + t.slice(offset, offset + 2);  offset += 2;
    const sl     = t.slice(offset, offset + 6);

    const rev = normaliseRev(revRaw);
    const dispatchDate = buildDate(year, month, null);

    return {
      format: 'F3',
      partNo: partNo.trim(),
      revNo: rev,
      vendorCode: vendor,
      partSlNo: sl,
      dispatchDate,
    };
  }
  return null;
}

/**
 * F4 – "#"-delimited with P / T / V prefix markers.
 * Example: "PID628567A#T15042026005687#V113072#"
 *
 * Structure:
 *   segment[0] = P + plant_char + PART_NO
 *   segment[1] = T + DD(2) + MM(2) + YYYY(4) + SL(6)
 *   segment[2] = V + VENDOR
 */
function parseF4(text) {
  const segments = text.split('#').map(s => s.trim());
  // Need at least three non-empty segments
  if (segments.length < 3) return null;

  const seg0 = segments[0]; // e.g. "PID628567A"
  const seg1 = segments[1]; // e.g. "T15042026005687"
  const seg2 = segments[2]; // e.g. "V113072"

  if (!seg0.startsWith('P') || !seg1.startsWith('T') || !seg2.startsWith('V')) return null;

  // seg0: P  + partNo + revno (last 1 digit)
  const partNo = seg0.slice(1, -1);  // strip 'P' and plant char
  const revNo = seg0.slice(-1);   
  
  // seg1: T + DD(2) + MM(2) + YYYY(4) + SL(6)  → 1+2+2+4+6 = 15 chars
  if (seg1.length < 15) return null;
  const dd   = seg1.slice(1, 3);
  const mm   = seg1.slice(3, 5);
  const yyyy = seg1.slice(5, 9);
  const sl   = seg1.slice(9, 15);

  // seg2: V + VENDOR
  const vendor = seg2;

  const dispatchDate = buildDate(yyyy, mm, dd);

  return {
    format: 'F4',
    partNo,
    revNo,            // no explicit rev field in this format
    vendorCode: vendor,
    partSlNo: sl,
    dispatchDate,
  };
}

/**
 * F5 – Fixed-width with embedded "V" vendor marker (no delimiters).
 * Example: "ID628567AV113072150426005688"
 *
 * Layout (28 chars):
 *   plant(1) + PART_NO(8) + 'V' + VENDOR(6) + DD(2) + MM(2) + YY(2) + SL(6)
 */
function parseF5(text) {
  const t = text.trim();
  if (t.length !== 28) return null;

  // plant  = t[0]      (single letter, e.g. 'I')
  const partNo = t.slice(0, 8);   // 8 chars
  // t[9] === 'V'  (marker, verified by isF5)
  const revNo = t.slice(8, 9); 
  const vendor = t.slice(9, 16); // 7 chars
  const dd     = t.slice(16, 18);
  const mm     = t.slice(18, 20);
  const year   = '20' + t.slice(20, 22);
  const sl     = t.slice(22, 28);

  const dispatchDate = buildDate(year, mm, dd);

  return {
    format: 'F5',
    partNo,
    revNo,            // no explicit rev field in this format
    vendorCode: vendor,
    partSlNo: sl,
    dispatchDate,
  };
}

/**
 * F6 – Same barcode structure as F1 but the vendor code contains a hyphen (e.g. "10830-6").
 * The hyphen is preserved exactly as scanned.
 * Example: "H07050005Rev No#2 10830-60426005459"
 */
function parseF6(text) {
  const result = parseF1core(text);
  if (!result) return null;
  // F6 is confirmed when the extracted vendor code contains a hyphen
  if (!result.vendorCode.includes('-')) return null;
  return { format: 'F6', ...result };
}



// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------
function buildDate(year, month, day) {
  try {
    const y = String(year).padStart(4, '20');
    const m = String(month).padStart(2, '0');
    const d = day ? String(day).padStart(2, '0') : '01';
    if (isNaN(new Date(`${y}-${m}-${d}`))) return null;
    return `${y}-${m}-${d}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a scanned barcode string into structured fields.
 * Returns null if no format matched.
 *
 * Detection order:
 *   F2  → '$'-delimited
 *   F4  → '#'-delimited with P/T/V markers
 *   F6  → "Rev No#" + hyphenated vendor  (must precede F1 check)
 *   F1  → "Rev No#" (no hyphen in vendor)
 *   F5  → fixed-width, 28 chars, plant + V-marker
 *   F7  → fixed-width, starts with known vendor prefix (6–7 chars), no month field
 *   F3  → fixed-width, 30–36 chars, leading "00" prefix
 *
 * @param {string} scannedText
 * @returns {ParsedScan|null}
 */
export function parseScanText(scannedText) {
  if (!scannedText) return null;
  const text = scannedText.trim();
if (isF2(text))     return parseF2(text);
if (isF4(text))     return parseF4(text);
if (isF1orF6(text)) return parseF6(text) ?? parseF1(text);
if (isF5(text))     return parseF5(text);
if (isF3(text))     return parseF3(text);   // ✅ strong match

  

  return null;
}