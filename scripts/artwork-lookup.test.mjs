import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanForSearch, pickItunesArtwork, normalizeName } from '../js/artwork-lookup.js';

test('YouTube noise is stripped before searching', () => {
  assert.deepEqual(cleanForSearch({ artist: 'Mono - Topic', track: 'Ashes in the Snow (Official Video)' }),
    { artist: 'Mono', track: 'Ashes in the Snow' });
  assert.deepEqual(cleanForSearch({ artist: 'MonoVEVO', track: 'Mono - Ashes in the Snow [HD]' }),
    { artist: 'Mono', track: 'Ashes in the Snow' });
  assert.deepEqual(cleanForSearch({ artist: 'Don Algodón', track: '¿Por qué vas alli?' }),
    { artist: 'Don Algodón', track: '¿Por qué vas alli?' });
});

test('names compare without accents or punctuation', () => {
  assert.equal(normalizeName('Don Algodón'), normalizeName('don algodon'));
  assert.equal(normalizeName('¿Por qué vas allí?'), 'por que vas alli');
});

test('iTunes: only the same artist counts, exact title preferred, 600px cover', () => {
  const json = { results: [
    { artistName: 'Someone Else', trackName: 'Por qué vas allí', artworkUrl100: 'https://x/a/100x100bb.jpg' },
    { artistName: 'Don Algodón', trackName: 'Otra', artworkUrl100: 'https://x/b/100x100bb.jpg' },
    { artistName: 'Don Algodon', trackName: '¿Por qué vas allí?', artworkUrl100: 'https://x/c/100x100bb.jpg' },
  ] };
  assert.equal(pickItunesArtwork(json, 'Don Algodón', '¿Por qué vas alli?'), 'https://x/c/600x600bb.jpg');
  assert.equal(pickItunesArtwork({ results: [json.results[0]] }, 'Don Algodón', 'x'), null);
  assert.equal(pickItunesArtwork(null, 'a', 'b'), null);
});
