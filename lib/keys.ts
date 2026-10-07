/**
 * Storage key names. Kept free of any IndexedDB import so the pre-paint
 * script in the server-rendered layout can read them.
 */

export const PREFIX = "blink:";

/** Marker written into exported backup files. */
export const APP_ID = "blink";

export const THEME_KEY = `${PREFIX}dark`;
