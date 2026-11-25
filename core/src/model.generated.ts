// Generated from contents.yaml by `npm run generate` in core. Do not edit.

export const MODEL = {
  "classes": {
    "entity": {
      "label": "Entität",
      "dir": "entities"
    },
    "content": {
      "label": "Inhalt",
      "dir": "contents"
    },
    "object": {
      "label": "Objekt",
      "dir": "objects"
    }
  },
  "ids": {
    "path": {
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$"
    },
    "slug": {
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    },
    "object": {
      "pattern": "^[0-7][0-9a-hjkmnp-tv-z]{25}$"
    }
  },
  "types": {
    "person": {
      "class": "entity",
      "label": "Person",
      "dir": "entities/people",
      "id": "path",
      "subtypes": {},
      "fields": {
        "name": {
          "label": "Name",
          "kind": "string",
          "required": true
        },
        "description": {
          "label": "Beschreibung",
          "kind": "string",
          "required": false,
          "multiline": true
        },
        "stub": {
          "label": "Unvollständig",
          "kind": "boolean",
          "required": false,
          "description": "Made by the chat from a name only; to be completed. Take it away when the entry is complete."
        },
        "links": {
          "label": "Links",
          "kind": "links",
          "required": false
        }
      }
    },
    "organization": {
      "class": "entity",
      "label": "Organisation",
      "dir": "entities/organizations",
      "id": "path",
      "subtypes": {},
      "fields": {
        "name": {
          "label": "Name",
          "kind": "string",
          "required": true
        },
        "description": {
          "label": "Beschreibung",
          "kind": "string",
          "required": false,
          "multiline": true
        },
        "places": {
          "label": "Orte",
          "kind": "ref",
          "required": false,
          "ref": [
            "place"
          ]
        },
        "stub": {
          "label": "Unvollständig",
          "kind": "boolean",
          "required": false,
          "description": "Made by the chat from a name only; to be completed. Take it away when the entry is complete."
        },
        "links": {
          "label": "Links",
          "kind": "links",
          "required": false
        }
      }
    },
    "place": {
      "class": "entity",
      "label": "Ort",
      "dir": "entities/places",
      "id": "path",
      "subtypes": {},
      "fields": {
        "kind": {
          "label": "Typ",
          "kind": "choice",
          "required": false,
          "options": {
            "locality": "Ort",
            "street": "Straße",
            "square": "Platz",
            "building": "Gebäude",
            "other": "Sonstiger Ort"
          },
          "description": "Where it stands in the hierarchy: a locality (Ort: town, village, quarter; may lie in another locality) contains streets and squares, those contain buildings (or a building lies directly in a locality); any other place is filed in a locality or has no parent. Without a kind the place is not checked."
        },
        "parent": {
          "label": "Teil von",
          "kind": "ref",
          "required": false,
          "ref": [
            "place"
          ],
          "single": true,
          "description": "The place it lies in (its id). A street or square in a locality, a building in a street, square or locality; a locality may lie in another one. One at most."
        },
        "name": {
          "label": "Name",
          "kind": "string",
          "required": true
        },
        "description": {
          "label": "Beschreibung",
          "kind": "string",
          "required": false,
          "multiline": true
        },
        "location": {
          "label": "Geokoordinaten",
          "kind": "location",
          "required": false
        },
        "address": {
          "label": "Adresse",
          "kind": "string",
          "required": false
        },
        "stub": {
          "label": "Unvollständig",
          "kind": "boolean",
          "required": false,
          "description": "Made by the chat from a name only; to be completed. Take it away when the entry is complete."
        },
        "links": {
          "label": "Links",
          "kind": "links",
          "required": false
        }
      }
    },
    "event": {
      "class": "entity",
      "label": "Ereignis",
      "dir": "entities/events",
      "id": "path",
      "subtypes": {},
      "fields": {
        "name": {
          "label": "Name",
          "kind": "string",
          "required": true
        },
        "description": {
          "label": "Beschreibung",
          "kind": "string",
          "required": false,
          "multiline": true
        },
        "recurring": {
          "label": "Wiederkehrend",
          "kind": "boolean",
          "required": false
        },
        "schedule": {
          "label": "Zeitplan",
          "kind": "string",
          "required": false,
          "description": "Only for a recurring event: when it takes place, in words (\"jährlich am Samstag vor Ostern\")."
        },
        "rule": {
          "label": "Regel",
          "kind": "rule",
          "required": false,
          "description": "Only for a recurring event: the dates it takes place on, as a rule. rrule is an RRULE as in RFC 5545 (FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=30), start is the first date (2026-04-30 or 2026-04-30T19:00). Besides the standard, BYEASTER=-1 (days before or after Easter Sunday, e.g. FREQ=YEARLY;BYEASTER=-1 is the Saturday before Easter) and BYADVENT=-1 (days before or after the first Advent) can be used, each alone with FREQ=YEARLY and INTERVAL, COUNT or UNTIL."
        },
        "dates": {
          "label": "Termine",
          "kind": "dates",
          "required": false,
          "description": "The dates it takes place on (past ones too): a list of start (2026-04-04 or 2026-04-04T19:00), end (optional, for several days), note (optional) and cancelled (true: it did not take place; takes that date out of the rule). A one-off event needs at least one; for a recurring one they add to the rule."
        },
        "organizers": {
          "label": "Veranstalter",
          "kind": "ref",
          "required": false,
          "ref": [
            "person",
            "organization"
          ]
        },
        "places": {
          "label": "Orte",
          "kind": "ref",
          "required": false,
          "ref": [
            "place"
          ]
        },
        "stub": {
          "label": "Unvollständig",
          "kind": "boolean",
          "required": false,
          "description": "Made by the chat from a name only; to be completed. Take it away when the entry is complete."
        },
        "links": {
          "label": "Links",
          "kind": "links",
          "required": false
        }
      }
    },
    "thing": {
      "class": "entity",
      "label": "Ding",
      "dir": "entities/things",
      "id": "path",
      "subtypes": {},
      "fields": {
        "name": {
          "label": "Name",
          "kind": "string",
          "required": true
        },
        "description": {
          "label": "Beschreibung",
          "kind": "string",
          "required": false,
          "multiline": true
        },
        "places": {
          "label": "Orte",
          "kind": "ref",
          "required": false,
          "ref": [
            "place"
          ]
        },
        "owners": {
          "label": "Gehört zu",
          "kind": "ref",
          "required": false,
          "ref": [
            "person",
            "organization"
          ]
        },
        "stub": {
          "label": "Unvollständig",
          "kind": "boolean",
          "required": false,
          "description": "Made by the chat from a name only; to be completed. Take it away when the entry is complete."
        },
        "links": {
          "label": "Links",
          "kind": "links",
          "required": false
        }
      }
    },
    "content": {
      "class": "content",
      "label": "Inhalt",
      "dir": "contents",
      "id": "slug",
      "subtypes": {},
      "fields": {
        "title": {
          "label": "Titel",
          "kind": "string",
          "required": true
        },
        "authors": {
          "label": "Autoren",
          "kind": "ref",
          "required": false,
          "ref": [
            "person",
            "organization"
          ]
        },
        "about": {
          "label": "Handelt von",
          "kind": "ref",
          "required": false,
          "ref": [
            "person",
            "organization",
            "place",
            "event",
            "thing"
          ],
          "description": "Any entity. The type of the entry it points to says what it is."
        },
        "objects": {
          "label": "Objekte",
          "kind": "ref",
          "required": false,
          "ref": [
            "object"
          ]
        },
        "published": {
          "label": "Veröffentlicht",
          "kind": "date",
          "required": false
        },
        "text": {
          "label": "Text",
          "kind": "text",
          "required": true,
          "description": "One Markdown text per role, at least one. See text_roles."
        }
      }
    },
    "object": {
      "class": "object",
      "label": "Objekt",
      "dir": "objects",
      "id": "object",
      "subtypes": {
        "photo": "Foto",
        "drawing": "Zeichnung",
        "print": "Druckgrafik",
        "plan": "Karte / Plan",
        "letter": "Brief",
        "note": "Notiz",
        "protocol": "Protokoll",
        "brochure": "Broschüre",
        "album": "Album",
        "collection": "Sammlung"
      },
      "fields": {
        "kind": {
          "label": "Typ",
          "kind": "choice",
          "required": true,
          "options": {
            "image": "Bild",
            "document": "Dokument",
            "audio": "Audio",
            "video": "Video",
            "group": "Gruppe"
          }
        },
        "title": {
          "label": "Titel",
          "kind": "string",
          "required": true
        },
        "description": {
          "label": "Beschreibung",
          "kind": "string",
          "required": false,
          "multiline": true
        },
        "date": {
          "label": "Datum",
          "kind": "string",
          "required": false
        },
        "origin": {
          "label": "Herkunft",
          "kind": "group",
          "required": false,
          "description": "Who made it, and where. The place only when it does not follow from who made it (a letter from Lenzen, written by somebody who lives in Hamburg).",
          "parts": {
            "by": {
              "label": "Von",
              "kind": "ref",
              "ref": [
                "person",
                "organization"
              ]
            },
            "place": {
              "label": "Ort",
              "kind": "ref",
              "ref": [
                "place"
              ],
              "single": true
            }
          }
        },
        "about": {
          "label": "Bezüge",
          "kind": "ref",
          "required": false,
          "ref": [
            "person",
            "organization",
            "place",
            "event",
            "thing"
          ],
          "description": "What the object shows or mentions. Any entity; the type of the entry says what it is. The same field as on contents."
        },
        "original": {
          "label": "Original",
          "kind": "group",
          "required": false,
          "description": "Where the original is, if there is one (there is only one).",
          "parts": {
            "holder": {
              "label": "Aufbewahrung",
              "kind": "ref",
              "ref": [
                "person",
                "organization"
              ],
              "single": true
            },
            "reference": {
              "label": "Signatur",
              "kind": "string"
            },
            "uri": {
              "label": "Link",
              "kind": "string"
            },
            "note": {
              "label": "Notiz",
              "kind": "string"
            }
          }
        },
        "owner": {
          "label": "Eigentümer",
          "kind": "ref",
          "required": false,
          "ref": [
            "person",
            "organization"
          ],
          "single": true,
          "description": "Only when the original belongs to somebody other than its holder (loan, deposit)."
        },
        "parents": {
          "label": "Gehört zu",
          "kind": "ref",
          "required": false,
          "ref": [
            "object"
          ],
          "description": "The groups this object is in (album, collection); several are possible. Only this side is written. A group can be in groups, but not in itself, not through others."
        },
        "recipient": {
          "label": "Empfänger",
          "kind": "ref",
          "required": false,
          "ref": [
            "person",
            "organization"
          ],
          "applies": [
            "document"
          ]
        },
        "language": {
          "label": "Sprache",
          "kind": "string",
          "required": false,
          "applies": [
            "document"
          ]
        },
        "alt": {
          "label": "Alternativtext",
          "kind": "string",
          "required": false,
          "description": "What is to be seen, for people who cannot see it. To be required for images (rule not yet written).",
          "applies": [
            "image"
          ]
        },
        "caption": {
          "label": "Bildunterschrift",
          "kind": "string",
          "required": false
        },
        "license": {
          "label": "Lizenz",
          "kind": "string",
          "required": false,
          "description": "To be worked out (a list of values). Free text for now."
        },
        "notes": {
          "label": "Notizen",
          "kind": "string",
          "required": false,
          "description": "Internal notes of the person capturing the object.",
          "multiline": true
        },
        "storage": {
          "label": "Ablage",
          "kind": "choice",
          "required": false,
          "options": {
            "local": "Hier",
            "external": "Anderswo"
          },
          "description": "local (default): the content is in our object store, described by files. external: it is somewhere else, described by external; files then only accompany it (thumbnail, screenshot)."
        },
        "external": {
          "label": "Externe Fundstelle",
          "kind": "other",
          "required": false,
          "description": "One entry per place, when storage is external."
        },
        "files": {
          "label": "Dateien",
          "kind": "files",
          "required": false,
          "description": "Zero or more, each with a role; derived files (previews, OCR text, transcripts) are variants of a file."
        }
      },
      "kinds": {
        "image": {
          "label": "Bild",
          "subtypes": {
            "photo": "Foto",
            "drawing": "Zeichnung",
            "print": "Druckgrafik",
            "plan": "Karte / Plan"
          },
          "files": {
            "roles": [
              "main"
            ],
            "max": 1
          }
        },
        "document": {
          "label": "Dokument",
          "subtypes": {
            "letter": "Brief",
            "note": "Notiz",
            "protocol": "Protokoll",
            "brochure": "Broschüre"
          },
          "files": {
            "roles": [
              "page"
            ],
            "numbered": true
          }
        },
        "audio": {
          "label": "Audio",
          "subtypes": {},
          "files": {
            "roles": [
              "main"
            ]
          }
        },
        "video": {
          "label": "Video",
          "subtypes": {},
          "files": {
            "roles": [
              "main"
            ]
          }
        },
        "group": {
          "label": "Gruppe",
          "subtypes": {
            "album": "Album",
            "collection": "Sammlung"
          },
          "files": {
            "max": 0
          }
        }
      }
    }
  },
  "textRoles": {
    "body": {
      "label": "Text",
      "fallback": [],
      "description": "The full text."
    },
    "teaser": {
      "label": "Teaser",
      "max": 200,
      "fallback": [
        "summary"
      ],
      "description": "The lead-in on overviews and tiles."
    },
    "summary": {
      "label": "Zusammenfassung",
      "max": 300,
      "fallback": [
        "teaser"
      ]
    },
    "meta_description": {
      "label": "Meta-Beschreibung",
      "max": 160,
      "fallback": [
        "summary",
        "teaser"
      ],
      "description": "For search engines and link previews."
    },
    "social": {
      "label": "Social Media",
      "max": 2200,
      "fallback": [
        "teaser",
        "summary"
      ],
      "description": "To be defined with the person in charge of social media."
    },
    "print": {
      "label": "Print",
      "fallback": [
        "body"
      ],
      "description": "For the Amtsblatt, notices, newspapers."
    }
  }
} as const

export type EntryType = keyof typeof MODEL.types
export type EntryClass = keyof typeof MODEL.classes
export type TextRole = keyof typeof MODEL.textRoles

export const ENTRY_TYPES = Object.keys(MODEL.types) as EntryType[]
export const TEXT_ROLES = Object.keys(MODEL.textRoles) as TextRole[]
