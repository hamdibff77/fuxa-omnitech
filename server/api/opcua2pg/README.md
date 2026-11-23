# OPC UA → PostgreSQL (integrated in FUXA)

Available in FUXA at **Connections settings → OPCUA->PostgreSQL** tab.

## Files
- `index.js` — Express API + embedded OPC UA generator + transfer scheduler (reuses FUXA's node-opcua and pg).
- `generator/config.json`, `generator/settings.json` — tag definitions and server settings.
- `web/` — the embedded web UI served at `/opcua2pg/index.html`.

## Generator — Excel import
Click **Import from Excel** in the generator card and select an `.xlsx` file.

Expected columns (per `opcua-generator-rules-fit.pdf`):

| nom | type | description | group | identifiant(optionnel) |
|---|---|---|---|---|
| nom_tag1 | Boolean | tag1 description | nom_group1 | 1000 |
| nom_tag2 | Double | tag2 description | nom_group1 | 1001 |
| nom_tag3 | Int64 | tag3 description | nom_group2 | 1002 |

- The parser finds the header row containing `nom` and `type` anywhere in the first sheet.
- Types are normalized: Boolean → Boolean, Int64/Integer → Integer, Double/Float/Numeric → Float, String/Text → String.
- `identifiant` is optional. Import **replaces** the tag list; click **Save tags** to persist.

## Workflow
1. Import Excel tags (or edit the tag table) → **Save tags** → **Start generator**.
2. **Use endpoint below** → **Connect** → **Find all variables**.
3. Discover PostgreSQL → create/select a destination table (auto `Date et heure` column).
4. Pair variables → columns with **OK · add pair**, set the per-tag interval.
5. **Write once now** or **Start transfer**.
