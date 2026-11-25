// Makes a demo database of 500 entries (entities, contents, objects) for trying the browsing UI.
// Deterministic: the same run gives the same files. Usage: node scripts/generate-demo.mjs [outDir]
// The people, clubs and texts are invented. The places are real: Schnackenburg with Gummern, Holtorf and Kapern, and the
// street names of PLZ 29493 (not an official list; which street lies in which Ort is a guess except for a few).

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'

const out = process.argv[2] ?? 'demo'
rmSync(out, { recursive: true, force: true })

let seed = 20261121
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1))
const pick = (list) => list[Math.floor(rnd() * list.length)]
const some = (list, n) => {
  const copy = [...list]
  const result = []
  while (result.length < n && copy.length) result.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0])
  return result
}
const chance = (p) => rnd() < p

const slugify = (s) =>
  s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')

const used = new Set()
const unique = (base) => {
  let id = slugify(base)
  for (let n = 2; used.has(id); n++) id = `${slugify(base)}-${n}`
  used.add(id)
  return id
}

const write = (path, data) => {
  const file = join(out, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, stringify(data, { lineWidth: 0 }))
}

const villages = ['Schnackenburg', 'Gummern', 'Holtorf', 'Kapern']
const first = ['Erika', 'Hans', 'Gerda', 'Heinrich', 'Ingrid', 'Karl', 'Monika', 'Dieter', 'Sabine', 'Jürgen', 'Anke', 'Uwe', 'Petra', 'Klaus', 'Renate', 'Bernd', 'Christa', 'Wolfgang', 'Heike', 'Thomas', 'Birgit', 'Frank', 'Marlene', 'Olaf', 'Silke', 'Lars', 'Ute', 'Rainer', 'Gisela', 'Henning', 'Antje', 'Torsten', 'Elke', 'Matthias', 'Doris', 'Jens', 'Margret', 'Detlef', 'Imke', 'Friedrich']
const last = ['Mustermann', 'Schulz', 'Meier', 'Lüders', 'Brandt', 'Hartmann', 'Köhler', 'Wulf', 'Jahnke', 'Stegemann', 'Peters', 'Lange', 'Kruse', 'Ahrens', 'Bockelmann', 'Dörries', 'Fricke', 'Garleff', 'Harms', 'Ihde', 'Jürgens', 'Kählert', 'Lemke', 'Maaß', 'Niemann', 'Oetjen', 'Pannier', 'Quast', 'Rieger', 'Seeger', 'Thiele', 'Ulrich', 'Voss', 'Wedemeyer', 'Zander']

// --- people -------------------------------------------------------------------------------------------------------
const people = []
while (people.length < 80) {
  const name = `${pick(first)} ${pick(last)}`
  if (people.some((p) => p.name === name)) continue
  const id = unique(name)
  const entry = { id, type: 'person', name }
  if (chance(0.25)) entry.links = [{ label: pick(['Webseite', 'Ortschronik', 'Profil']), url: `https://example.org/${id}` }]
  people.push(entry)
}

// --- places -------------------------------------------------------------------------------------------------------
// The places: Schnackenburg, Gummern, Holtorf and Kapern; Gummern, Holtorf and Kapern have Schnackenburg as their parent. The id of a
// place is its path below entities/places/: a locality is a file there (schnackenburg.yaml), its streets and buildings lie in
// a folder of its name (schnackenburg/elbstrasse.yaml), the houses of a street in a folder of the street (schnackenburg/elbstrasse/3.yaml).
// The other places (a bathing spot, a dyke) lie in a folder "sonstige" of their locality (schnackenburg/sonstige/badestelle.yaml).
// Gummern and Holtorf have no street names: their houses lie directly in the locality (gummern/3.yaml).
const streetsOf = {
  Schnackenburg: ['Alandstraße', 'Alter Postweg', 'Am Markt', 'An der Alandbrücke', 'Bürgermeister-Schamp-Straße', 'Elbstraße', 'Gartenstraße', 'Gewertsweg', 'Grabenstraße', 'Kirchstraße', 'Mühlenweg', 'Neulandweg', 'Niedernstraße', 'Wiesenblick', 'Zollweg'],
  Kapern: ['Am Neuen Damm', 'An der Steege', 'Dorfstraße', 'Holtorferstraße'],
}
const buildingKinds = ['Kirche', 'Dorfgemeinschaftshaus', 'Grundschule', 'Kindergarten', 'Feuerwehrhaus', 'Gasthaus']
const otherKinds = ['Elbdeich', 'Badestelle', 'Aussichtspunkt', 'Spielplatz', 'Sportplatz', 'Fähranleger', 'Friedhof', 'Festplatz', 'Rastplatz']
const places = []
/** The places of a locality that organizations and events may use: no localities, no streets, no houses. */
const usable = new Map()
const center = { Schnackenburg: [52.9919, 11.5586], Gummern: [52.9857, 11.5742], Holtorf: [52.9772, 11.5391], Kapern: [52.9696, 11.5504] }
const location = (village) => ({ lat: +(center[village][0] + (rnd() - 0.5) * 0.01).toFixed(5), lon: +(center[village][1] + (rnd() - 0.5) * 0.01).toFixed(5) })
const town = { id: 'schnackenburg', type: 'place', name: 'Schnackenburg', kind: 'locality', location: { lat: center.Schnackenburg[0], lon: center.Schnackenburg[1] } }
places.push(town)
const localities = { Schnackenburg: town }
for (const village of villages.filter((v) => v !== 'Schnackenburg')) {
  localities[village] = { id: slugify(village), type: 'place', name: village, kind: 'locality', parent: town.id, location: location(village) }
  places.push(localities[village])
}
for (const village of villages) {
  const locality = localities[village]
  usable.set(village, [])
  const streets = (streetsOf[village] ?? []).map((name) => {
    const street = { id: `${locality.id}/${slugify(name)}`, type: 'place', name, kind: 'street', parent: locality.id }
    places.push(street)
    return street
  })
  if (village === 'Schnackenburg') places.push({ id: `${locality.id}/marktplatz`, type: 'place', name: 'Marktplatz', kind: 'square', parent: locality.id })
  for (const kind of some(buildingKinds, village === 'Schnackenburg' ? 4 : 1)) {
    const street = streets.length ? pick(streets) : undefined
    const place = { id: `${locality.id}/${slugify(kind)}`, type: 'place', name: `${kind} ${village}`, kind: 'building', parent: (street ?? locality).id, location: location(village), address: `${street ? `${street.name} ${int(1, 48)}` : `${village} ${int(1, 30)}`}, 29493 ${village}` }
    places.push(place)
    usable.get(village).push(place)
  }
  if (village === 'Schnackenburg') {
    const museum = { id: `${locality.id}/grenzlandmuseum`, type: 'place', name: 'Grenzlandmuseum Schnackenburg', kind: 'building', parent: locality.id, location: location(village) }
    places.push(museum)
    usable.get(village).push(museum)
  }
  // Houses: in the streets, or directly in the locality when it has no street names.
  if (streets.length) for (const street of some(streets, village === 'Schnackenburg' ? 6 : 2)) for (const number of some([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], int(2, 5))) places.push({ id: `${street.id}/${number}`, type: 'place', name: `${street.name} ${number}`, kind: 'building', parent: street.id, location: location(village) })
  else for (const number of some([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], int(3, 6))) places.push({ id: `${locality.id}/${number}`, type: 'place', name: `${village} ${number}`, kind: 'building', parent: locality.id, location: location(village) })
  for (const kind of some(otherKinds, village === 'Schnackenburg' ? 5 : int(1, 2))) {
    const place = { id: `${locality.id}/sonstige/${slugify(kind)}`, type: 'place', name: `${kind} ${village}`, kind: 'other', parent: locality.id, location: location(village) }
    places.push(place)
    usable.get(village).push(place)
  }
}
places.push({ id: 'sonstige/elberadweg', type: 'place', name: 'Elberadweg', kind: 'other', location: location('Schnackenburg') })
places.push({ id: 'sonstige/biosphaerenreservat-niedersaechsische-elbtalaue', type: 'place', name: 'Biosphärenreservat Niedersächsische Elbtalaue', kind: 'other' })
for (const place of places) {
  if (new Set(places.map((p) => p.id)).size !== places.length) throw new Error('duplicate place id')
  used.add(place.id)
}
const placesIn = (village) => usable.get(village)

// --- organizations ------------------------------------------------------------------------------------------------
const orgKinds = ['Freiwillige Feuerwehr', 'Schützenverein', 'Heimatverein', 'Sportverein', 'Förderverein Hafen', 'Kirchengemeinde', 'Landfrauenverein', 'Angelverein', 'Chor', 'Jugendfeuerwehr', 'Posaunenchor', 'Kulturverein', 'Bürgerinitiative', 'Gemeinde', 'Kita-Förderverein']
const organizations = []
for (const village of villages) {
  for (const kind of some(orgKinds, village === 'Schnackenburg' ? orgKinds.length : 4)) {
    if (organizations.length >= 45) break
    const name = `${kind} ${village}`
    const id = unique(name)
    const entry = { id, type: 'organization', name }
    const home = placesIn(village)
    if (home.length && chance(0.8)) entry.places = some(home, int(1, 2)).map((p) => p.id)
    if (chance(0.4)) entry.links = [{ label: 'Webseite', url: `https://example.org/${id}` }]
    organizations.push(entry)
  }
}

// --- events -------------------------------------------------------------------------------------------------------
const eventKinds = ['Osterfeuer', 'Schützenfest', 'Erntedankfest', 'Weihnachtsmarkt', 'Hafenfest', 'Flohmarkt', 'Elbuferlauf', 'Laternenumzug', 'Dorffest', 'Kinoabend', 'Sommerkonzert', 'Fährfest', 'Adventssingen', 'Tag des offenen Denkmals', 'Dorfputz']
const events = []
for (const village of villages) {
  for (const kind of some(eventKinds, village === 'Schnackenburg' ? 10 : 4)) {
    if (events.length >= 45) break
    const name = `${kind} ${village}`
    const id = unique(name)
    const entry = { id, type: 'event', name }
    if (chance(0.7)) entry.recurring = true
    // A one-off event has a date (worked out from the number of the event: no random numbers, so that the rest of the demo stays as it is).
    else entry.dates = [{ start: `2026-${String(5 + (events.length % 6)).padStart(2, '0')}-${String(6 + ((events.length * 7) % 22)).padStart(2, '0')}` }]
    const hosts = [...organizations.filter((o) => o.name.endsWith(village)), ...people.slice(0, 20)]
    entry.organizers = some(hosts, int(1, 2)).map((o) => o.id)
    const where = placesIn(village)
    if (where.length) entry.places = some(where, 1).map((p) => p.id)
    events.push(entry)
  }
}

const entities = [...people, ...organizations, ...places, ...events]
for (const e of people) write(`entities/people/${e.id}.yaml`, e)
for (const e of organizations) write(`entities/organizations/${e.id}.yaml`, e)
for (const e of places) write(`entities/places/${e.id}.yaml`, e)
for (const e of events) write(`entities/events/${e.id}.yaml`, e)

// Things: a few fixed ones (no random numbers, so that the rest of the demo stays as it is).
const things = [
  ['elbfaehre', 'Elbfähre', 'Die Fähre über die Elbe, früher mit dem Seil, heute mit eigenem Antrieb.'],
  ['ortswappen-schnackenburg', 'Ortswappen Schnackenburg', 'Das Wappen des Ortes.'],
  ['gedenkstein-am-deich', 'Gedenkstein am Deich', 'Erinnert an das Hochwasser und die Helfer.'],
  ['loeschfahrzeug-lf-8', 'Löschfahrzeug LF 8', 'Das Fahrzeug der Freiwilligen Feuerwehr.'],
  ['kirchenglocke-gummern', 'Kirchenglocke Gummern', 'Die Glocke der Dorfkirche, 1782 gegossen.'],
]
for (const [id, name, description] of things) write(`entities/things/${id}.yaml`, { id, type: 'thing', name, description })

// --- objects ------------------------------------------------------------------------------------------------------
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'
/** A ULID in lower case: the time (a minute apart per object) and random characters from the seeded generator. */
const ulid = (n) => {
  let time = ''
  for (let rest = 1_700_000_000_000 + n * 60_000, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time
  return time + Array.from({ length: 16 }, () => CROCKFORD[int(0, 31)]).join('')
}
const licenses = ['cc-by-4.0', 'cc-by-sa-4.0', 'cc0-1.0', 'alle-rechte-vorbehalten', 'gemeinfrei']
const objectKinds = [
  ['image', 'photo', 'jpg', 'image/jpeg', 0.7],
  ['image', 'drawing', 'png', 'image/png', 0.05],
  ['document', 'letter', 'pdf', 'application/pdf', 0.15],
  ['audio', undefined, 'mp3', 'audio/mpeg', 0.05],
  ['video', undefined, 'mp4', 'video/mp4', 0.05],
]
const subjects = ['am Deich', 'im Abendlicht', 'beim Aufbau', 'von oben', 'im Winter', 'beim Umzug', 'bei Hochwasser', 'in den Siebzigern', 'nach der Restaurierung', 'bei der Einweihung']
const objects = []
const withSha = (text) => createHash('sha256').update(text).digest('hex')
while (objects.length < 80) {
  const roll = rnd()
  let acc = 0
  const [kind, subtype, ext, mime] = objectKinds.find((k) => (acc += k[4]) >= roll) ?? objectKinds[0]
  const shows = pick([...entities.filter((e) => e.type !== 'person'), ...people.slice(0, 10)])
  const title = `${shows.name} ${pick(subjects)}`
  const id = ulid(objects.length)
  if (used.has(id)) continue
  used.add(id)
  const sha = withSha(id)
  const dir = `files/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`
  const picture = kind === 'image'
  const file = { role: kind === 'document' ? 'page' : 'main', ...(kind === 'document' ? { num: 1 } : {}), original_name: `${picture ? 'IMG' : 'DOC'}_${int(1000, 9999)}.${ext}`, path: `${dir}/original.${ext}`, sha256: sha, mime, bytes: int(80_000, 9_000_000) }
  if (picture) {
    file.width = pick([4000, 6000, 3000])
    file.height = Math.round((file.width * 2) / 3)
    const psha = withSha(`${id}-preview`)
    file.variants = [{ kind: 'preview', path: `${dir}/preview-400.${psha.slice(0, 12)}.${ext}`, sha256: psha, mime, bytes: int(20_000, 60_000), width: 400, height: 267, generator: { name: 'sharp', version: '0.34.0' } }]
  }
  const entry = { id, type: 'object', kind, ...(subtype ? { subtype } : {}), title }
  if (picture) entry.alt = `${shows.name} ${pick(subjects)}: ${pick(['mehrere Menschen im Vordergrund', 'ein weiter Blick über die Elbe', 'das Gebäude von der Straße aus', 'Fahnen und Girlanden'])}.`
  if (chance(0.6)) entry.caption = `${title}, ${int(1950, 2026)}.`
  if (chance(0.7)) entry.origin = { by: [pick(people).id] }
  entry.license = pick(licenses)
  if (chance(0.8)) entry.date = `${int(1950, 2026)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`
  entry.about = [shows.id, ...(chance(0.3) ? [pick(entities).id] : [])].filter((v, i, a) => a.indexOf(v) === i)
  entry.files = [file]
  objects.push(entry)
  write(`objects/${id.slice(-2)}/${id}.yaml`, entry)
}

// --- contents -----------------------------------------------------------------------------------------------------
const topics = {
  bekanntmachungen: ['Sperrung {place}', 'Sitzung des Gemeinderats {village}', 'Bekanntmachung: Haushaltssatzung', 'Straßenreinigung in {village}', 'Wahlbekanntmachung {village}', 'Öffnungszeiten {org}'],
  geschichte: ['Die Geschichte von {place}', '{village} vor hundert Jahren', 'Hochwasser an der Elbe: Erinnerungen aus {village}', 'Wie {org} gegründet wurde', 'Ein Foto aus {village}: Wer erkennt wen?'],
  vereine: ['{org} lädt ein', 'Jahreshauptversammlung: {org}', 'Neue Mitglieder für {org} gesucht', 'Rückblick: Das Jahr bei {org}', '{org} feiert Jubiläum'],
  verwaltung: ['Neues aus dem Rathaus {village}', 'Anträge online stellen', 'Müllabfuhr: Termine für {village}', 'Bauvorhaben in {village}'],
  natur: ['Störche in {village}', 'Der Elbdeich im Frühjahr', 'Wandern um {village}', 'Wasserstand der Elbe', 'Streuobstwiese bei {village}'],
  tourismus: ['Radfahren entlang der Elbe', 'Übernachten in {village}', 'Ausflugsziel: {place}', 'Fähre und Fahrplan', 'Sehenswert: {place}'],
}
const sentences = [
  'Die Gemeinde bittet alle Bürgerinnen und Bürger um Beachtung.',
  'Weitere Informationen gibt es im Rathaus oder bei den Ansprechpersonen vor Ort.',
  'Die Veranstaltung findet bei jedem Wetter statt, für Getränke und Speisen ist gesorgt.',
  'Schon vor Jahrzehnten gehörte dies zum Leben im Ort.',
  'Viele Helferinnen und Helfer haben in den vergangenen Wochen mit angepackt.',
  'Wer Fotos oder Geschichten beisteuern möchte, meldet sich bitte beim Heimatverein.',
  'Der Weg führt am Deich entlang und ist auch mit dem Fahrrad gut zu befahren.',
  'Im Sommer ist hier besonders viel los, im Winter bleibt es ruhig.',
  'Die Kosten trägt die Gemeinde, Spenden sind willkommen.',
  'Anmeldungen sind bis eine Woche vorher möglich.',
  'Die Elbe prägt den Ort seit jeher, im Guten wie im Schlechten.',
  'Der Termin wird rechtzeitig im Aushang bekanntgegeben.',
]
const topicsList = Object.keys(topics)
// What the topic folders are called on screen. verwaltung has no .folder.yaml on purpose: it shows its own name.
const topicTitles = { bekanntmachungen: 'Bekanntmachungen', geschichte: 'Geschichte', natur: 'Natur & Umwelt', tourismus: 'Tourismus', vereine: 'Vereine' }
for (const [topic, title] of Object.entries(topicTitles)) write(`contents/${topic}/.folder.yaml`, { title })
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`)
const contents = []
let attempts = 0
while (contents.length < 500 - entities.length - objects.length && attempts++ < 5000) {
  const topic = pick(topicsList)
  const village = pick(villages)
  const org = pick(organizations.filter((o) => o.name.endsWith(village)).concat(organizations.slice(0, 5)))
  const place = pick(placesIn(village))
  const event = pick(events.filter((e) => e.name.endsWith(village)).concat(events.slice(0, 5)))
  const template = pick(topics[topic])
  const named = /\{(village|org|place|event)\}/.test(template) ? template : `${template} in {village}`
  const title = named.replaceAll('{village}', village).replace('{org}', org.name).replace('{place}', place.name).replace('{event}', event.name)
  const id = unique(title)
  const about = [...new Set([title.includes(org.name) ? org.id : undefined, title.includes(place.name) ? place.id : undefined, title.includes(event.name) ? event.id : undefined].filter(Boolean))]
  if (about.length === 0 && chance(0.7)) about.push(pick(entities).id)
  const lead = `${pick(sentences)} ${pick(sentences)}`
  const body = [`${lead}`, `## ${pick(['Hintergrund', 'Was zu tun ist', 'Wer dabei ist', 'Zur Geschichte'])}\n\n${some(sentences, int(2, 4)).join(' ')}`, some(sentences, int(1, 3)).join(' ')].join('\n\n') + '\n'
  const text = { body }
  if (chance(0.75)) text.teaser = clip(lead, 190) + '\n'
  if (chance(0.5)) text.summary = clip(some(sentences, 3).join(' '), 280) + '\n'
  if (chance(0.25)) text.meta_description = clip(lead, 150) + '\n'
  if (chance(0.2)) text.social = `${clip(lead, 120)} #${slugify(village)}\n`
  const entry = { id, type: 'content', title }
  if (chance(0.8)) entry.authors = [pick([...people, ...organizations]).id]
  if (about.length) entry.about = about
  const related = objects.filter((m) => m.about.some((d) => about.includes(d)))
  if (related.length && chance(0.8)) entry.objects = some(related, 2).map((m) => m.id)
  if (chance(0.85)) entry.published = `${int(2022, 2026)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`
  entry.text = text
  contents.push(entry)
  write(`contents/${topic}/${id}.yaml`, entry)
}

console.log(`${out}: ${people.length} people, ${organizations.length} organizations, ${places.length} places, ${events.length} events, ${objects.length} objects, ${contents.length} contents = ${entities.length + objects.length + contents.length}`)
