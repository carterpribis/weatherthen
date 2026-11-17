// Where the map data lives.
//   Production: the R2 bucket's public domain (see ARCHIVE_PLAN.md).
//   Local preview (localhost): site/data/, built by the pipeline.
//   Override either way with ?data=local or ?data=remote.

const REMOTE = 'https://data.weather.prib.is/';
const LOCAL = 'data/';

const pick = new URLSearchParams(location.search).get('data');
const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export const DATA_ROOT = pick === 'remote' ? REMOTE : pick === 'local' || isLocalHost ? LOCAL : REMOTE;
