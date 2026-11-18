/* Seagrass Mapping Survey — standalone offline web app.
   Same questions and branching as streamlit_app/app.py. Every answer is saved
   immediately to this device (IndexedDB); the Data & export screen produces
   files for the research team. */

import {
  APP_VERSION, FOCUS_AREAS, BENEFIT_GROUPS, GOODS, OCCUPATIONS, FAMILIARITY_CHOICES,
  MAP_CHOICES, CONFIDENCE_CHOICES, GOODS_USES, FREQUENCY_CHOICES, AFFECTED_CHOICES,
  CONCERN_CHOICES, EXCLUSIVE_CONCERNS, SECTIONS, PHOTOS,
} from "./config.js";
import {
  openDb, getParticipant, listParticipants, putParticipant, getMeta, setMeta,
  requestPersistence,
} from "./db.js";
import { createBenefitMap } from "./map.js";
import { buildExportFiles, deliverFiles, mappedBenefits, validRanking } from "./export.js";

const main = document.getElementById("main");
const nav = document.getElementById("section-nav");
const headerInfo = document.getElementById("header-info");
const saveIndicator = document.getElementById("save-indicator");
const banners = document.getElementById("banners");
const dataButton = document.getElementById("data-button");

let record = null;
let deviceName = "";
let lastExportAt = null;
let showingData = false;
let exportMessage = ""; // Survives the Data screen re-rendering after an export.
let hexes = null;
let coastline = null;
let activeMap = null;
let writeChain = Promise.resolve();

// ---------- small DOM helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el[key.toLowerCase()] = value;
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

let idCounter = 0;
const uid = prefix => `${prefix}-${++idCounter}`;

function card(title, ...children) {
  return h("section", { class: "card" }, title ? h("h2", { text: title }) : null, ...children);
}

function caption(text) { return h("p", { class: "caption", text }); }
function info(text) { return h("div", { class: "info", text }); }

function button(label, onClick, kind = "") {
  return h("button", { type: "button", class: `btn ${kind}`.trim(), onClick, text: label });
}

/** Radio list with a "Clear answer" link (all questions are optional). */
function radios(name, choices, value, onChange, label = "Select one (optional)") {
  const group = uid(name);
  const field = h("fieldset", { class: "choices" }, h("legend", { text: label }));
  for (const choice of choices) {
    const id = uid(name);
    field.append(h("label", { class: "choice", for: id },
      h("input", {
        type: "radio", name: group, id, value: choice, checked: value === choice,
        onChange: () => onChange(choice),
      }),
      h("span", { text: choice })));
  }
  if (value) field.append(h("button", {
    type: "button", class: "link", text: "Clear answer", onClick: () => onChange(null),
  }));
  return field;
}

function select(label, choices, value, onChange, placeholder = "Select one (optional)") {
  const id = uid("select");
  const el = h("select", { id, onChange: () => onChange(el.value || null) },
    h("option", { value: "", text: placeholder }),
    choices.map(choice => h("option", { value: choice, text: choice, selected: choice === value })));
  return h("div", { class: "field" }, h("label", { for: id, text: label }), el);
}

function textInput(label, value, onInput, multiline = false) {
  const id = uid("text");
  const el = h(multiline ? "textarea" : "input", {
    id, maxlength: multiline ? "5000" : "1000",
    ...(multiline ? {} : { type: "text" }),
  });
  el.value = value || "";
  el.addEventListener("input", () => onInput(el.value));
  return h("div", { class: "field" }, h("label", { for: id, text: label }), el);
}

// ---------- participant records ----------

function newParticipantId() {
  const hex = crypto.getRandomValues(new Uint8Array(4));
  return "P-" + Array.from(hex, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function blankRecord(id) {
  return {
    participant_id: id,
    device_name: deviceName,
    created_at: new Date().toISOString(),
    updated_at: null,
    completed_at: null,
    section: "Introduction",
    revealed_questions: 1,
    answers: { good_use: {}, rank: [], main_concerns: [] },
    map: { selected: [], notes: "", other_benefit_text: "", saved_at: null },
    stored: false,
  };
}

/** True once anything has been answered, so untouched new participants are not stored. */
function hasContent(r) {
  const answered = Object.values(r.answers).some(value =>
    Array.isArray(value) ? value.length > 0
      : value && typeof value === "object" ? Object.keys(value).length > 0
        : value !== null && value !== undefined && value !== "");
  return answered || r.map.selected.length > 0 || Boolean(r.map.notes) || r.revealed_questions > 1;
}

/** Save the current participant. Writes are queued so they land in order. */
function save() {
  if (!record.stored && !hasContent(record)) return Promise.resolve();
  record.updated_at = new Date().toISOString();
  record.device_name = deviceName;
  record.stored = true;
  const snapshot = JSON.parse(JSON.stringify(record));
  setSaveIndicator("saving");
  writeChain = writeChain.catch(() => {}).then(() => putParticipant(snapshot));
  const thisWrite = writeChain;
  thisWrite.then(
    () => { if (thisWrite === writeChain) setSaveIndicator("saved"); updateDataBadge(); },
    error => setSaveIndicator("error", error),
  );
  return thisWrite;
}

function setSaveIndicator(state, error) {
  saveIndicator.className = "save-indicator " + state;
  saveIndicator.textContent = state === "saving" ? "Saving…"
    : state === "saved" ? "Saved on this device ✓"
      : "NOT SAVED — " + (error && error.message ? error.message : "storage error");
  if (state === "error") {
    showBanner("error", "Answers could not be saved on this device. Do not continue; " +
      "export existing data and contact the research team.", "save-error");
  }
}

function answer(key, value, { rerender = true } = {}) {
  record.answers[key] = value;
  save();
  if (rerender) render();
}

// ---------- banners ----------

function showBanner(kind, message, key, actions = []) {
  if (key && banners.querySelector(`[data-key="${key}"]`)) return;
  const banner = h("div", { class: `banner ${kind}`, "data-key": key || "" },
    h("span", { text: message }), ...actions,
    h("button", { type: "button", class: "link", text: "Dismiss", onClick: () => banner.remove() }));
  banners.append(banner);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

// ---------- sections ----------

function navigate(section) {
  record.section = section;
  showingData = false;
  save();
  render();
  window.scrollTo(0, 0);
}

function renderNav() {
  nav.replaceChildren(...SECTIONS.map(section => h("button", {
    type: "button",
    class: "nav-btn" + (!showingData && record.section === section ? " active" : ""),
    "aria-current": !showingData && record.section === section ? "page" : null,
    text: section,
    onClick: () => navigate(section),
  })));
  headerInfo.textContent = `Participant ${record.participant_id}` +
    (deviceName ? ` · ${deviceName}` : "");
  dataButton.classList.toggle("active", showingData);
}

function renderIntroduction() {
  const parts = [];
  if (!deviceName) {
    parts.push(card("Before the first interview",
      h("p", { text: "Give this device a short name (for example “iPad-2”) so exported data shows where it came from." }),
      button("Set device name", () => { showingData = true; render(); }, "primary")));
  }
  parts.push(
    h("h1", { text: "Seagrass Mapping Survey" }),
    h("h2", { class: "subtitle", text: "Introduction" }),
    h("p", { text: "We want to understand which seagrass areas matter to you and your community, what benefits you receive from them, and where those benefits occur." }),
    h("p", { text: "Your responses will help us understand the importance of seagrass areas for local communities. We may use summarized findings and maps in a later workshop with people involved in seagrass conservation and management." }),
    h("p", { text: "Participation is voluntary. You may skip questions, decline to share locations, or stop at any time." }),
    button("Begin survey →", () => navigate("Introductory questions"), "primary"),
  );
  return parts;
}

function reveal(number) {
  record.revealed_questions = Math.max(number, record.revealed_questions);
  save();
  render();
}

function renderIntroQuestions() {
  const a = record.answers;
  const parts = [
    h("h1", { text: "Introductory questions" }),
    caption("Questions appear progressively, but remain visible so you can scroll back and update answers. All questions are optional."),
  ];

  parts.push(card("1. What is your main occupation or livelihood?",
    radios("occupation", OCCUPATIONS, a.occupation, v => answer("occupation", v)),
    a.occupation === "Other"
      ? textInput("Please specify (optional)", a.occupation_other,
        v => answer("occupation_other", v, { rerender: false }))
      : null,
    record.revealed_questions < 2 ? button("Next question →", () => reveal(2), "primary") : null));

  if (record.revealed_questions >= 2) {
    const explain = a.familiarity && a.familiarity !== FAMILIARITY_CHOICES[0];
    parts.push(card("2. How familiar are you with seagrass?",
      radios("familiarity", FAMILIARITY_CHOICES, a.familiarity, v => answer("familiarity", v)),
      explain ? info("Seagrass is a flowering plant rooted in shallow coastal waters. Unlike seaweed, it has roots, leaves, and flowers. Seagrass can form underwater meadows that provide habitat for fish and other marine animals.") : null,
      explain ? h("div", { class: "photos" }, PHOTOS.map(photo => h("figure", {},
        h("img", { src: photo.src, alt: "Seagrass photo: " + photo.caption, loading: "lazy" }),
        h("figcaption", { text: photo.caption })))) : null,
      record.revealed_questions < 3 ? button("Next question →", () => reveal(3), "primary") : null));
  }

  if (record.revealed_questions >= 3) {
    const noBenefits = a.benefits === "No";
    parts.push(card("3. Do you use seagrass areas or receive any benefits from them?",
      radios("benefits", ["Yes", "No"], a.benefits, v => answer("benefits", v)),
      noBenefits ? caption("Personal-benefit mapping is skipped; continue to Question 10.") : null,
      button(noBenefits ? "Continue to Question 10 →" : "Continue to mapping →",
        () => navigate(noBenefits ? "Follow-up questions" : "Mapping"), "primary")));
  }
  return parts;
}

function renderMapping() {
  const a = record.answers;
  const parts = [h("h1", { text: "4. What benefits do you receive from seagrass areas, and where?" })];
  if (a.benefits === "No") {
    parts.push(info("You answered No to Question 3, so personal-benefit mapping is skipped."),
      button("Continue to Question 10 →", () => navigate("Follow-up questions"), "primary"));
    return parts;
  }
  parts.push(
    h("p", {}, h("strong", { text: "Choose one benefit, then tap all grid cells connected to it. Switch to another benefit and repeat. Your map is saved automatically." })),
    caption("Select multiple cells for each benefit if needed. The same cell may provide several benefits. Tap a cell again to remove the currently selected benefit."),
  );
  const status = a.map_status || MAP_CHOICES[0];
  parts.push(h("div", { class: "field" },
    h("label", { for: "map-status", text: "Mapping participation (choose another option if you do not want to map):" }),
    (() => {
      const el = h("select", { id: "map-status", onChange: () => answer("map_status", el.value) },
        MAP_CHOICES.map(choice => h("option", { value: choice, text: choice, selected: choice === status })));
      return el;
    })()));

  if (status !== MAP_CHOICES[0]) {
    parts.push(info(`Mapping skipped: ${status}.`),
      button("Continue to follow-up questions →", () => navigate("Follow-up questions"), "primary"));
    return parts;
  }

  const mapRoot = h("div", { class: "pgis-root" });
  parts.push(mapRoot,
    h("div", { class: "after-map" },
      button("Continue to follow-up questions →", () => navigate("Follow-up questions"), "primary")));
  // Create the map after the container is in the document.
  queueMicrotask(() => {
    activeMap = createBenefitMap(mapRoot, {
      benefitGroups: BENEFIT_GROUPS,
      focusAreas: FOCUS_AREAS,
      hexes,
      coastline,
      snapshot: record.map,
      onChange: snapshot => {
        record.map = { ...snapshot, saved_at: new Date().toISOString() };
        return save();
      },
    });
  });
  return parts;
}

function renderFollowUp() {
  const a = record.answers;
  const parts = [h("h1", { text: "Follow-up questions" })];
  const benefitsYes = a.benefits !== "No";
  const status = a.map_status || MAP_CHOICES[0];
  const mapped = status === MAP_CHOICES[0] && record.map.selected.length > 0;
  const selectedBenefits = mapped ? mappedBenefits(record) : [];
  const selectedGoods = GOODS.filter(good => selectedBenefits.includes(good));

  if (!benefitsYes || status === "No benefits") {
    parts.push(info("Since you reported no benefits, Questions 5–9 are skipped. Please answer Question 10 if you wish."));
  } else {
    if (mapped) {
      parts.push(card("5. How confident are you about the locations you marked?",
        radios("confidence", CONFIDENCE_CHOICES, a.location_confidence,
          v => answer("location_confidence", v)),
        textInput("Identify any uncertain locations or explain what you would correct (optional)",
          a.uncertain_locations, v => answer("uncertain_locations", v, { rerender: false }), true),
        button("Return to map to correct selections", () => navigate("Mapping"))));
    }

    if (selectedGoods.length) {
      const uses = a.good_use || (a.good_use = {});
      parts.push(card("6. What do you use the goods you obtain for?",
        caption("Answer for each good you mapped in Question 4."),
        selectedGoods.map(good => {
          const entry = uses[good] || {};
          const setUse = (field, value, rerender) => {
            uses[good] = { ...uses[good], [field]: value };
            answer("good_use", uses, { rerender });
          };
          return h("div", { class: "subfield" },
            select(good, GOODS_USES, entry.use, v => setUse("use", v, true)),
            entry.use === "Other"
              ? textInput(`Other use of ${good.toLowerCase()} (optional)`, entry.other,
                v => setUse("other", v, false))
              : null);
        })));
    }

    if (selectedBenefits.length) {
      // Drop rankings that no longer match the map, and duplicates (as app.py does).
      const ranked = validRanking(record);
      if (JSON.stringify(ranked) !== JSON.stringify(a.rank || [])) {
        a.rank = ranked;
        save();
      }
      // Keep later ranks when an earlier one changes, unless they now clash.
      const setRank = (index, value) => {
        let next = ranked.slice();
        if (!value) next = next.slice(0, index);
        else {
          next[index] = value;
          next = next.filter((item, i) => i <= index || item !== value);
        }
        answer("rank", next);
      };
      const labels = ["1st — Most important", "2nd — Next most important", "3rd — Third most important"];
      const placeholders = ["Choose your first priority (optional)",
        "Choose your second priority (optional)", "Choose your third priority (optional)"];
      const selects = [];
      for (let i = 0; i < 3; i += 1) {
        const options = selectedBenefits.filter(b => !ranked.slice(0, i).includes(b));
        if (i > ranked.length || !options.length) break;
        selects.push(select(labels[i], options, ranked[i], v => setRank(i, v), placeholders[i]));
      }
      parts.push(card("7. Which benefits matter most to you?",
        caption("Rank up to three benefits you mapped in Question 4, from most to least important."),
        selects));
    }

    parts.push(card("8. How often have you received or experienced benefits?",
      radios("frequency", FREQUENCY_CHOICES, a.benefit_frequency, v => answer("benefit_frequency", v))));

    parts.push(card(mapped
      ? "9. If the seagrass areas you marked were lost or damaged, which part of your life would be most affected?"
      : "9. If seagrass areas that benefit you were lost or damaged, which part of your life would be most affected?",
    radios("affected", AFFECTED_CHOICES, a.affected_life, v => answer("affected_life", v)),
    a.affected_life === "Other"
      ? textInput("Other impact (optional)", a.affected_life_other,
        v => answer("affected_life_other", v, { rerender: false }))
      : null));
  }

  const concerns = a.main_concerns || [];
  const toggleConcern = (choice, checked) => {
    let next;
    if (!checked) next = concerns.filter(c => c !== choice);
    else if (EXCLUSIVE_CONCERNS.includes(choice)) next = [choice];
    else next = [...concerns.filter(c => !EXCLUSIVE_CONCERNS.includes(c)), choice];
    answer("main_concerns", CONCERN_CHOICES.filter(c => next.includes(c)));
  };
  parts.push(card("10. What is your main concern about continuing to receive benefits from seagrass areas?",
    caption("Select all that apply. ‘No concern’ and ‘Unsure’ are exclusive options."),
    h("fieldset", { class: "choices" }, h("legend", { text: "Choose any that apply (optional)" }),
      CONCERN_CHOICES.map(choice => {
        const id = uid("concern");
        return h("label", { class: "choice", for: id },
          h("input", {
            type: "checkbox", id, checked: concerns.includes(choice),
            onChange: event => toggleConcern(choice, event.target.checked),
          }),
          h("span", { text: choice }));
      })),
    concerns.includes("Other")
      ? textInput("Other concern (optional)", a.main_concerns_other,
        v => answer("main_concerns_other", v, { rerender: false }))
      : null));

  if (record.completed_at) {
    parts.push(h("div", { class: "success", text: "Thank you. Your responses have been saved on this device." }),
      button("Start a new participant", startNewParticipant, "primary"));
  } else {
    parts.push(button("Finish survey", finishParticipant, "primary"));
  }
  return parts;
}

async function finishParticipant() {
  record.completed_at = new Date().toISOString();
  record.stored = true; // Keep even an all-skipped survey: completion is an answer.
  await save();
  render();
}

async function startNewParticipant() {
  await writeChain.catch(() => {});
  record = blankRecord(newParticipantId());
  await setMeta("current_participant_id", record.participant_id);
  showingData = false;
  render();
  window.scrollTo(0, 0);
}

// ---------- data & export screen ----------

async function unexportedCount(records) {
  return records.filter(r => !lastExportAt || (r.updated_at && r.updated_at > lastExportAt)).length;
}

async function updateDataBadge() {
  try {
    const count = await unexportedCount(await listParticipants());
    dataButton.dataset.count = count ? String(count) : "";
    dataButton.setAttribute("aria-label", count
      ? `Data and export, ${count} participants not yet exported` : "Data and export");
  } catch (_) { /* Badge is informational only. */ }
}

async function offlineReady() {
  if (!("caches" in window) || !navigator.serviceWorker || !navigator.serviceWorker.controller) {
    return false;
  }
  const needed = ["index.html", "js/app.js", "js/map.js", "vendor/leaflet/leaflet.js",
    "data/hexes.geojson", "data/coastline.geojson"];
  const hits = await Promise.all(needed.map(path => caches.match(new URL(path, document.baseURI).href)));
  return hits.every(Boolean);
}

async function renderData() {
  const records = (await listParticipants())
    .sort((x, y) => (y.updated_at || "").localeCompare(x.updated_at || ""));
  const completed = records.filter(r => r.completed_at).length;
  const pending = await unexportedCount(records);
  const persisted = navigator.storage && navigator.storage.persisted
    ? await navigator.storage.persisted().catch(() => false) : false;
  const ready = await offlineReady();
  const status = h("p", { class: "caption export-status", "aria-live": "polite", text: exportMessage });

  const nameField = textInput("Device name (for example “iPad-2”)", deviceName, async value => {
    deviceName = value.trim();
    await setMeta("device_name", deviceName);
    renderNav();
  });

  const exportBtn = button(`Export all data (${records.length} participants)`, async () => {
    if (!deviceName && !window.confirm("This device has no name yet. Export anyway?")) return;
    // Build files synchronously-ish so the share sheet keeps the tap's permission.
    const files = buildExportFiles(records, hexes, deviceName || "unnamed-device");
    const result = await deliverFiles(files);
    if (result === "cancelled") {
      status.textContent = "Export cancelled. Nothing was marked as exported.";
      return;
    }
    lastExportAt = new Date().toISOString();
    await setMeta("last_export_at", lastExportAt);
    exportMessage = result === "shared"
      ? "Files shared. Check they arrived (e.g. in Files or on the laptop) before deleting anything."
      : "Downloaded one .zip file with everything. Check your Downloads folder.";
    updateDataBadge();
    renderData();
  }, "primary");
  exportBtn.disabled = records.length === 0;

  main.replaceChildren(
    h("h1", { text: "Data & export" }),
    card("This device",
      nameField,
      h("ul", { class: "facts" },
        h("li", { text: `${records.length} participants saved on this device (${completed} finished).` }),
        h("li", { class: pending ? "warn" : "", text: pending
          ? `${pending} participant(s) changed since the last export.`
          : "Everything has been exported." }),
        h("li", { text: `Last export: ${lastExportAt ? new Date(lastExportAt).toLocaleString() : "never"}` }),
        h("li", { class: ready ? "" : "warn", text: ready
          ? "Ready for offline use ✓"
          : "Not ready for offline use yet: open this app once while online, then reload." }),
        h("li", { class: isStandalone() ? "" : "warn", text: isStandalone()
          ? "Opened from the Home Screen ✓"
          : "Opened in a browser tab. For field use, add to Home Screen and open it from there." }),
        h("li", { text: persisted ? "Storage protected from automatic clearing ✓"
          : "Storage protection not granted by the browser (data is still saved; export often)." }),
        h("li", { text: `App version ${APP_VERSION}` }))),
    card("Export",
      h("p", { text: "Exports every participant on this device: one combined .json file (load it in the responses viewer), four CSV tables, and a GeoJSON map layer. On an iPad, choose “Save to Files”, AirDrop, or Mail in the share sheet. On a computer, they download as one .zip file." }),
      exportBtn, status,
      caption("Exporting does not delete anything from this device. Export at the end of every field day.")),
    card("Participants on this device",
      records.length
        ? h("table", { class: "records" },
          h("thead", {}, h("tr", {}, ["ID", "Started", "Last change", "Finished", "Mapped cells"]
            .map(t => h("th", { text: t })))),
          h("tbody", {}, records.map(r => h("tr", {},
            h("td", { text: r.participant_id + (r.participant_id === record.participant_id ? " (current)" : "") }),
            h("td", { text: new Date(r.created_at).toLocaleString() }),
            h("td", { text: r.updated_at ? new Date(r.updated_at).toLocaleString() : "" }),
            h("td", { text: r.completed_at ? "Yes" : "No" }),
            h("td", { text: String(r.map.selected.length) })))))
        : caption("No participants saved yet.")),
    button("← Back to survey", () => { showingData = false; render(); }),
  );
}

// ---------- render ----------

function render() {
  if (activeMap) { activeMap.destroy(); activeMap = null; }
  const scroll = window.scrollY;
  renderNav();
  if (showingData) {
    renderData().catch(error => showBanner("error", "Could not read saved data: " + error.message));
    return;
  }
  const builders = {
    "Introduction": renderIntroduction,
    "Introductory questions": renderIntroQuestions,
    "Mapping": renderMapping,
    "Follow-up questions": renderFollowUp,
  };
  main.replaceChildren(...(builders[record.section] || renderIntroduction)());
  window.scrollTo(0, scroll);
}

// ---------- start-up ----------

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.json();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register("sw.js").catch(error =>
    showBanner("warn", "Offline mode could not be set up: " + error.message, "sw"));
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return; // First install, not an update.
    showBanner("info", "A new version of the survey was downloaded. Your saved answers are kept.",
      "update", [button("Reload now", () => window.location.reload(), "primary small")]);
  });
}

async function start() {
  dataButton.onclick = () => { showingData = true; exportMessage = ""; render(); window.scrollTo(0, 0); };
  document.getElementById("version").textContent = `v${APP_VERSION}`;
  registerServiceWorker();
  try {
    await openDb();
    [hexes, coastline] = await Promise.all([
      loadJson("data/hexes.geojson"),
      loadJson("data/coastline.geojson").catch(() => null),
    ]);
    deviceName = await getMeta("device_name", "");
    lastExportAt = await getMeta("last_export_at", null);
    const currentId = await getMeta("current_participant_id", null);
    record = (currentId && await getParticipant(currentId)) || blankRecord(currentId || newParticipantId());
    if (!currentId) await setMeta("current_participant_id", record.participant_id);
  } catch (error) {
    main.replaceChildren(h("div", { class: "banner error" },
      "The survey could not start: " + error.message));
    return;
  }

  if (!isStandalone()) {
    showBanner("warn", "For field interviews, add this app to the Home Screen (Share → Add to Home Screen) " +
      "and always open it from there. Answers saved in a browser tab are kept separately.", "standalone");
  }
  requestPersistence();
  render();
  updateDataBadge();
}

start();
