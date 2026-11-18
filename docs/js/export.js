/* Turn on-device participant documents into the same four tables as the
   Streamlit SQLite database (plus device_name), and hand them to the user as
   files via the share sheet (iPad/Android) or downloads (desktop). */

import { ALL_BENEFITS, GOODS, APP_VERSION } from "./config.js";

export const TABLE_COLUMNS = {
  participant_surveys: [
    "participant_id", "occupation", "occupation_other", "familiarity",
    "receives_benefits", "concerns", "completed_at", "updated_at",
    "map_status", "location_confidence", "uncertain_locations",
    "goods_uses_json", "top_benefits_json", "benefit_frequency",
    "affected_life", "affected_life_other", "main_concerns_json", "main_concerns_other",
    "device_name", "created_at",
  ],
  mapped_hexes: [
    "participant_id", "hex_id", "focus_area", "geometry_geojson", "notes", "saved_at",
    "device_name",
  ],
  hex_values: ["participant_id", "hex_id", "value_category", "device_name"],
  participant_submissions: [
    "participant_id", "notes", "saved_at", "other_benefit_text", "device_name",
  ],
};

/** Distinct mapped benefits, in questionnaire order. */
export function mappedBenefits(record) {
  const values = new Set(
    (record.map.selected || []).flatMap(item => item.categories || [])
  );
  return ALL_BENEFITS.filter(choice => values.has(choice));
}

/** Ranked choices that are still valid, stopping at the first gap (as app.py does). */
export function validRanking(record) {
  const selected = mappedBenefits(record);
  const ranked = [];
  for (const value of record.answers.rank || []) {
    if (value && selected.includes(value) && !ranked.includes(value)) ranked.push(value);
    else break;
  }
  return ranked;
}

function surveyRow(record) {
  const a = record.answers;
  const selectedGoods = GOODS.filter(good => mappedBenefits(record).includes(good));
  const uses = {};
  for (const good of selectedGoods) {
    const entry = (a.good_use || {})[good];
    if (entry && entry.use) {
      uses[good] = { use: entry.use, other: entry.use === "Other" ? entry.other || "" : "" };
    }
  }
  const concerns = a.main_concerns || [];
  return {
    participant_id: record.participant_id,
    occupation: a.occupation ?? null,
    occupation_other: a.occupation === "Other" ? a.occupation_other || "" : "",
    familiarity: a.familiarity ?? null,
    receives_benefits: a.benefits ?? null,
    concerns: "",
    completed_at: record.completed_at,
    updated_at: record.updated_at,
    map_status: a.map_status ?? null,
    location_confidence: a.location_confidence ?? null,
    uncertain_locations: a.uncertain_locations || "",
    goods_uses_json: JSON.stringify(uses),
    top_benefits_json: JSON.stringify(validRanking(record)),
    benefit_frequency: a.benefit_frequency ?? null,
    affected_life: a.affected_life ?? null,
    affected_life_other: a.affected_life === "Other" ? a.affected_life_other || "" : "",
    main_concerns_json: JSON.stringify(concerns),
    main_concerns_other: concerns.includes("Other") ? a.main_concerns_other || "" : "",
    device_name: record.device_name,
    created_at: record.created_at,
  };
}

export function buildTables(records, hexes) {
  const known = new Map(hexes.features.map(f => [f.properties.hex_id, f]));
  const tables = {
    participant_surveys: [], mapped_hexes: [], hex_values: [], participant_submissions: [],
  };
  for (const record of records) {
    tables.participant_surveys.push(surveyRow(record));
    const map = record.map || {};
    const selected = (map.selected || []).filter(item => known.has(item.hex_id));
    for (const item of selected) {
      const feature = known.get(item.hex_id);
      tables.mapped_hexes.push({
        participant_id: record.participant_id,
        hex_id: item.hex_id,
        focus_area: feature.properties.focus_area,
        geometry_geojson: JSON.stringify(feature.geometry),
        notes: "",
        saved_at: map.saved_at,
        device_name: record.device_name,
      });
      for (const category of [...new Set(item.categories)].sort()) {
        tables.hex_values.push({
          participant_id: record.participant_id, hex_id: item.hex_id,
          value_category: category, device_name: record.device_name,
        });
      }
    }
    if (selected.length || map.notes) {
      tables.participant_submissions.push({
        participant_id: record.participant_id,
        notes: map.notes || "",
        saved_at: map.saved_at,
        other_benefit_text: map.other_benefit_text || "",
        device_name: record.device_name,
      });
    }
  }
  return tables;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map(col => csvCell(row[col])).join(","));
  // The byte-order mark lets Excel open the file as UTF-8.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function toGeojson(tables) {
  const benefits = new Map();
  for (const row of tables.hex_values) {
    const key = row.participant_id + "|" + row.hex_id;
    if (!benefits.has(key)) benefits.set(key, []);
    benefits.get(key).push(row.value_category);
  }
  return JSON.stringify({
    type: "FeatureCollection",
    features: tables.mapped_hexes.map(row => ({
      type: "Feature",
      geometry: JSON.parse(row.geometry_geojson),
      properties: {
        participant_id: row.participant_id,
        hex_id: row.hex_id,
        focus_area: row.focus_area,
        device_name: row.device_name,
        benefits: benefits.get(row.participant_id + "|" + row.hex_id) || [],
      },
    })),
  }, null, 2);
}

function safeName(text) {
  return (text || "device").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "device";
}

function stamp(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** Build every export file. The .json bundle is what the responses viewer reads. */
export function buildExportFiles(records, hexes, deviceName, now = new Date()) {
  const tables = buildTables(records, hexes);
  const prefix = `seagrass_${safeName(deviceName)}_${stamp(now)}`;
  const files = [];
  const bundle = {
    format: "seagrass-survey-export",
    format_version: 1,
    app_version: APP_VERSION,
    device_name: deviceName,
    exported_at: now.toISOString(),
    tables,
  };
  files.push(new File([JSON.stringify(bundle, null, 1)], `${prefix}_all.json`,
    { type: "application/json" }));
  for (const [name, columns] of Object.entries(TABLE_COLUMNS)) {
    files.push(new File([toCsv(tables[name], columns)], `${prefix}_${name}.csv`,
      { type: "text/csv" }));
  }
  files.push(new File([toGeojson(tables)], `${prefix}_mapped_benefits.geojson`,
    { type: "application/geo+json" }));
  return files;
}

// ---------- minimal .zip writer (stored, no compression) ----------
// Safari keeps only the last of several quick downloads, so the download
// fallback delivers one .zip instead of six files.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function zipFiles(files, name, now = new Date()) {
  const encoder = new TextEncoder();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    const fileName = encoder.encode(file.name);
    const crc = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8 names
    header.setUint16(8, 0, true); // stored
    header.setUint16(10, dosTime, true);
    header.setUint16(12, dosDate, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, fileName.length, true);
    parts.push(header, fileName, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, fileName.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new File([...parts, ...central, end], name, { type: "application/zip" });
}

function download(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Share or download the files. Resolves to "shared", "downloaded" or
 * "cancelled". Must be called directly from a tap/click handler.
 */
export async function deliverFiles(files) {
  if (navigator.canShare && navigator.share) {
    // Some share targets reject .geojson/.csv types; fall back to fewer files.
    for (const set of [files, files.filter(f => !f.name.endsWith(".geojson")), [files[0]]]) {
      if (!navigator.canShare({ files: set })) continue;
      try {
        await navigator.share({ files: set, title: "Seagrass survey export" });
        return "shared";
      } catch (error) {
        if (error && error.name === "AbortError") return "cancelled";
        break; // Sharing failed for another reason; download instead.
      }
    }
  }
  download(await zipFiles(files, files[0].name.replace(/_all\.json$/, ".zip")));
  return "downloaded";
}
