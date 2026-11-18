// Regional provider list (GET /watch/providers/movie?watch_region=ES) as observed in ES
// on 2026-10-31, after Apple renamed Apple TV+ to Apple TV (docs/data-model.md §5).
//
// The synthetic list in tests/fixtures/tmdb/synthetic/ predates the rename: there
// `Apple TV` is the store (id 2), which would now match the `Apple TV` alias. Fixture
// files are not edited by sessions, so tests/support/fixture-fetch.js serves this list
// as a default route instead (a test can still override it with its own route).
// Ids of the two channels are placeholders; the others are the real ones.

const PROVIDER_LIST_KEY = '/watch/providers/movie?language=es-ES&watch_region=ES';

const ES_PROVIDERS = [
  [8, 'Netflix'],
  [1796, 'Netflix basic with Ads'],
  [119, 'Amazon Prime Video'],
  [2100, 'Amazon Prime Video with Ads'],
  [1899, 'HBO Max'],
  [1825, 'HBO Max Amazon Channel'],
  [149, 'Movistar Plus+'],
  [2241, 'Movistar Plus+ Ficción Total '],
  [63, 'Filmin'],
  [337, 'Disney Plus'],
  [1773, 'SkyShowtime'],
  [350, 'Apple TV'],
  [2, 'Apple TV Store'],
  [9001, 'AMC Plus Apple TV channel'],
  [9002, 'Apple TV Amazon Channel'],
  [35, 'Rakuten TV'],
];

/** Response body of the regional provider list. */
function providerListBody(providers = ES_PROVIDERS) {
  return {
    results: providers.map(([id, name], i) => ({
      display_priorities: { ES: i }, display_priority: i, logo_path: `/logo${id}.jpg`, provider_name: name, provider_id: id,
    })),
  };
}

module.exports = { PROVIDER_LIST_KEY, ES_PROVIDERS, providerListBody };
