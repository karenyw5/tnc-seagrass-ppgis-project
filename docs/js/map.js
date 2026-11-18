/* Leaflet hexagon benefit mapping (adapted from streamlit_app/map_component.js).
   Each cell can hold multiple benefit categories. Every change is passed to
   onChange, which saves it on the device; there is no separate Save button. */

/* global L */

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function emptySelection() { return Object.create(null); }

export function createBenefitMap(root, options) {
  const { benefitGroups, focusAreas, hexes, coastline, snapshot, onChange } = options;

  root.innerHTML = `
    <section class="pgis-panel">
      <header class="pgis-top">
        <div class="pgis-heading">
          <strong>Choose a benefit, then tap the map</strong>
          <span>Tap a cell again to remove the current benefit. Cells can have multiple benefits.</span>
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

  const groups = benefitGroups;
  const groupNames = Object.keys(groups);
  const validBenefits = new Set(groupNames.flatMap(name => groups[name]));
  let selected = emptySelection();
  let group = groupNames[0];
  let benefit = groups[group][0];
  let saveState = "";
  let saveSequence = 0;
  const history = [];
  const layers = new Map();
  const lookup = new Map();
  for (const feature of hexes.features) lookup.set(feature.properties.hex_id, feature);

  const currentSnapshot = () => ({
    selected: Object.entries(selected).map(([hex_id, response]) => ({
      hex_id, categories: [...response.categories],
    })),
    notes: notes.value,
    // Like the Streamlit app, keep "Other" text only while a cell uses "Other".
    other_benefit_text: Object.values(selected).some(
      response => response.categories.includes("Other")
    ) ? otherValue.value : "",
  });

  const restore = (saved) => {
    selected = emptySelection();
    if (saved && Array.isArray(saved.selected)) {
      for (const record of saved.selected) {
        if (!lookup.has(record.hex_id)) continue;
        const categories = Array.isArray(record.categories)
          ? [...new Set(record.categories.filter(cat => validBenefits.has(cat)))] : [];
        if (categories.length) selected[record.hex_id] = { categories };
      }
    }
    notes.value = saved && saved.notes ? saved.notes : "";
    otherValue.value = saved && saved.other_benefit_text ? saved.other_benefit_text : "";
  };

  // Save after every change. A sequence number keeps an older, slower save
  // from overwriting the status of a newer one.
  const persist = () => {
    const sequence = ++saveSequence;
    saveState = "Saving…";
    refreshStatus();
    Promise.resolve(onChange(currentSnapshot())).then(
      () => { if (sequence === saveSequence) { saveState = "Saved on this device ✓"; refreshStatus(); } },
      error => {
        if (sequence === saveSequence) {
          saveState = "NOT SAVED: " + (error && error.message ? error.message : error);
          refreshStatus();
        }
      },
    );
  };

  const center = focusAreas.Sanur.center;
  const map = L.map($('[data-role="map"]'), {
    preferCanvas: true,
    zoomControl: true,
    // Stay inside the area covered by data/coastline.geojson.
    minZoom: 11,
    maxBounds: L.latLngBounds([-8.82, 115.15], [-8.44, 115.62]),
    maxBoundsViscosity: 0.8,
  }).setView(center, 13);

  // Offline basemap: bundled OSM land polygons, drawn *under* the online
  // street tiles. Online, tiles cover it; offline, tiles fail and the land shows.
  map.createPane("land");
  map.getPane("land").style.zIndex = 150;
  if (coastline) {
    L.geoJSON(coastline, {
      pane: "land",
      interactive: false,
      style: { color: "#7f8f7a", weight: 1, fillColor: "#ede8d8", fillOpacity: 1 },
    }).addTo(map);
  }
  let tileErrors = 0;
  const tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  // Leaflet fires "load" even when tiles failed, so only clear the notice
  // after a round of tile loading with no errors.
  tiles.on("loading", () => { tileErrors = 0; });
  tiles.on("tileerror", () => {
    tileErrors += 1;
    if (!locationStatus.dataset.busy) {
      locationStatus.textContent = "Offline: street map unavailable, showing coastline only.";
    }
  });
  tiles.on("load", () => {
    if (!tileErrors && !locationStatus.dataset.busy &&
        locationStatus.textContent.startsWith("Offline")) {
      locationStatus.textContent = "";
    }
  });

  for (const [name, info] of Object.entries(focusAreas)) {
    L.circleMarker(info.center, {
      radius: 4, color: "#1d3340", weight: 2,
      fillColor: "#1d3340", fillOpacity: 1, interactive: false,
    }).bindTooltip(name, { permanent: true, direction: "right", className: "pgis-place-label" })
      .addTo(map);
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
    locationStatus.dataset.busy = "1";
    locationStatus.textContent = "Finding your location…";
    const done = message => {
      locationStatus.textContent = message;
      delete locationStatus.dataset.busy;
      locateBtn.disabled = false;
    };
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
        locateBtn.textContent = "Update my location";
        done("Current location shown (approximate).");
      },
      error => {
        done(error.code === 1
          ? "Location permission denied. You can still use the map."
          : error.code === 2
            ? "Location is currently unavailable (devices without GPS often cannot find it offline)."
            : "Location request timed out. Try again.");
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
        refreshUI();
      };
      benefitList.appendChild(button);
    });
    benefitList.scrollTop = oldScroll;
    otherWrap.hidden = benefit !== "Other";
  };

  function refreshStatus(message = "") {
    const count = Object.keys(selected).length;
    status.textContent = `${count} grid cells · ${countAssignments()} benefit assignments` +
      (saveState ? ` · ${saveState}` : "") +
      (message ? ` · ${message}` : "");
    status.classList.toggle("error", saveState.startsWith("NOT SAVED"));
  }

  function refreshUI(message = "") {
    updateBenefitControls();
    refreshStatus(message);
    undoBtn.disabled = history.length === 0;
    clearBtn.disabled = Object.keys(selected).length === 0;
    refreshStyles();
  }

  function commitChange(action) {
    const backup = clone(selected);
    action();
    if (JSON.stringify(backup) !== JSON.stringify(selected)) {
      history.push(backup);
      if (history.length > 70) history.shift();
      persist();
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

  for (const feature of hexes.features) {
    const id = feature.properties.hex_id;
    const layer = L.geoJSON(feature, {
      style: currentStyle(id),
      onEachFeature: (_feature, cell) => {
        cell.on("click", event => {
          L.DomEvent.stopPropagation(event);
          toggleHex(id);
        });
      },
    });
    layer.addTo(map);
    layers.set(id, layer);
  }

  restore(snapshot);
  refreshUI();

  undoBtn.onclick = () => {
    if (!history.length) return;
    selected = history.pop();
    persist();
    refreshUI("Undid last change");
  };
  clearBtn.onclick = () => {
    if (!Object.keys(selected).length) return;
    if (!window.confirm("Clear all mapped benefits and selections?")) return;
    commitChange(() => { selected = emptySelection(); });
  };
  notes.oninput = otherValue.oninput = () => {
    persist();
    refreshStatus();
  };

  // The map container may get its final size only after layout settles.
  setTimeout(() => map.invalidateSize(), 20);

  return {
    destroy() { map.remove(); root.replaceChildren(); },
  };
}
