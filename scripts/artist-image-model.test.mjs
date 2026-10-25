import test from 'node:test';
import assert from 'node:assert/strict';
import {collectArtistImageNames,usableArtistPhoto} from './lib/artist-image-model.mjs';

test('collects headliner, lineup, separate supports and timetable-only supports together',()=>{
  const c={artist:'Placebo',date:'2026-10-27',lineup:['Placebo'],supportingArtists:['Guest Band'],
    schedule:{date:'2026-10-27',support:[{name:'The Mirror Trap'}]}};
  const names=collectArtistImageNames([[c],[{artist:'placebo',lineup:['Other Band']}]]);
  assert.deepEqual([...names.keys()],['placebo','guest band','the mirror trap','other band']);
});

test('ignores stale timetables, no-support metadata, placeholders and invalid names',()=>{
  const names=collectArtistImageNames([[{artist:'Band',date:'2026-10-27',
    supportingArtists:[null,'TBA'],schedule:{date:'2026-10-28',support:[{name:'Old Support'}]}},
    {artist:'Band',date:'2026-10-27',schedule:{date:'2026-10-27',noSupport:true,support:[{name:'Removed Support'}]}}]]);
  assert.deepEqual([...names.keys()],['band']);
});

test('placeholder artwork is not accepted as an artist photo',()=>{
  assert.equal(usableArtistPhoto('https://cdn-images.dzcdn.net/images/artist/e23066163f21176a822b54001ee648a2/1000.jpg'),null);
  assert.equal(usableArtistPhoto('javascript:alert(1)'),null);
  assert.equal(usableArtistPhoto('https://images.example.com/artist.jpg'),'https://images.example.com/artist.jpg');
});
