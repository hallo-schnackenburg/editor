# Einrichtung: Einreichungen, Webhook, Prüfung

Eine Einreichung ist ein Branch `submission/<login>/<name>` mit einem Pull Request. Der Editor legt beides beim ersten
Speichern an (der PR als Entwurf). Übernommen wird per Squash-Merge nach `main`. Wer das darf, entscheidet GitHub.

## 1. GitHub App (je dev, staging, production)

**Repository-Rechte** (Settings der App → Permissions & events):

| Recht | Zugriff | wofür |
|---|---|---|
| Contents | Read & write | Einträge lesen und speichern, Branch anlegen und nach dem Übernehmen löschen |
| Pull requests | Read & write | Einreichungen anlegen, einreichen, übernehmen, verwerfen, kommentieren |
| Checks | Read-only | Stand der automatischen Prüfung anzeigen |
| Metadata | Read-only | (immer) |

Nach einer Änderung der Rechte muss jede Person die App neu bestätigen (GitHub zeigt es beim nächsten Anmelden).

**Webhook** (gleiche Seite, „Webhook“): *Active*, `Webhook secret` = ein langer Zufallswert (`openssl rand -hex 32`),
dazu unter „Subscribe to events“: Pull request, Push, Issue comment, Pull request review comment, Check run, Check suite.

| Umgebung | Webhook URL |
|---|---|
| dev | `https://<tunnel>/hook/github` (der Tunnel zeigt auf den Worker, Port 8788) |
| staging | `https://contents-editor-staging.schnackenburg.de/api/hook/github` |
| production | `https://contents-editor.schnackenburg.de/api/hook/github` |

Derselbe Wert kommt als `WEBHOOK_SECRET` in `worker/.secrets/<umgebung>` (Vorlage: `worker/.secrets/example`).
Für staging und production: `bash .secrets/upload-secrets.sh staging` (bzw. `production`) im Ordner `worker/`.

Ohne Webhook funktioniert alles, die Oberfläche fragt dann nur einmal pro Minute nach (der Punkt oben rechts ist grau).

## 2. Prüfung in den Datenrepos

`templates/validate.yml` nach `.github/workflows/validate.yml` kopieren, in `contents`, `contents-staging` und
`contents-dev` (nur einmal: die Vorlage ruft den Workflow aus dem Editor-Repo auf, `.github/workflows/validate.yml`
dort; was geprüft und gebaut wird, ändert sich also an einer Stelle). Die Prüfung läuft bei jedem Pull Request und prüft
jeden Eintrag und die Verweise der Einträge untereinander (`npm run validate-repo -- <Ordner>` im Editor-Repo macht
dasselbe lokal). Bei jedem Push auf `main` baut sie zusätzlich den Index (siehe unten).

Der Job der Vorlage heißt `validate`, die Prüfungen daher `validate / validate` und `validate / index`.

In der Vorlage und im Workflow steht `hallo-schnackenburg/editor` als Repo des Editors; anpassen, falls es anders heißt.
Ist das Editor-Repo privat, muss es unter Settings → Actions → General → Access Zugriff aus anderen Repos erlauben.

## 3. `main` schützen

Repository → Settings → Rules → Rulesets (oder Branches → Branch protection rule) für `main`:

- *Require a pull request before merging* (keine Freigaben nötig, es gibt keine Rollen)
- *Require status checks to pass*: `validate / validate`
- *Block force pushes*

Damit kann niemand am Editor vorbei Ungültiges nach `main` bringen, und „Übernehmen“ klappt erst, wenn die Prüfung
grün ist.

## 4. Chat

Der Chat unter dem Formular fragt über den Worker (`POST /chat`) die Anthropic-API. Den Schlüssel gibt es in der Anthropic-Console;
er kommt als `ANTHROPIC_API_KEY` in `worker/.secrets/<umgebung>` (Vorlage: `worker/.secrets/example`, Hochladen wie oben). Das Modell ist
`claude-haiku-5-5`; mit der Variable `MODEL` im Worker lässt es sich ändern. **Dort ein Ausgaben-Limit setzen**: ein Limit pro Person
gibt es noch nicht. Ohne Schlüssel antwortet der Worker mit einem Hinweis, der Rest des Editors funktioniert.

Der Chat kann die ganze App bedienen: suchen und Einträge lesen, Einträge öffnen, anlegen und ändern, Einreichungen anderer ansehen,
lesen, annehmen, verwerfen und kommentieren. Die KI führt dabei nichts selbst aus:

- Suchen, Lesen und Öffnen passiert sofort (die KI fragt dafür bis zu 8-mal nach; der Worker merkt sich nichts dazwischen).
- Änderungen an Einträgen stehen wie getippte im Formular und werden mit „Fertig“ gespeichert.
- Was schwer zurückzunehmen ist oder andere sehen (Speichern, Löschen, Umbenennen, Verschieben, Einreichen, Annehmen, Verwerfen,
  Kommentieren, Änderung zurücknehmen), bereitet sie nur vor: im Chat erscheint eine Frage mit Knopf, und erst der Klick führt es aus.
  Es gelten die Regeln der Oberfläche (eine Einreichung mit fehlgeschlagener Prüfung lässt sich auch hier nicht annehmen).

Im Demo (`npm run dev:fake`) antwortet eine Attrappe, die „Beschreibung: …“, „öffne …“, „speichern“, „einreichen“ und „löschen“ kennt.

## 5. Lokal

```
npm run dev:worker   # Terminal 1: Worker auf Port 8788
npm run dev          # Terminal 2: die App auf Port 5174
npm run dev:fake     # ohne GitHub: Beispieldaten im Speicher, bernd hat eine eingereichte Einreichung
```

Der alte Branch `edit/<login>` aus der ersten Version wird nicht mehr benutzt und kann gelöscht werden.

## Index

Der Workflow hat einen zweiten Job `index`. Er läuft nach jedem Push auf `main`, nachdem die Prüfung grün war, baut aus den Einträgen eine `index.json` (eine Zeile pro Datei) und eine `entries.ndjson.gz` (die Texte aller Einträge, gepackt; der Editor lädt sie einmal beim ersten Start) und legt beide als einzigen Commit auf den Branch `index` des Datenrepos (wird jedes Mal ersetzt). Der Job braucht nur das mitgelieferte Token (`contents: write`). Ist `main` durch Branch-Schutz gesperrt, gilt das nicht für den Branch `index`; ein Schutz darauf wäre zu lassen.
