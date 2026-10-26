"""Seagrass Mapping Survey — local-first participatory hex mapping prototype.

Hexagon/category toggles happen browser-side in a Streamlit Components v2
Leaflet component. The explicit Save action persists map responses to SQLite.
"""

import json
import math
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import streamlit as st
from pyproj import Transformer
from shapely.geometry import Point, Polygon, mapping
from shapely.ops import transform

HERE = Path(__file__).resolve().parent
DB_PATH = HERE / "participant_responses.sqlite"
PHOTOS_DIR = HERE / "photos"

# These are approximate demonstration centers, not verified study boundaries.
FOCUS_AREAS = {
    "Sanur": {"center": [-8.707, 115.263]},
    "Padang Bai": {"center": [-8.531, 115.509]},
    "Nusa Lembongan": {"center": [-8.680, 115.455]},
}

BENEFIT_GROUPS = {
    "Goods and livelihoods": [
        "Getting fish or other seafood",
        "Getting bait",
        "Getting plants or other useful materials",
        "Getting animal feed",
        "Getting materials for traditional remedies",
    ],
    "Personal and community benefits": [
        "Enjoying natural beauty",
        "Feeling calm and relaxed",
        "Enjoying recreation, such as swimming or snorkeling",
        "Feeling connected to family, friends, or community",
        "Learning or sharing local knowledge",
        "Feeling attached to a special place",
        "Maintaining traditions or cultural identity",
        "Spiritual or religious meaning",
        "Other",
    ],
}
ALL_BENEFITS = [benefit for group in BENEFIT_GROUPS.values() for benefit in group]
GOODS = BENEFIT_GROUPS["Goods and livelihoods"]

OCCUPATIONS = [
    "Fishing or seafood harvesting",
    "Aquaculture",
    "Tourism or recreation",
    "Coastal or marine conservation",
    "Business or trade",
    "Other",
    "Prefer not to answer",
]
FAMILIARITY_CHOICES = [
    "I know what seagrass is and can recognize it.",
    "I have heard of seagrass but would not recognize it.",
    "I have never heard of seagrass.",
    "I am not sure.",
]
MAP_CHOICES = [
    "I want to map my benefits",
    "Cannot locate",
    "Prefer not to share",
    "No benefits",
    "Unsure",
]
CONFIDENCE_CHOICES = ["Confident", "Locations are approximate", "Unsure"]
GOODS_USES = ["Personal or household use", "Sale", "Both", "Other"]
FREQUENCY_CHOICES = [
    "Daily or almost daily", "Weekly", "Monthly", "A few times", "Once",
    "Not in the past 12 months", "Unsure",
]
AFFECTED_CHOICES = [
    "Food for my household", "Income", "Relaxation or enjoyment",
    "Connections with family, friends, or community",
    "Traditions or sense of belonging", "Other", "None", "Unsure",
]
CONCERN_CHOICES = [
    "Declining fish or seafood availability", "Pollution or declining water quality",
    "Coastal development", "Damage to seagrass habitats",
    "Restricted access to important areas", "Climate-related changes",
    "Other", "No concern", "Unsure",
]
SECTIONS = ("Introduction", "Introductory questions", "Mapping", "Follow-up questions")

HEX_RADIUS_M = 500
FOCUS_RADIUS_M = 4000
TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32750", always_xy=True).transform
TO_WGS84 = Transformer.from_crs("EPSG:32750", "EPSG:4326", always_xy=True).transform


def hexagon(cx, cy, radius):
    return Polygon([
        (cx + radius * math.cos(math.radians(60 * i)),
         cy + radius * math.sin(math.radians(60 * i)))
        for i in range(6)
    ])


@st.cache_data(show_spinner=False)
def create_hex_grid():
    """Create stable ~1 km-wide demo hexes around three Bali coastal locations."""
    features = []
    for focus_area, info in FOCUS_AREAS.items():
        lat, lon = info["center"]
        center = transform(TO_UTM, Point(lon, lat))
        focus_zone = center.buffer(FOCUS_RADIUS_M)
        minx, miny, maxx, maxy = focus_zone.bounds
        sx, sy = 1.5 * HEX_RADIUS_M, math.sqrt(3) * HEX_RADIUS_M
        column, x, count = 0, minx - HEX_RADIUS_M, 1
        while x <= maxx + HEX_RADIUS_M:
            y = miny - HEX_RADIUS_M + (sy / 2 if column % 2 else 0)
            while y <= maxy + HEX_RADIUS_M:
                cell = hexagon(x, y, HEX_RADIUS_M)
                if focus_zone.contains(cell.centroid):
                    features.append({
                        "type": "Feature",
                        "properties": {
                            "hex_id": f"{focus_area.replace(' ', '_')}_{count:03d}",
                            "focus_area": focus_area,
                        },
                        "geometry": mapping(transform(TO_WGS84, cell)),
                    })
                    count += 1
                y += sy
            column += 1
            x += sx
    return {"type": "FeatureCollection", "features": features}


def initialize_db():
    with sqlite3.connect(DB_PATH, timeout=20) as conn:
        # Retain these schemas so old participant records remain readable.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS mapped_hexes (
                participant_id TEXT NOT NULL, hex_id TEXT NOT NULL,
                focus_area TEXT, geometry_geojson TEXT, notes TEXT, saved_at TEXT,
                PRIMARY KEY (participant_id, hex_id))
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS hex_values (
                participant_id TEXT NOT NULL, hex_id TEXT NOT NULL,
                value_category TEXT NOT NULL,
                PRIMARY KEY (participant_id, hex_id, value_category))
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS participant_submissions (
                participant_id TEXT PRIMARY KEY, notes TEXT, saved_at TEXT)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS participant_surveys (
                participant_id TEXT PRIMARY KEY,
                occupation TEXT, occupation_other TEXT,
                familiarity TEXT, receives_benefits TEXT,
                concerns TEXT, completed_at TEXT, updated_at TEXT NOT NULL)
        """)

        # Add survey v2 fields non-destructively for existing databases.
        new_columns = {
            "map_status": "TEXT",                  # Q4 alternative answer
            "location_confidence": "TEXT",         # Q5
            "uncertain_locations": "TEXT",          # Q5 clarification
            "goods_uses_json": "TEXT",             # Q6
            "top_benefits_json": "TEXT",            # Q7
            "benefit_frequency": "TEXT",           # Q8
            "affected_life": "TEXT",               # Q9
            "affected_life_other": "TEXT",         # Q9 other
            "main_concerns_json": "TEXT",          # Q10
            "main_concerns_other": "TEXT",         # Q10 other
        }
        existing_survey_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(participant_surveys)")
        }
        for name, datatype in new_columns.items():
            if name not in existing_survey_cols:
                conn.execute(
                    f'ALTER TABLE participant_surveys ADD COLUMN "{name}" {datatype}'
                )
                existing_survey_cols.add(name)
        existing_submission_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(participant_submissions)")
        }
        if "other_benefit_text" not in existing_submission_cols:
            conn.execute(
                "ALTER TABLE participant_submissions ADD COLUMN other_benefit_text TEXT"
            )


def active_benefits():
    """Distinct benefit choices from the participant's most recently saved map."""
    snapshot = st.session_state.get("saved_snapshot") or {}
    values = {
        category
        for record in snapshot.get("selected", [])
        for category in record.get("categories", [])
        if category in ALL_BENEFITS
    }
    return [choice for choice in ALL_BENEFITS if choice in values]


def save_survey_answers():
    """Autosave survey widgets without changing existing mapping tables."""
    participant_id = st.session_state.participant_id
    now = datetime.now(timezone.utc).isoformat()
    occupation = st.session_state.get("occupation")
    benefits = st.session_state.get("benefits")
    selected = active_benefits()
    selected_goods = [good for good in GOODS if good in selected]

    uses = {}
    for i, good in enumerate(GOODS):
        if good in selected_goods:
            use = st.session_state.get(f"good_use_{i}")
            if use:
                uses[good] = {
                    "use": use,
                    "other": st.session_state.get(f"good_use_other_{i}", "") if use == "Other" else "",
                }

    # Ranking is explicit: first choice is most important, then second and third.
    # Save as an ordered JSON list to preserve the rank in existing databases.
    ranked = []
    for rank in (1, 2, 3):
        value = st.session_state.get(f"rank_{rank}")
        if value and value in selected and value not in ranked:
            ranked.append(value)
        else:
            break
    concerns = st.session_state.get("main_concerns", [])
    with sqlite3.connect(DB_PATH, timeout=20) as conn:
        conn.execute("""
            INSERT INTO participant_surveys (
                participant_id, occupation, occupation_other, familiarity,
                receives_benefits, concerns, completed_at, updated_at,
                map_status, location_confidence, uncertain_locations,
                goods_uses_json, top_benefits_json, benefit_frequency,
                affected_life, affected_life_other,
                main_concerns_json, main_concerns_other
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(participant_id) DO UPDATE SET
                occupation=excluded.occupation,
                occupation_other=excluded.occupation_other,
                familiarity=excluded.familiarity,
                receives_benefits=excluded.receives_benefits,
                concerns=excluded.concerns,
                updated_at=excluded.updated_at,
                map_status=excluded.map_status,
                location_confidence=excluded.location_confidence,
                uncertain_locations=excluded.uncertain_locations,
                goods_uses_json=excluded.goods_uses_json,
                top_benefits_json=excluded.top_benefits_json,
                benefit_frequency=excluded.benefit_frequency,
                affected_life=excluded.affected_life,
                affected_life_other=excluded.affected_life_other,
                main_concerns_json=excluded.main_concerns_json,
                main_concerns_other=excluded.main_concerns_other
        """, (
            participant_id,
            occupation,
            st.session_state.get("occupation_other", "") if occupation == "Other" else "",
            st.session_state.get("familiarity"), benefits,
            st.session_state.get("concerns", ""), now,
            st.session_state.get("map_status"),
            st.session_state.get("location_confidence"),
            st.session_state.get("uncertain_locations", ""),
            json.dumps(uses, ensure_ascii=False),
            json.dumps(ranked, ensure_ascii=False),
            st.session_state.get("benefit_frequency"),
            st.session_state.get("affected_life"),
            st.session_state.get("affected_life_other", "")
            if st.session_state.get("affected_life") == "Other" else "",
            json.dumps(concerns, ensure_ascii=False),
            st.session_state.get("main_concerns_other", "")
            if "Other" in concerns else "",
        ))


def finish_participant():
    save_survey_answers()
    with sqlite3.connect(DB_PATH, timeout=20) as conn:
        conn.execute(
            "UPDATE participant_surveys SET completed_at = ? WHERE participant_id = ?",
            (datetime.now(timezone.utc).isoformat(), st.session_state.participant_id),
        )
    st.session_state.finished = True


def save_mapping_submission(payload, grid):
    if not isinstance(payload, dict):
        raise ValueError("Invalid map submission")
    if payload.get("participant_id") != st.session_state.participant_id:
        raise ValueError("Participant ID mismatch. Please try saving again.")
    selected = payload.get("selected", [])
    if not isinstance(selected, list):
        raise ValueError("Invalid hexagon list")

    known = {item["properties"]["hex_id"]: item for item in grid["features"]}
    records, values, seen = [], [], set()
    timestamp = datetime.now(timezone.utc).isoformat()
    participant_id = st.session_state.participant_id
    for response in selected:
        if not isinstance(response, dict):
            raise ValueError("Invalid map record")
        hex_id = response.get("hex_id")
        if not isinstance(hex_id, str) or hex_id not in known or hex_id in seen:
            raise ValueError("Invalid or duplicate hex ID")
        seen.add(hex_id)
        categories = response.get("categories", [])
        if not isinstance(categories, list) or not categories or any(
            not isinstance(cat, str) or cat not in ALL_BENEFITS for cat in categories
        ):
            raise ValueError("Each mapped hex must have at least one recognized benefit")
        feature = known[hex_id]
        records.append((
            participant_id, hex_id, feature["properties"]["focus_area"],
            json.dumps(feature["geometry"]), "", timestamp,
        ))
        values.extend((participant_id, hex_id, category) for category in sorted(set(categories)))

    notes = str(payload.get("notes", ""))[:5000]
    other_text = str(payload.get("other_benefit_text", ""))[:1000]
    with sqlite3.connect(DB_PATH, timeout=20) as conn:
        conn.execute("DELETE FROM hex_values WHERE participant_id = ?", (participant_id,))
        conn.execute("DELETE FROM mapped_hexes WHERE participant_id = ?", (participant_id,))
        conn.executemany("""
            INSERT INTO mapped_hexes
              (participant_id, hex_id, focus_area, geometry_geojson, notes, saved_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, records)
        conn.executemany("""
            INSERT INTO hex_values (participant_id, hex_id, value_category)
            VALUES (?, ?, ?)
        """, values)
        conn.execute("""
            INSERT INTO participant_submissions
              (participant_id, notes, saved_at, other_benefit_text)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(participant_id) DO UPDATE SET
              notes=excluded.notes, saved_at=excluded.saved_at,
              other_benefit_text=excluded.other_benefit_text
        """, (participant_id, notes, timestamp, other_text))
    return len(records), len(values)


def navigate(section):
    st.session_state.section = section


def reveal_question(number):
    st.session_state.revealed_questions = max(number, st.session_state.revealed_questions)
    save_survey_answers()


def on_map_mode_change():
    save_survey_answers()


def on_concerns_changed():
    """Treat 'No concern' and 'Unsure' as exclusive choices."""
    selected = st.session_state.get("main_concerns", [])
    previous = st.session_state.get("previous_concerns", [])
    additions = [item for item in selected if item not in previous]
    latest = additions[-1] if additions else None
    if latest in ("No concern", "Unsure"):
        selected = [latest]
    elif latest:
        selected = [item for item in selected if item not in ("No concern", "Unsure")]
    elif "No concern" in selected and len(selected) > 1:
        selected = ["No concern"]
    elif "Unsure" in selected and len(selected) > 1:
        selected = ["Unsure"]
    st.session_state.main_concerns = selected
    st.session_state.previous_concerns = list(selected)
    save_survey_answers()


def start_new_participant():
    st.session_state.participant_id = "P-" + uuid.uuid4().hex[:8].upper()
    st.session_state.section = "Introduction"
    st.session_state.revealed_questions = 1
    st.session_state.map_saved = False
    st.session_state.saved_snapshot = {}
    st.session_state.last_map_save_request = None
    st.session_state.saved_receipt = None
    st.session_state.finished = False
    for name in (
        "occupation", "occupation_other", "familiarity", "benefits", "map_status",
        "location_confidence", "uncertain_locations", "top_benefits",
        "rank_1", "rank_2", "rank_3",
        "benefit_frequency", "affected_life", "affected_life_other", "main_concerns",
        "main_concerns_other", "previous_concerns", "concerns",
    ):
        st.session_state.pop(name, None)
    for i in range(len(GOODS)):
        st.session_state.pop(f"good_use_{i}", None)
        st.session_state.pop(f"good_use_other_{i}", None)


st.set_page_config(page_title="Seagrass Mapping Survey", layout="wide")
if not hasattr(st.components, "v2"):
    st.error("Requires Streamlit 1.51+. Run: python -m pip install --upgrade streamlit")
    st.stop()

for name, default in (
    ("participant_id", "P-" + uuid.uuid4().hex[:8].upper()),
    ("section", "Introduction"),
    ("revealed_questions", 1),
    ("map_saved", False),
    ("saved_snapshot", {}),
    ("last_map_save_request", None),
    ("saved_receipt", None),
    ("finished", False),
    ("previous_concerns", []),
):
    if name not in st.session_state:
        st.session_state[name] = default

initialize_db()

with st.sidebar:
    st.title("Seagrass Mapping Survey")
    st.radio("Sections", SECTIONS, key="section")
    st.divider()
    st.caption(f"Participant ID: {st.session_state.participant_id}")
    st.caption("All questions are optional. You may stop at any time.")
    st.caption("Responses are stored locally, not uploaded to GitHub.")

section = st.session_state.section

if section == "Introduction":
    st.title("Seagrass Mapping Survey")
    st.subheader("Introduction")
    st.write(
        "We want to understand which seagrass areas matter to you and your "
        "community, what benefits you receive from them, and where those benefits occur."
    )
    st.write(
        "Your responses will help us understand the importance of seagrass areas "
        "for local communities. We may use summarized findings and maps in a "
        "later workshop with people involved in seagrass conservation and management."
    )
    st.write(
        "Participation is voluntary. You may skip questions, decline to share "
        "locations, or stop at any time."
    )
    st.button("Begin survey →", type="primary", on_click=navigate,
              args=("Introductory questions",))

elif section == "Introductory questions":
    st.title("Introductory questions")
    st.caption(
        "Questions appear progressively, but remain visible so you can scroll "
        "back and update answers. All questions are optional."
    )

    with st.container(border=True):
        st.subheader("1. What is your main occupation or livelihood?")
        st.radio("Select one (optional)", OCCUPATIONS, index=None,
                 key="occupation", on_change=save_survey_answers)
        if st.session_state.get("occupation") == "Other":
            st.text_input("Please specify (optional)", key="occupation_other",
                          on_change=save_survey_answers)
        if st.session_state.revealed_questions < 2:
            st.button("Next question →", type="primary", key="next_q1",
                      on_click=reveal_question, args=(2,))

    if st.session_state.revealed_questions >= 2:
        with st.container(border=True):
            st.subheader("2. How familiar are you with seagrass?")
            st.radio("Select one (optional)", FAMILIARITY_CHOICES, index=None,
                     key="familiarity", on_change=save_survey_answers)
            familiarity = st.session_state.get("familiarity")
            if familiarity and familiarity != FAMILIARITY_CHOICES[0]:
                st.info(
                    "Seagrass is a flowering plant rooted in shallow coastal waters. "
                    "Unlike seaweed, it has roots, leaves, and flowers. Seagrass can "
                    "form underwater meadows that provide habitat for fish and "
                    "other marine animals."
                )
                photos = sorted(
                    p for p in PHOTOS_DIR.iterdir()
                    if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")
                ) if PHOTOS_DIR.exists() else []
                if photos:
                    captions = [
                        "Christian Gloor, Wakatobi, Indonesia",
                        "Ghofar Ismail Putra, West Java, Indonesia",
                    ]
                    cols = st.columns(min(2, len(photos)))
                    for i, photo in enumerate(photos):
                        # Prefer artist/place information from filenames when available.
                        photo_name = photo.stem.lower()
                        if "gloor" in photo_name or "wakatobi" in photo_name:
                            caption = captions[0]
                        elif "ghofar" in photo_name or "java" in photo_name:
                            caption = captions[1]
                        else:
                            caption = captions[i] if i < len(captions) else ""
                        with cols[i % len(cols)]:
                            st.image(str(photo), use_container_width=True)
                            if caption:
                                st.caption(caption)
                else:
                    st.caption("Add the two seagrass photos to the `photos/` folder to display them here.")
            if st.session_state.revealed_questions < 3:
                st.button("Next question →", type="primary", key="next_q2",
                          on_click=reveal_question, args=(3,))

    if st.session_state.revealed_questions >= 3:
        with st.container(border=True):
            st.subheader("3. Do you use seagrass areas or receive any benefits from them?")
            st.radio("Select one (optional)", ["Yes", "No"], index=None,
                     key="benefits", on_change=save_survey_answers)
            no_benefits = st.session_state.get("benefits") == "No"
            if no_benefits:
                st.caption("Personal-benefit mapping is skipped; continue to Question 10.")
            target = "Follow-up questions" if no_benefits else "Mapping"
            label = "Continue to Question 10 →" if no_benefits else "Continue to mapping →"
            st.button(label, type="primary", on_click=navigate, args=(target,))

elif section == "Mapping":
    st.title("4. What benefits do you receive from seagrass areas, and where?")
    if st.session_state.get("benefits") == "No":
        st.info("You answered No to Question 3, so personal-benefit mapping is skipped.")
        st.button("Continue to Question 10 →", type="primary",
                  on_click=navigate, args=("Follow-up questions",))
    else:
        st.write(
            "**Choose one benefit, then click all grid cells connected to it. "
            "Switch to another benefit and repeat. Save your map when finished.**"
        )
        st.caption(
            "Select multiple cells for each benefit if needed. The same cell may "
            "provide several benefits. You can reuse previously selected locations "
            "and review or edit your choices before saving. Click a cell again to "
            "remove the currently selected benefit."
        )
        st.selectbox(
            "Mapping participation (choose another option if you do not want to map):",
            MAP_CHOICES, index=0, key="map_status", on_change=on_map_mode_change,
        )
        map_status = st.session_state.get("map_status", MAP_CHOICES[0])
        if map_status != MAP_CHOICES[0]:
            st.info(f"Mapping skipped: {map_status}.")
            st.button("Continue to follow-up questions →", type="primary",
                      on_click=navigate, args=("Follow-up questions",))
        else:
            grid = create_hex_grid()
            map_component = st.components.v2.component(
                name="seagrass_survey_map_v2_benefits",
                html="<section class='pgis-root'></section>",
                css=(HERE / "map_component.css").read_text(encoding="utf-8"),
                js=(HERE / "map_component.js").read_text(encoding="utf-8"),
                isolate_styles=False,
            )
            result = map_component(
                key="seagrass_mapping_surface",
                data={
                    "participant_id": st.session_state.participant_id,
                    "benefit_groups": BENEFIT_GROUPS,
                    "focus_areas": FOCUS_AREAS,
                    "hex_features": grid,
                    "saved_snapshot": st.session_state.saved_snapshot,
                    "saved_receipt": st.session_state.saved_receipt,
                },
                on_save_change=lambda: None,
            )
            submission = result.save
            if submission and isinstance(submission, dict):
                request_id = submission.get("request_id")
                if request_id and request_id != st.session_state.last_map_save_request:
                    try:
                        count, assignments = save_mapping_submission(submission, grid)
                        st.session_state.last_map_save_request = request_id
                        st.session_state.saved_receipt = request_id
                        st.session_state.map_saved = True
                        st.session_state.saved_snapshot = {
                            "selected": submission.get("selected", []),
                            "notes": submission.get("notes", ""),
                            "other_benefit_text": submission.get("other_benefit_text", ""),
                        }
                        # Autosave affected question eligibility and the Q6/Q7 choices.
                        save_survey_answers()
                        st.success(
                            f"Saved {count} hexagons with {assignments} benefit assignments."
                        )
                    except (ValueError, sqlite3.Error) as exc:
                        st.error(f"Could not save the map: {exc}")
            if st.session_state.map_saved:
                st.button("Continue to follow-up questions →", type="primary",
                          on_click=navigate, args=("Follow-up questions",))
            else:
                st.button("Skip mapping and continue →", on_click=navigate,
                          args=("Follow-up questions",))
            st.caption(
                "Approximate prototype hexagons near Sanur, Padang Bai, and Nusa Lembongan. "
                "Map tiles and the Leaflet library currently require an internet connection."
            )

else:  # Follow-up questions
    st.title("Follow-up questions")
    benefits_yes = st.session_state.get("benefits") != "No"
    map_status = st.session_state.get("map_status", MAP_CHOICES[0])
    mapped = bool(st.session_state.get("map_saved")) and map_status == MAP_CHOICES[0]
    selected_benefits = active_benefits() if mapped else []
    selected_goods = [good for good in GOODS if good in selected_benefits]

    if not benefits_yes or map_status == "No benefits":
        st.info("Since you reported no benefits, Questions 5–9 are skipped. Please answer Question 10 if you wish.")
    else:
        if mapped:
            with st.container(border=True):
                st.subheader("5. How confident are you about the locations you marked?")
                st.radio("Select one (optional)", CONFIDENCE_CHOICES, index=None,
                         key="location_confidence", on_change=save_survey_answers)
                st.text_area(
                    "Identify any uncertain locations or explain what you would correct (optional)",
                    key="uncertain_locations", on_change=save_survey_answers,
                )
                st.button("Return to map to correct selections", on_click=navigate,
                          args=("Mapping",))

        if selected_goods:
            with st.container(border=True):
                st.subheader("6. What do you use the goods you obtain for?")
                st.caption("Answer for each good you mapped in Question 4.")
                for i, good in enumerate(GOODS):
                    if good not in selected_goods:
                        continue
                    st.selectbox(good, GOODS_USES, index=None, key=f"good_use_{i}",
                                 placeholder="Select one (optional)",
                                 on_change=save_survey_answers)
                    if st.session_state.get(f"good_use_{i}") == "Other":
                        st.text_input(f"Other use of {good.lower()} (optional)",
                                      key=f"good_use_other_{i}",
                                      on_change=save_survey_answers)

        if selected_benefits:
            with st.container(border=True):
                st.subheader("7. Which benefits matter most to you?")
                st.caption("Rank up to three benefits you mapped in Question 4, from most to least important.")

                # Remove choices that disappeared when the participant edited the map,
                # and prevent the same benefit from occupying two ranks.
                used_ranks = []
                keep_next_rank = True
                for rank in (1, 2, 3):
                    key = f"rank_{rank}"
                    choice = st.session_state.get(key)
                    if (not keep_next_rank or choice not in selected_benefits
                            or choice in used_ranks):
                        st.session_state[key] = None
                        keep_next_rank = False
                    else:
                        used_ranks.append(choice)

                st.selectbox(
                    "1st — Most important",
                    selected_benefits,
                    index=None,
                    placeholder="Choose your first priority (optional)",
                    key="rank_1",
                    on_change=save_survey_answers,
                )
                first = st.session_state.get("rank_1")
                if first:
                    second_options = [x for x in selected_benefits if x != first]
                    if st.session_state.get("rank_2") not in second_options:
                        st.session_state.rank_2 = None
                    st.selectbox(
                        "2nd — Next most important",
                        second_options,
                        index=None,
                        placeholder="Choose your second priority (optional)",
                        key="rank_2",
                        on_change=save_survey_answers,
                    )
                    second = st.session_state.get("rank_2")
                    if second:
                        third_options = [x for x in selected_benefits if x not in (first, second)]
                        if st.session_state.get("rank_3") not in third_options:
                            st.session_state.rank_3 = None
                        if third_options:
                            st.selectbox(
                                "3rd — Third most important",
                                third_options,
                                index=None,
                                placeholder="Choose your third priority (optional)",
                                key="rank_3",
                                on_change=save_survey_answers,
                            )
                # Stale ranked options are excluded from autosaved JSON above.

        with st.container(border=True):
            st.subheader("8. How often have you received or experienced benefits?")
            st.radio("Select one (optional)", FREQUENCY_CHOICES, index=None,
                     key="benefit_frequency", on_change=save_survey_answers)

        with st.container(border=True):
            if mapped:
                st.subheader("9. If the seagrass areas you marked were lost or damaged, which part of your life would be most affected?")
            else:
                st.subheader("9. If seagrass areas that benefit you were lost or damaged, which part of your life would be most affected?")
            st.radio("Select one (optional)", AFFECTED_CHOICES, index=None,
                     key="affected_life", on_change=save_survey_answers)
            if st.session_state.get("affected_life") == "Other":
                st.text_input("Other impact (optional)", key="affected_life_other",
                              on_change=save_survey_answers)

    with st.container(border=True):
        st.subheader("10. What is your main concern about continuing to receive benefits from seagrass areas?")
        st.caption("Select all that apply. ‘No concern’ and ‘Unsure’ are exclusive options.")
        st.multiselect("Choose any that apply (optional)", CONCERN_CHOICES,
                       key="main_concerns", on_change=on_concerns_changed)
        if "Other" in st.session_state.get("main_concerns", []):
            st.text_input("Other concern (optional)", key="main_concerns_other",
                          on_change=save_survey_answers)

    if st.session_state.finished:
        st.success("Thank you. Your responses have been saved locally.")
        st.button("Start a new participant", type="primary",
                  on_click=start_new_participant)
    else:
        st.button("Finish survey", type="primary", on_click=finish_participant)

st.divider()
st.caption(
    "Participant responses are anonymous and stored in a local SQLite database. "
)
