/**
 * Options of the xterm image addon, free of xterm so they can be tested.
 *
 * The addon's defaults (128 MB of decoded pixels per terminal, 16 megapixels
 * per picture) multiplied by every mounted terminal on a board. 16 MB per
 * terminal still holds a few screenshots, and a 4-megapixel picture
 * (2048 x 2048, 4 bytes per pixel) fits whole in that budget.
 */
export const IMAGE_ADDON_OPTIONS = { storageLimit: 16, pixelLimit: 4_194_304 } as const;
