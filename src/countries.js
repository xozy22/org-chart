// ISO 3166-1 alpha-2 codes + German display names.
// The codes are lowercase to match flag-icons CSS classes (`.fi.fi-de`).
export const COUNTRIES = [
  { code: 'de', name: 'Deutschland' },
  { code: 'at', name: 'Österreich' },
  { code: 'ch', name: 'Schweiz' },
  { code: 'fr', name: 'Frankreich' },
  { code: 'gb', name: 'Vereinigtes Königreich' },
  { code: 'ie', name: 'Irland' },
  { code: 'es', name: 'Spanien' },
  { code: 'pt', name: 'Portugal' },
  { code: 'it', name: 'Italien' },
  { code: 'nl', name: 'Niederlande' },
  { code: 'be', name: 'Belgien' },
  { code: 'lu', name: 'Luxemburg' },
  { code: 'dk', name: 'Dänemark' },
  { code: 'se', name: 'Schweden' },
  { code: 'no', name: 'Norwegen' },
  { code: 'fi', name: 'Finnland' },
  { code: 'is', name: 'Island' },
  { code: 'pl', name: 'Polen' },
  { code: 'cz', name: 'Tschechien' },
  { code: 'sk', name: 'Slowakei' },
  { code: 'hu', name: 'Ungarn' },
  { code: 'ro', name: 'Rumänien' },
  { code: 'bg', name: 'Bulgarien' },
  { code: 'gr', name: 'Griechenland' },
  { code: 'hr', name: 'Kroatien' },
  { code: 'si', name: 'Slowenien' },
  { code: 'rs', name: 'Serbien' },
  { code: 'tr', name: 'Türkei' },
  { code: 'ua', name: 'Ukraine' },
  { code: 'ru', name: 'Russland' },
  { code: 'us', name: 'USA' },
  { code: 'ca', name: 'Kanada' },
  { code: 'mx', name: 'Mexiko' },
  { code: 'br', name: 'Brasilien' },
  { code: 'ar', name: 'Argentinien' },
  { code: 'cl', name: 'Chile' },
  { code: 'co', name: 'Kolumbien' },
  { code: 'pe', name: 'Peru' },
  { code: 'cn', name: 'China' },
  { code: 'jp', name: 'Japan' },
  { code: 'kr', name: 'Südkorea' },
  { code: 'in', name: 'Indien' },
  { code: 'sg', name: 'Singapur' },
  { code: 'my', name: 'Malaysia' },
  { code: 'id', name: 'Indonesien' },
  { code: 'th', name: 'Thailand' },
  { code: 'vn', name: 'Vietnam' },
  { code: 'ph', name: 'Philippinen' },
  { code: 'au', name: 'Australien' },
  { code: 'nz', name: 'Neuseeland' },
  { code: 'za', name: 'Südafrika' },
  { code: 'eg', name: 'Ägypten' },
  { code: 'ma', name: 'Marokko' },
  { code: 'ng', name: 'Nigeria' },
  { code: 'ke', name: 'Kenia' },
  { code: 'ae', name: 'Vereinigte Arabische Emirate' },
  { code: 'sa', name: 'Saudi-Arabien' },
  { code: 'il', name: 'Israel' },
  { code: 'qa', name: 'Katar' },
];

const byCode = new Map(COUNTRIES.map((c) => [c.code, c]));
const byName = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c]));

/**
 * Resolve a country object from a free-text input.
 * Accepts ISO-2 code ("de", "DE") or full name ("Deutschland", "germany").
 * Returns null if nothing matches.
 */
export function resolveCountry(input) {
  if (!input) return null;
  const v = String(input).trim().toLowerCase();
  if (!v) return null;
  if (byCode.has(v)) return byCode.get(v);
  if (byName.has(v)) return byName.get(v);
  // English fallback for common cases
  const english = {
    germany: 'de', austria: 'at', switzerland: 'ch', france: 'fr',
    'united kingdom': 'gb', uk: 'gb', usa: 'us', 'united states': 'us',
    spain: 'es', italy: 'it', netherlands: 'nl', poland: 'pl', japan: 'jp',
  };
  if (english[v]) return byCode.get(english[v]) ?? null;
  return null;
}

export function countryCode(input) {
  return resolveCountry(input)?.code ?? null;
}

export function countryName(code) {
  return byCode.get(String(code || '').toLowerCase())?.name ?? '';
}
