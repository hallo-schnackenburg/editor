# Datenmodell

Quelle ist `contents.yaml`. `npm run generate` macht daraus das JSON-Schema und `core/src/model.generated.ts`.

## Klassen

- **Entität**: etwas Reales (Person, Organisation, Ort, Ereignis, Ding). Kurz gehalten: was sie ausmacht und wie sie verbunden ist.
- **Inhalt**: ein Text, über Entitäten oder nicht. Er verweist mit `about` auf sie und mit `objects` auf Objekte.
- **Objekt**: ein Stück des Archivs (Foto, Brief, Aufnahme, Album). Die YAML-Datei beschreibt es. Die Dateien liegen im Object Store, der Inhalt kann auch anderswo liegen (`storage: external`), oder es gibt keine (Gruppe).

Bei Objekten ist „Datei“ das, was im Store liegt, und „Objekt“ die Beschreibung davon. Ein Objekt hat null bis viele Dateien.

## Objekte

- **ID**: eine ULID in Kleinbuchstaben, beim Anlegen des Entwurfs erzeugt. Die Datei liegt unter `objects/<letzte zwei Zeichen>/<id>.yaml`.
- **Typ** (`kind`): `image`, `document`, `audio`, `video`, `group`. Der Schlüssel `type` ist die Klasse des Eintrags (`object`), deshalb heißt der Typ im YAML `kind`. Der **Untertyp** (`subtype`) gehört zum Typ (Foto, Zeichnung, Brief, Album, …).
- **Dateien pro Typ**: Bild genau eine mit der Rolle `main`, Dokument beliebig viele Seiten (`page`, mit eindeutiger `num`), Audio und Video mit `main`, Gruppe keine. Bei `storage: external` sind nur `thumbnail` und `screenshot` erlaubt, und `external` ist Pflicht. Die Mindestzahl wird erst geprüft, wenn es den Upload gibt.
- **Felder, die nur zu manchen Typen gehören** (`applies`): `recipient` und `language` bei Dokumenten, `alt` bei Bildern.
- **Verweise statt Texten**: `origin.by` (wer es gemacht hat), `origin.place` (Ort der Entstehung, nur wenn er sich nicht aus dem Urheber ergibt), `about` (was es zeigt oder erwähnt), `original.holder`, `owner`, `recipient`. Koordinaten stehen am Ort, nicht am Objekt.
- **Gruppen**: `parents` am Mitglied nennt die Gruppen. Eine Gruppe kann in Gruppen liegen, aber nicht in sich selbst, auch nicht über andere.
- **Datum**: EDTF (`1963`, `1963-07`, `196X`, `1960/1969`, `1963?`).

## Tags

Jeder Eintrag kann `tags` haben: freie Schlagworte (Text ohne Komma, höchstens 60 Zeichen, jedes nur einmal). Ein Tag, das mit einem Unterstrich beginnt, ist intern und gehört dem Editor: `_stub` markiert eine Entität, die der Chat nur aus einem Namen angelegt hat. Wer sie vervollständigt, nimmt das Tag heraus. Die Tags stehen im Index, damit Listen und Vorschläge ohne das Lesen der Dateien auskommen.

## Anlegen durch den Chat

Der Chat sucht erst, fragt bei mehreren Treffern und legt nur an, wenn nichts passt.

## Wo geprüft wird

Alle Prüfungen laufen im Browser vor dem Einreichen und in der CI mit demselben Code (`core`): Schema, Pfad zum Hash, Dateien pro Typ, Verweise, Gruppen ohne Zyklen, Orte ohne Zyklen.

## Vom alten Archivmodell

| Archiv | jetzt |
| --- | --- |
| `type` (image, document, group) | `kind` |
| `subtype` | `subtype` |
| `location`, `geocode` am Objekt | entfallen, der Ort steht an der Entität |
| `origin` (eingebettete Entität) | `origin.by` und `origin.place` (Verweise) |
| `subjects` | `about` |
| `original.holder`, `owner` | Verweise auf Person oder Organisation |
| `recipient` (Text) | Verweis |
| Entitätstyp `business` | `organization` |
| Entitätstyp `building` | Ort mit Typ „Gebäude“ |
