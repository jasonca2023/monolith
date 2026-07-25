/**
 * Colour helpers.
 *
 * A mood is defined by one hex colour the user picks. Everything else — the
 * card accent, the glow, the room simulation, and the CIE xy pair the Hue
 * bridge actually needs — is derived from it, so nobody has to hand-compute
 * chromaticity coordinates.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const FALLBACK: Rgb = { r: 255, g: 255, b: 255 };

export function parseHex(hex: string): Rgb {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!match) return FALLBACK;

  let value = match[1];
  if (value.length === 3) {
    value = value
      .split('')
      .map((char) => char + char)
      .join('');
  }

  const int = parseInt(value, 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Mixes toward black; factor 1 is unchanged, 0 is black. */
export function shade(hex: string, factor: number): string {
  const { r, g, b } = parseHex(hex);
  return toHex({ r: r * factor, g: g * factor, b: b * factor });
}

/** Relative luminance, for picking readable text over a colour. */
export function isLight(hex: string): boolean {
  const { r, g, b } = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/**
 * sRGB hex to CIE 1931 xy, the coordinate pair the Hue API takes.
 *
 * Gamma-expands each channel, converts through the Wide RGB D65 matrix Philips
 * documents for their bulbs, then normalises. Falls back to D65 white when the
 * colour is black, which has no defined chromaticity.
 */
export function hexToXy(hex: string): [number, number] {
  const { r, g, b } = parseHex(hex);

  const expand = (channel: number): number => {
    const normalized = channel / 255;
    return normalized > 0.04045 ? ((normalized + 0.055) / 1.055) ** 2.4 : normalized / 12.92;
  };

  const red = expand(r);
  const green = expand(g);
  const blue = expand(b);

  const X = red * 0.649926 + green * 0.103455 + blue * 0.197109;
  const Y = red * 0.234327 + green * 0.743075 + blue * 0.022598;
  const Z = red * 0.0 + green * 0.053077 + blue * 1.035763;

  const sum = X + Y + Z;
  if (sum === 0) return [0.3127, 0.329];

  const round = (value: number) => Math.round(value * 10000) / 10000;
  return [round(X / sum), round(Y / sum)];
}
