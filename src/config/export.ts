// PDF/X-4 export settings.

import { ASSETS } from './assets';

/**
 * CMYK (default): the image as DeviceCMYK through the output profile (FOGRA39, relative
 * colorimetric), so the ramp's warm/cool tints print; text and signature stay 100 % K.
 * Fallbacks, K plate only: DeviceGray (image and text in DeviceGray, which a PDF/X-4 workflow
 * with a CMYK output intent prints on K) and CMYK-K (the same as DeviceCMYK with C = M = Y = 0).
 * In both, the K plate alone reproduces the ramp's lightness; tints are lost.
 */
export type ColorModel = 'CMYK' | 'DeviceGray' | 'CMYK-K';

/** localStorage key (bumped when the default colour model changed to CMYK). */
export const EXPORT_STORAGE_KEY = 'export.v2';

export interface ExportConfig {
  filename: string;
  title: string;
  /** Optional Info /Author and XMP dc:creator; empty = omitted. */
  author: string;
  colorModel: ColorModel;
  outputIntent: {
    iccUrl: string;
    outputConditionIdentifier: string;
    outputCondition: string;
    registryName: string;
  };
  text: { enabled: boolean; content: string; fontUrl: string; sizePt: number };
  signature: { enabled: boolean; url: string; widthMm: number };
}

export const DEFAULT_EXPORT: ExportConfig = {
  filename: 'Nachname_Matrikel-Nr_Projektname.pdf',
  title: 'Michelangelo Buonarroti – David',
  author: '',
  colorModel: 'CMYK',
  outputIntent: {
    iccUrl: ASSETS.icc,
    outputConditionIdentifier: 'FOGRA39',
    // Characterization description as registered at color.org for FOGRA39.
    outputCondition:
      'Offset printing, according to ISO 12647-2:2004/Amd 1, OFCOM, paper type 1 or 2 = coated art, ' +
      '115 g/m2, tone value increase curves A (CMY) and B (K)',
    registryName: 'http://www.color.org',
  },
  text: {
    enabled: true,
    content: 'Il Divino Michelangelo · Testzeile Fira Sans Regular 14 pt · 100 % K',
    fontUrl: ASSETS.font,
    sizePt: 14,
  },
  signature: { enabled: true, url: ASSETS.signature, widthMm: 80 },
};
