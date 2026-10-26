# Seagrass Mapping Survey

A Streamlit survey prototype with fast, **click-only** Leaflet hex mapping, a sidebar workflow, and local SQLite saving.

## Launch

Open a terminal in this folder:

```powershell
python -m pip install -r requirements.txt
python -m streamlit run app.py
```

Requires Streamlit 1.51+ (Components v2). Shapely and PyProj generate the demo hexagons. Leaflet and OpenStreetMap tiles currently load from the internet.

## Survey pages

- **Introduction:** Purpose, voluntary participation, Begin survey button.
- **Introductory questions (1–3):** Occupation, seagrass familiarity (conditional explanation/photos), and benefits Yes/No. Questions appear progressively and earlier answers remain scrollable.
- **Mapping (4):** Benefit categories grouped into **Goods & livelihoods** (5 options) and **Personal & community** (9 options). Choose a benefit, click cells to assign it, click again to remove it, and switch benefits without reloading the map. Each cell may hold multiple categories. Undo and Clear all are above the map. Optional alternative answers: Cannot locate, Prefer not to share, No benefits, Unsure.
- **Follow-up questions (5–10):** Location confidence; uses of each mapped good; three most important mapped benefits; frequency; impacts of seagrass loss; and concerns. If Q3 = No, questions 4–9 are skipped and Q10 remains available. Questions 5–7 adapt to the map results.

**Important:** The mapping step now classifies hexagons directly by benefit. It no longer has a separate “important places first / why important” mode, or a coastal-location dropdown. Map zoom and pan remain available, with labels for Sanur, Padang Bai, and Nusa Lembongan.

## Photos

For the familiarity explanation, create a `photos/` directory beside `app.py` and add locally verified `.jpg`, `.jpeg`, `.png`, or `.webp` seagrass photos. They will appear for respondents who do not recognize seagrass or are unsure.

## Saving, prior data, and privacy

Responses are written to `participant_responses.sqlite` in this folder:

- `participant_surveys` stores Q1–3 and Q5–10, including structured JSON columns for uses of goods, top benefits, and concerns.
- `mapped_hexes` stores selected hexes/geometry.
- `hex_values` stores the Q4 benefit assignments for each hex; a hex may have multiple rows.
- `participant_submissions` stores map notes and the optional **Other** benefit description.

**Mapping requires pressing “Save mapped benefits.”** The browser also holds a temporary tab-local draft when switching sections, but that draft is not a durable submission. Survey question responses autosave when edited. Save your map again after making corrections before completing Q5–10.

This version **does not erase or replace the existing SQLite tables**. It adds new survey columns as needed. Keep your existing `participant_responses.sqlite` when updating; do not overwrite it with this download. The new mapping vocabulary differs from the old prototype categories, so older mappings are retained as historical records rather than silently converted.

On a shared field device, finish one participant and press **Start a new participant** before continuing. Do not publish the SQLite database or use this local-file backend unchanged for simultaneous public submissions; plan shared, access-controlled storage and consent before deployment.

## Prototype geography and limitations

The hex grid uses approximate coordinates within 4 km of each demo coastal community. These are **not official seagrass boundaries**. Replace them with reviewed study-area/seagrass layers before real data collection. Online tile servers and JavaScript mean this version is **not fully offline**, though saved submissions live locally.
