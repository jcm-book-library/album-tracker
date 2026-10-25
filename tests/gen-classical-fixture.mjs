// Writes tests/fixture-classical.json: 80 MADE-UP classical tracks in the shape of the real "Classical" tab
// (same header names, values as a sheet displays them). Deterministic: running it again gives the same file.
// No real data is used; composers, titles and Spotify ids are invented.
//
// Usage:  node gen-classical-fixture.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HEADERS = ['#', 'Song', 'Artist', 'Era', 'Form', 'Composer (dates)', 'Mood', 'Work-friendly', 'BPM', 'Camelot', 'Energy', 'Added At', 'Duration', 'Popularity', 'Genres', 'Album', 'Album Date', 'Dance', 'Acoustic', 'Instrumental', 'Valence', 'Speech', 'Live', 'Loud (Db)', 'Key', 'Time Signature', 'Spotify Track Id', 'ISRC', 'Explicit'];

let seed = 20261025;
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = a => a[Math.floor(rnd() * a.length)];
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const fakeId = () => Array.from({ length: 22 }, () => B62[int(0, 61)]).join('');

const COMPOSERS = [
  ['Test Composer A', 'Baroque', '1678–1741'], ['Test Composer B', 'Baroque', '1685–1750'], ['Test Composer C', 'Baroque', '1660–1725'],
  ['Test Composer D', 'Classical', '1732–1809'], ['Test Composer E', 'Classical', '1756–1791'], ['Test Composer F', 'Classical–Romantic', '1770–1827'],
  ['Test Composer G', 'Romantic', '1810–1849'], ['Test Composer H', 'Romantic', '1833–1897'], ['Test Composer I', '20th century', '1873–1943'], ['Test Composer J', '20th century', '1882–1971']
];
const FORMS = ['Concerto', 'Sonata', 'Suite', 'Symphony', 'Prelude', 'Nocturne', 'Quartet', 'Variations'];
const MOODS = ['Calm', 'Serene', 'Joyful', 'Dramatic', 'Melancholy', 'Playful'];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAM_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1], CAM_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
const CAMS = [];   // [camelot, key name]
for (let pc = 0; pc < 12; pc++) { CAMS.push([CAM_MAJOR[pc] + 'B', NOTES[pc] + ' Major']); CAMS.push([CAM_MINOR[pc] + 'A', NOTES[pc] + ' Minor']); }

const noBpm = new Set([11, 29, 47, 66]), noCam = new Set([13, 29, 52]), noEnergy = new Set([5, 22, 41, 70]), noId = new Set([7, 31, 58]);
const rows = [];
for (let i = 0; i < 80; i++) {
  const [name, era, dates] = COMPOSERS[i % COMPOSERS.length];
  const form = pick(FORMS), [cam, key] = pick(CAMS);
  const energy = Math.round(8 + 85 * rnd() ** 1.6);
  const instr = rnd() < 0.8 ? int(75, 100) : int(20, 60), speech = rnd() < 0.85 ? int(0, 9) : int(11, 40);
  const wf = energy <= 45 && instr >= 70 ? (rnd() < 0.75 ? 'Yes' : 'Maybe') : energy <= 65 ? (rnd() < 0.5 ? 'Maybe' : 'No') : 'No';
  const mood = energy < 30 ? pick(['Calm', 'Serene', 'Melancholy']) : energy < 60 ? pick(MOODS) : pick(['Joyful', 'Dramatic', 'Playful']);
  const secs = int(80, 560) + (form === 'Symphony' && rnd() < 0.4 ? int(300, 700) : 0);
  const yr = int(1990, 2022), mo = int(1, 12), da = int(1, 28);
  const z = n => String(n).padStart(2, '0');
  rows.push([
    String(i + 1), `Test ${form} No. ${int(1, 9)} in ${key}, mvt ${int(1, 4)} (${i + 1})`, `${name}, Test Orchestra ${int(1, 5)}`, era, form, `${name} (${dates})`, mood, wf,
    noBpm.has(i) ? '' : String(int(48, 168)), noCam.has(i) ? '' : cam, noEnergy.has(i) ? '' : String(energy),
    `2025-${z(int(1, 12))}-${z(da)}T10:${z(int(0, 59))}:00Z`, `${Math.floor(secs / 60)}:${z(secs % 60)}`, String(int(0, 60)), 'classical, ' + era.toLowerCase(),
    `Test Album ${z(int(1, 30))}`, `${yr}-${z(mo)}-${z(da)}`, String(int(5, 45)), String(int(70, 99)), String(instr), String(int(5, 70)), String(speech), String(int(5, 30)), String(-int(12, 30)),
    noCam.has(i) ? '' : key, String(pick([3, 4, 4, 4, 6])), noId.has(i) ? '' : fakeId(), `TEST${String(1000000 + i * 37)}`, 'No'
  ]);
}
writeFileSync(join(here, 'fixture-classical.json'), JSON.stringify({ values: [HEADERS, ...rows] }, null, 1) + '\n');
console.log(`wrote fixture-classical.json: ${rows.length} made-up tracks`);
