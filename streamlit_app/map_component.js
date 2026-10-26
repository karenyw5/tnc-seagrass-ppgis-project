/* Fast, browser-side Leaflet hexagon mapping for Streamlit Components v2.
   Each cell can hold multiple benefit categories. Only Save contacts Python.
*/
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";

function ensureCss(url) {
  if (document.querySelector('link[href="' + url + '"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  document.head.appendChild(link);
}
function ensureScript(url) {
  if (!window.__pgisScriptPromises) window.__pgisScriptPromises = {};
  if (!window.__pgisScriptPromises[url]) {
    window.__pgisScriptPromises[url] = new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = url;
      tag.onload = resolve;
      tag.onerror = () => reject(new Error("Could not load " + url));
      document.head.appendChild(tag);
    });
  }
  return window.__pgisScriptPromises[url];
}
async function loadMapLibrary() {
  ensureCss(LEAFLET_CSS);
  await ensureScript(LEAFLET_JS);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function emptySelection() { return Object.create(null); }

// A temporary browser-tab draft helps recover from sidebar navigation.
// It does not replace the database Save button.
const DRAFT_PREFIX = "seagrass_benefit_map_draft_v2:";
function readDraft(participantId) {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_PREFIX + participantId) || "null"); }
  catch (_) { return null; }
}
function writeDraft(participantId, draft) {
  try { sessionStorage.setItem(DRAFT_PREFIX + participantId, JSON.stringify(draft)); }
  catch (_) { /* Storage can be disabled by browser settings. */ }
}
function clearDraft(participantId) {
  try { sessionStorage.removeItem(DRAFT_PREFIX + participantId); }
  catch (_) { /* Ignore. */ }
}

export default function (component) {
  const { data, parentElement, setTriggerValue } = component;
  const root = parentElement.querySelector(".pgis-root");
  if (!root) return;

  // Keep Leaflet mounted across Save-triggered Python reruns.
  if (root.__pgisController) {
    if (root.__pgisController.participantId !== data.participant_id) {
      root.__pgisController.reset(data.participant_id, data.saved_snapshot);
    }
    if (data.saved_receipt) root.__pgisController.acknowledgeSave(data.saved_receipt);
    return;
  }
  if (root.__pgisInitializing) return;
  root.__pgisInitializing = true;

  const init = async () => {
    root.innerHTML = `
      <section class="pgis-panel">
        <header class="pgis-top">
          <div class="pgis-heading">
            <strong>Choose a benefit, then click the map</strong>
            <span>Click a cell again to remove the current benefit. Cells can have multiple benefits.</span>
          </div>
          <div class="pgis-top-buttons">
            <button type="button" data-role="locate" aria-label="Show my current location on the map">Show my location</button>
            <button type="button" data-role="undo">Undo</button>
            <button type="button" data-role="clear">Clear all</button>
          </div>
        </header>
        <div class="pgis-body">
          <aside class="pgis-benefit-panel" aria-label="Benefit selection">
            <div class="pgis-benefit-tabs" data-role="benefit-tabs"></div>
            <p class="pgis-small">Choose one benefit:</p>
            <div class="pgis-benefit-list" data-role="benefit-list"></div>
            <div class="pgis-other" data-role="other-wrap" hidden>
              <label for="pgis-other-value">Other benefit (optional)</label>
              <input id="pgis-other-value" type="text" maxlength="1000" data-role="other-value"
                placeholder="Describe the benefit" />
            </div>
          </aside>
          <div class="pgis-map-panel">
            <div class="pgis-map" data-role="map" aria-label="Interactive seagrass benefit mapping grid"></div>
            <div class="pgis-location-status" data-role="location-status" role="status" aria-live="polite"></div>
            <div class="pgis-legend"><span class="pgis-legend-dot active"></span> Current benefit
              <span class="pgis-legend-dot other"></span> Other mapped benefits
              <span class="pgis-legend-dot none"></span> Not mapped
            </div>
          </div>
        </div>
        <div class="pgis-bottom">
          <span class="pgis-status" data-role="status" aria-live="polite"></span>
          <button type="button" data-role="save" class="primary">Save mapped benefits</button>
        </div>
        <div class="pgis-notes">
          <label for="pgis-notes">Additional notes about the places you marked (optional)</label>
          <textarea id="pgis-notes" data-role="notes" maxlength="5000"
            placeholder="Anything else you want us to know?"></textarea>
        </div>
      </section>`;

    const $ = selector => root.querySelector(selector);
    const benefitTabs = $('[data-role="benefit-tabs"]');
    const benefitList = $('[data-role="benefit-list"]');
    const status = $('[data-role="status"]');
    const notes = $('[data-role="notes"]');
    const otherWrap = $('[data-role="other-wrap"]');
    const otherValue = $('[data-role="other-value"]');
    const locateBtn = $('[data-role="locate"]');
    const locationStatus = $('[data-role="location-status"]');
    const undoBtn = $('[data-role="undo"]');
    const clearBtn = $('[data-role="clear"]');
    const saveBtn = $('[data-role="save"]');

    const groups = data.benefit_groups;
    const groupNames = Object.keys(groups);
    const validBenefits = new Set(groupNames.flatMap(name => groups[name]));
    let participantId = data.participant_id;
    let selected = emptySelection();
    let group = groupNames[0];
    let benefit = groups[group][0];
    let unsaved = false;
    let savePending = false;
    let lastSaveRequestId = null;
    let lastAcknowledgedReceipt = null;
    const history = [];
    const layers = new Map();
    const lookup = new Map();

    const rememberDraft = () => writeDraft(participantId, {
      selected: Object.entries(selected).map(([hex_id, response]) => ({
        hex_id, categories: [...response.categories]
      })),
      notes: notes.value,
      other_benefit_text: otherValue.value,
      group, benefit
    });

    const restore = (snapshot) => {
      selected = emptySelection();
      if (snapshot && Array.isArray(snapshot.selected)) {
        for (const record of snapshot.selected) {
          if (!lookup.has(record.hex_id)) continue;
          const categories = Array.isArray(record.categories)
            ? [...new Set(record.categories.filter(cat => validBenefits.has(cat)))] : [];
          if (categories.length) selected[record.hex_id] = { categories };
        }
      }
      notes.value = snapshot && snapshot.notes ? snapshot.notes : "";
      otherValue.value = snapshot && snapshot.other_benefit_text ? snapshot.other_benefit_text : "";
    };

    const map = L.map($('[data-role="map"]'), {
      preferCanvas: true,
      zoomControl: true,
    }).setView(data.focus_areas.Sanur.center, 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    for (const [name, info] of Object.entries(data.focus_areas)) {
      L.circleMarker(info.center, {
        radius: 4, color: "#1d3340", weight: 2,
        fillColor: "#1d3340", fillOpacity: 1,
      }).bindTooltip(name).addTo(map);
    }

    // Browser geolocation is optional: ask only if the participant presses the
    // button. Coordinates remain in the browser and are NOT added to responses.
    let myLocationMarker = null;
    let myAccuracyCircle = null;
    locateBtn.onclick = () => {
      if (!navigator.geolocation) {
        locationStatus.textContent = "Location is not available in this browser.";
        return;
      }
      locateBtn.disabled = true;
      locationStatus.textContent = "Finding your location…";
      navigator.geolocation.getCurrentPosition(
        position => {
          const latlng = [position.coords.latitude, position.coords.longitude];
          if (myLocationMarker) map.removeLayer(myLocationMarker);
          if (myAccuracyCircle) map.removeLayer(myAccuracyCircle);
          myLocationMarker = L.circleMarker(latlng, {
            radius: 8,
            color: "#ffffff", weight: 2.5,
            fillColor: "#1675eb", fillOpacity: 1,
            interactive: false,
          }).bindTooltip("Your current location").addTo(map);
          const accuracy = position.coords.accuracy;
          if (Number.isFinite(accuracy) && accuracy > 0) {
            myAccuracyCircle = L.circle(latlng, {
              radius: accuracy,
              color: "#1675eb", weight: 1,
              fillColor: "#1675eb", fillOpacity: 0.12,
              interactive: false,
            }).addTo(map);
          }
          map.setView(latlng, Math.max(map.getZoom(), 13));
          locationStatus.textContent = "Current location shown (approximate).";
          locateBtn.textContent = "Update my location";
          locateBtn.disabled = false;
        },
        error => {
          const message = error.code === 1
            ? "Location permission denied. You can still use the map."
            : error.code === 2
              ? "Location is currently unavailable."
              : "Location request timed out. Try again.";
          locationStatus.textContent = message;
          locateBtn.disabled = false;
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    };

    const currentStyle = id => {
      const response = selected[id];
      if (response && response.categories.includes(benefit)) {
        return { color: "#69299b", weight: 2, fillColor: "#a77ce8", fillOpacity: 0.78 };
      }
      if (response) {
        return { color: "#146394", weight: 1.6, fillColor: "#54b1ed", fillOpacity: 0.57 };
      }
      return { color: "#5d7480", weight: 0.8, fillColor: "#ffffff", fillOpacity: 0.07 };
    };

    const refreshStyles = () => layers.forEach((layer, id) => layer.setStyle(currentStyle(id)));
    const countAssignments = () => Object.values(selected)
      .reduce((total, response) => total + response.categories.length, 0);
    const countFor = category => Object.values(selected)
      .filter(response => response.categories.includes(category)).length;

    const updateBenefitControls = () => {
      benefitTabs.replaceChildren();
      groupNames.forEach(name => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pgis-group-btn" + (name === group ? " active" : "");
        button.setAttribute("aria-pressed", String(name === group));
        button.textContent = name === "Goods and livelihoods"
          ? "Goods & livelihoods" : "Personal & community";
        button.onclick = () => {
          group = name;
          benefit = groups[name][0];
          rememberDraft();
          refreshUI();
        };
        benefitTabs.appendChild(button);
      });

      const oldScroll = benefitList.scrollTop;
      benefitList.replaceChildren();
      groups[group].forEach(option => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pgis-benefit-btn" + (option === benefit ? " active" : "");
        button.setAttribute("aria-pressed", String(option === benefit));
        const label = document.createElement("span");
        label.textContent = option;
        const count = document.createElement("small");
        count.className = "pgis-benefit-count";
        count.textContent = String(countFor(option));
        button.append(label, count);
        button.onclick = () => {
          benefit = option;
          rememberDraft();
          refreshUI();
        };
        benefitList.appendChild(button);
      });
      benefitList.scrollTop = oldScroll;
      otherWrap.hidden = benefit !== "Other";
    };

    const refreshUI = (message = "") => {
      updateBenefitControls();
      const count = Object.keys(selected).length;
      status.textContent = `${count} grid cells · ${countAssignments()} benefit assignments` +
        (savePending ? ' · Save requested' :
          unsaved ? ' · Unsaved draft' : '') +
        (message ? ` · ${message}` : '');
      undoBtn.disabled = history.length === 0;
      clearBtn.disabled = count === 0;
      saveBtn.disabled = count === 0;
      refreshStyles();
    };

    function commitChange(action) {
      const backup = clone(selected);
      action();
      if (JSON.stringify(backup) !== JSON.stringify(selected)) {
        history.push(backup);
        if (history.length > 70) history.shift();
        unsaved = true;
        savePending = false;
        rememberDraft();
      }
      refreshUI();
    }

    function toggleHex(id) {
      commitChange(() => {
        const record = selected[id];
        if (record && record.categories.includes(benefit)) {
          record.categories = record.categories.filter(cat => cat !== benefit);
          if (record.categories.length === 0) delete selected[id];
        } else if (record) {
          record.categories.push(benefit);
        } else {
          selected[id] = { categories: [benefit] };
        }
      });
    }

    for (const feature of data.hex_features.features) {
      const id = feature.properties.hex_id;
      lookup.set(id, feature);
      const layer = L.geoJSON(feature, {
        style: currentStyle(id),
        onEachFeature: (_feature, cell) => {
          cell.on('click', event => {
            L.DomEvent.stopPropagation(event);
            toggleHex(id);
          });
          cell.bindTooltip(id, {sticky: true});
        }
      });
      layer.addTo(map);
      layers.set(id, layer);
    }

    const draft = readDraft(participantId);
    restore(draft || data.saved_snapshot);
    if (draft) {
      if (groupNames.includes(draft.group)) group = draft.group;
      if (groups[group].includes(draft.benefit)) benefit = draft.benefit;
      unsaved = true;
    }
    refreshUI();

    undoBtn.onclick = () => {
      if (!history.length) return;
      selected = history.pop();
      unsaved = true;
      savePending = false;
      rememberDraft();
      refreshUI('Undid last change');
    };
    clearBtn.onclick = () => {
      if (!Object.keys(selected).length) return;
      if (!window.confirm('Clear all mapped benefits and selections?')) return;
      commitChange(() => { selected = emptySelection(); });
    };
    notes.oninput = otherValue.oninput = () => {
      unsaved = true;
      savePending = false;
      rememberDraft();
      refreshUI();
    };
    saveBtn.onclick = () => {
      if (!Object.keys(selected).length) return;
      const submission = {
        request_id: crypto.randomUUID(),
        participant_id: participantId,
        selected: Object.entries(selected).map(([hex_id, response]) => ({
          hex_id, categories: response.categories,
        })),
        notes: notes.value,
        other_benefit_text: Object.values(selected).some(
          response => response.categories.includes("Other")
        ) ? otherValue.value : "",
      };
      lastSaveRequestId = submission.request_id;
      rememberDraft();
      savePending = true;
      refreshUI();
      setTriggerValue('save', submission);
    };

    root.__pgisController = {
      get participantId() { return participantId; },
      acknowledgeSave(receipt) {
        if (!receipt || receipt === lastAcknowledgedReceipt) return;
        if (receipt === lastSaveRequestId) {
          lastAcknowledgedReceipt = receipt;
          savePending = false;
          unsaved = false;
          clearDraft(participantId);
          refreshUI('Saved to database');
        }
      },
      reset(newId, snapshot) {
        clearDraft(participantId);
        participantId = newId;
        restore(snapshot);
        history.length = 0;
        unsaved = false;
        savePending = false;
        lastSaveRequestId = null;
        lastAcknowledgedReceipt = null;
        group = groupNames[0];
        benefit = groups[group][0];
        refreshUI('Ready for next participant');
      }
    };
    setTimeout(() => map.invalidateSize(), 20);
  };

  loadMapLibrary().then(init).catch(error => {
    root.textContent = 'Map could not load: ' + error.message + '. Check internet access.';
  });
}
