"""Local, read-only viewer for Seagrass Mapping Survey SQLite responses.

Place next to app.py and participant_responses.sqlite.
Launch locally (not on a public server):
    python -m streamlit run seagrass_responses_viewer.py --server.address 127.0.0.1
"""

import json
import sqlite3
from pathlib import Path

import pandas as pd
import streamlit as st

DB_PATH = Path(__file__).resolve().parent / "participant_responses.sqlite"
TABLES = (
    "participant_surveys",
    "mapped_hexes",
    "hex_values",
    "participant_submissions",
)

st.set_page_config(page_title="Seagrass Survey Responses", layout="wide")
st.title("Seagrass Mapping Survey — Responses")
st.caption("Local research-team viewer. Do not deploy this page publicly or publish the database.")

if not DB_PATH.is_file():
    st.error(f"Database not found: {DB_PATH}")
    st.info("Place this viewer in the same folder as app.py and participant_responses.sqlite.")
    st.stop()


def read_data():
    connection = sqlite3.connect(DB_PATH)
    try:
        connection.execute("PRAGMA query_only = ON")
        existing = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        return {
            table: (
                pd.read_sql_query(f'SELECT * FROM "{table}"', connection)
                if table in existing else pd.DataFrame()
            )
            for table in TABLES
        }
    finally:
        connection.close()


@st.cache_data(show_spinner=False)
def load_data(last_modified):
    return read_data()


def rank_values(raw):
    if not isinstance(raw, str) or not raw:
        return []
    try:
        values = json.loads(raw)
        return values if isinstance(values, list) else []
    except (ValueError, TypeError):
        return []


def export_geojson(hexes, values):
    benefits = {}
    for row in values.itertuples(index=False):
        benefits.setdefault((row.participant_id, row.hex_id), []).append(row.value_category)
    features = []
    for row in hexes.itertuples(index=False):
        try:
            geom = json.loads(row.geometry_geojson)
        except (ValueError, TypeError):
            continue
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "participant_id": row.participant_id,
                "hex_id": row.hex_id,
                "focus_area": row.focus_area,
                "benefits": benefits.get((row.participant_id, row.hex_id), []),
            },
        })
    return json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=2)


with st.sidebar:
    st.header("Filters")
    if st.button("Refresh responses"):
        st.cache_data.clear()
        st.rerun()

all_data = load_data(DB_PATH.stat().st_mtime_ns)
surveys = all_data["participant_surveys"]
hexes = all_data["mapped_hexes"]
values = all_data["hex_values"]
submissions = all_data["participant_submissions"]

ids = sorted({
    str(pid)
    for df in all_data.values()
    if not df.empty and "participant_id" in df.columns
    for pid in df["participant_id"].dropna()
})

with st.sidebar:
    chosen_id = st.selectbox("Participant", ["All participants", *ids])

if chosen_id != "All participants":
    filtered = {
        name: df.loc[df["participant_id"].astype(str) == chosen_id].copy()
        if "participant_id" in df.columns else df
        for name, df in all_data.items()
    }
else:
    filtered = {name: df.copy() for name, df in all_data.items()}

fsurveys = filtered["participant_surveys"]
fhexes = filtered["mapped_hexes"]
fvalues = filtered["hex_values"]

m1, m2, m3, m4 = st.columns(4)
m1.metric("Participant records", len(fsurveys))
m2.metric("Completed surveys", int(fsurveys["completed_at"].notna().sum()) if "completed_at" in fsurveys else 0)
m3.metric("Selected hexagons", len(fhexes))
m4.metric("Benefit assignments", len(fvalues))

survey_tab, map_tab, export_tab = st.tabs(["Survey answers", "Mapped benefits", "Export data"])

with survey_tab:
    if fsurveys.empty:
        st.info("No saved survey answers found.")
    else:
        display = fsurveys.copy()
        if "top_benefits_json" in display.columns:
            ranks = display["top_benefits_json"].apply(rank_values)
            for i in range(3):
                display[f"Q7_rank_{i + 1}"] = ranks.apply(lambda arr, i=i: arr[i] if len(arr) > i else "")
        st.dataframe(display, use_container_width=True, hide_index=True)
        st.caption("Some multiple-choice answers (e.g. goods uses and concerns) remain in JSON columns.")

with map_tab:
    if fvalues.empty:
        st.info("No mapped benefit assignments found. Participants must press 'Save mapped benefits'.")
    else:
        st.subheader("Hexagon × benefit records")
        st.dataframe(fvalues, use_container_width=True, hide_index=True)
        st.subheader("Most selected benefits")
        counts = fvalues["value_category"].value_counts().rename_axis("Benefit").reset_index(name="Hexagon selections")
        st.dataframe(counts, use_container_width=True, hide_index=True)
    if not fhexes.empty:
        st.caption("A hexagon may appear more than once in the benefit table because it can represent multiple benefits.")

with export_tab:
    st.write("Download records for analysis in Excel, R, Python, QGIS or ArcGIS Pro.")
    for table in TABLES:
        df = filtered[table]
        st.download_button(
            label=f"Download {table}.csv",
            data=df.to_csv(index=False).encode("utf-8-sig"),
            file_name=f"{table}.csv",
            mime="text/csv",
            key=f"export_{table}",
        )
    if not fhexes.empty:
        st.download_button(
            "Download mapped benefits as GeoJSON",
            data=export_geojson(fhexes, fvalues).encode("utf-8"),
            file_name="mapped_benefits.geojson",
            mime="application/geo+json",
        )
    st.caption("Keep raw responses access-controlled. Do not publish individual mapped locations without consent.")
