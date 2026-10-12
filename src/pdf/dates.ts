// One timestamp, two notations. PDF/X requires the Info dictionary and the XMP metadata to carry
// identical dates, so both strings are derived from the same Date (seconds precision, local offset).

export interface PdfDates {
  /** Info dictionary: D:YYYYMMDDHHmmSS+HH'mm' */
  pdf: string;
  /** XMP: YYYY-MM-DDTHH:mm:SS+HH:mm */
  xmp: string;
}

export function formatDates(d: Date): PdfDates {
  const p = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(offsetMin) / 60));
  const om = p(Math.abs(offsetMin) % 60);
  const Y = d.getFullYear();
  const M = p(d.getMonth() + 1);
  const D = p(d.getDate());
  const h = p(d.getHours());
  const m = p(d.getMinutes());
  const s = p(d.getSeconds());
  return {
    pdf: `D:${Y}${M}${D}${h}${m}${s}${sign}${oh}'${om}'`,
    xmp: `${Y}-${M}-${D}T${h}:${m}:${s}${sign}${oh}:${om}`,
  };
}
