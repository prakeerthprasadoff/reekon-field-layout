// Length parsing/formatting. Canonical unit is millimetres (float64).
// The raw string a tool or person produced is always kept alongside, so we never
// re-round what Dana actually read.

export type UnitSystem = 'imperial' | 'metric';

export const MM_PER_INCH = 25.4;
export const MM_PER_FOOT = 304.8;

export interface ParsedLength {
  mm: number;
  /** Smallest increment the input expressed, e.g. 1/16" -> 1.5875mm. Drives display rounding. */
  precisionMm: number;
  system: UnitSystem;
}

const FRACTION = /^(\d+)\s*\/\s*(\d+)$/;

/** Parse "4", "4.5", "4 1/2", "4-1/2", "1/2" into inches + precision (in inches). */
function parseInchPart(s: string): { value: number; precision: number } | null {
  s = s.trim();
  if (s === '') return { value: 0, precision: 1 };
  const frac = s.match(FRACTION);
  if (frac) {
    const den = Number(frac[2]);
    if (den === 0) return null;
    return { value: Number(frac[1]) / den, precision: 1 / den };
  }
  const mixed = s.match(/^(\d+(?:\.\d+)?)[\s-]+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const den = Number(mixed[3]);
    if (den === 0) return null;
    return { value: Number(mixed[1]) + Number(mixed[2]) / den, precision: 1 / den };
  }
  const dec = s.match(/^(\d+(?:\.(\d+))?)$/);
  if (dec) {
    const decimals = dec[2]?.length ?? 0;
    return { value: Number(dec[1]), precision: Math.pow(10, -decimals) };
  }
  return null;
}

function decimalsPrecision(numStr: string): number {
  const d = numStr.split('.')[1]?.length ?? 0;
  return Math.pow(10, -d);
}

/**
 * Parse a length string. Accepts what a tape sends (`12' 4 1/2"`) plus common typed forms:
 * `12'`, `4 1/2"`, `12' 4.5"`, `12-4 1/2` (ft-in), `148.5in`, `12.5ft`, `3.77m`, `377cm`, `3770mm`.
 * A bare number is interpreted as inches (imperial) or millimetres (metric).
 */
export function parseLength(raw: string, bareNumberSystem: UnitSystem = 'imperial'): ParsedLength | null {
  let s = raw
    .trim()
    .toLowerCase()
    .replace(/[′’]/g, "'") // prime / curly apostrophe
    .replace(/[″”]/g, '"') // double prime / curly quote
    .replace(/''/g, '"')
    .replace(/\s+/g, ' ');
  if (!s) return null;

  // Metric with explicit unit
  const metric = s.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)$/);
  if (metric) {
    const n = Number(metric[1]);
    const factor = metric[2] === 'mm' ? 1 : metric[2] === 'cm' ? 10 : 1000;
    return { mm: n * factor, precisionMm: decimalsPrecision(metric[1]) * factor, system: 'metric' };
  }

  // Decimal feet / inches with word units
  const ftWord = s.match(/^(\d+(?:\.\d+)?)\s*(ft|feet|foot)$/);
  if (ftWord) {
    return {
      mm: Number(ftWord[1]) * MM_PER_FOOT,
      precisionMm: decimalsPrecision(ftWord[1]) * MM_PER_FOOT,
      system: 'imperial',
    };
  }
  s = s.replace(/\s*(in|inch|inches)$/, '"').replace(/\s*(ft|feet|foot)\s*/, "'");

  // Feet + optional inches:  12'  |  12' 4 1/2"  |  12'4-1/2"  |  12' 4.5
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*'\s*-?\s*(.*?)\s*"?$/);
  if (ftIn) {
    const feet = Number(ftIn[1]);
    const inch = parseInchPart(ftIn[2]);
    if (!inch) return null;
    const feetOnly = ftIn[2].trim() === '';
    const precisionIn = feetOnly ? decimalsPrecision(ftIn[1]) * 12 : inch.precision;
    return {
      mm: feet * MM_PER_FOOT + inch.value * MM_PER_INCH,
      precisionMm: Math.min(precisionIn, 12) * MM_PER_INCH,
      system: 'imperial',
    };
  }

  // Inches only:  4 1/2"  |  148.5"
  const inOnly = s.match(/^(.*?)\s*"$/);
  if (inOnly) {
    const inch = parseInchPart(inOnly[1]);
    if (!inch) return null;
    return { mm: inch.value * MM_PER_INCH, precisionMm: inch.precision * MM_PER_INCH, system: 'imperial' };
  }

  // Dash notation without marks: 12-4 1/2  (feet-inches, common when read aloud)
  const dash = s.match(/^(\d+)-(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?)$/);
  if (dash) {
    const inch = parseInchPart(dash[2]);
    if (!inch) return null;
    return {
      mm: Number(dash[1]) * MM_PER_FOOT + inch.value * MM_PER_INCH,
      precisionMm: inch.precision * MM_PER_INCH,
      system: 'imperial',
    };
  }

  // Bare number
  const inch = parseInchPart(s);
  if (inch) {
    if (bareNumberSystem === 'metric') {
      return { mm: inch.value, precisionMm: inch.precision, system: 'metric' };
    }
    return { mm: inch.value * MM_PER_INCH, precisionMm: inch.precision * MM_PER_INCH, system: 'imperial' };
  }
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Pick a power-of-two fraction denominator that matches a precision (1/16" tape -> 16). */
export function denominatorFor(precisionMm: number | undefined, maxDen = 64): number {
  if (!precisionMm || precisionMm <= 0) return 16;
  const precisionIn = precisionMm / MM_PER_INCH;
  let den = 1;
  while (den < maxDen && 1 / den > precisionIn + 1e-9) den *= 2;
  return den;
}

/** 3762.375mm -> `12' 4 1/8"`. Rounds to the nearest 1/den inch and reduces the fraction. */
export function formatImperial(mm: number, den = 16): string {
  const sign = mm < 0 ? '-' : '';
  const totalUnits = Math.round((Math.abs(mm) / MM_PER_INCH) * den);
  const totalWholeIn = Math.floor(totalUnits / den);
  let num = totalUnits % den;
  const feet = Math.floor(totalWholeIn / 12);
  const inches = totalWholeIn % 12;
  let fracStr = '';
  if (num > 0) {
    const g = gcd(num, den);
    fracStr = `${num / g}/${den / g}`;
    num = num / g;
  }
  const inchStr = fracStr ? (inches > 0 ? `${inches} ${fracStr}` : fracStr) : `${inches}`;
  if (feet === 0) return `${sign}${inchStr}"`;
  if (inches === 0 && !fracStr) return `${sign}${feet}'`;
  return `${sign}${feet}' ${inchStr}"`;
}

export function formatMetric(mm: number, precisionMm?: number): string {
  if (precisionMm !== undefined && precisionMm < 1) {
    const d = Math.min(3, Math.max(1, Math.round(-Math.log10(precisionMm))));
    return `${mm.toFixed(d)} mm`;
  }
  if (Math.abs(mm) < 1000) return `${Math.round(mm)} mm`;
  return `${(mm / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} m`;
}

export function formatLength(mm: number, system: UnitSystem, precisionMm?: number): string {
  return system === 'imperial' ? formatImperial(mm, denominatorFor(precisionMm)) : formatMetric(mm, precisionMm);
}

export function formatDecimalInches(mm: number): string {
  return `${(mm / MM_PER_INCH).toFixed(2).replace(/\.?0+$/, '')} in`;
}

export function formatArea(mm2: number, system: UnitSystem): string {
  if (system === 'imperial') return `${(mm2 / (MM_PER_FOOT * MM_PER_FOOT)).toFixed(1)} ft²`;
  return `${(mm2 / 1e6).toFixed(2)} m²`;
}
