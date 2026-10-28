import { getSetting } from './settings';

/** Fallback used until Admin → Settings → General → Platform name is set. */
export const DEFAULT_BRAND = 'FilmyTalents';

/** Platform name from Admin → Settings → General (cached 30 s with the other settings). */
export async function brandName() {
  const g = await getSetting<{ platformName?: string }>('general', {});
  return g.platformName?.trim() || DEFAULT_BRAND;
}
