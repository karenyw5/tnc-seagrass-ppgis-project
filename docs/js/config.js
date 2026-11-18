/* Survey wording and choices. Keep in sync with streamlit_app/app.py so exports
   from this web app and the Streamlit SQLite database use the same values. */

// Bump this (and CACHE_VERSION in sw.js) whenever any file in docs/ changes.
export const APP_VERSION = "1.0.0";

// These are approximate demonstration centers, not verified study boundaries.
export const FOCUS_AREAS = {
  "Sanur": { center: [-8.707, 115.263] },
  "Padang Bai": { center: [-8.531, 115.509] },
  "Nusa Lembongan": { center: [-8.680, 115.455] },
};

export const BENEFIT_GROUPS = {
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
};
export const ALL_BENEFITS = Object.values(BENEFIT_GROUPS).flat();
export const GOODS = BENEFIT_GROUPS["Goods and livelihoods"];

export const OCCUPATIONS = [
  "Fishing or seafood harvesting",
  "Aquaculture",
  "Tourism or recreation",
  "Coastal or marine conservation",
  "Business or trade",
  "Other",
  "Prefer not to answer",
];
export const FAMILIARITY_CHOICES = [
  "I know what seagrass is and can recognize it.",
  "I have heard of seagrass but would not recognize it.",
  "I have never heard of seagrass.",
  "I am not sure.",
];
export const MAP_CHOICES = [
  "I want to map my benefits",
  "Cannot locate",
  "Prefer not to share",
  "No benefits",
  "Unsure",
];
export const CONFIDENCE_CHOICES = ["Confident", "Locations are approximate", "Unsure"];
export const GOODS_USES = ["Personal or household use", "Sale", "Both", "Other"];
export const FREQUENCY_CHOICES = [
  "Daily or almost daily", "Weekly", "Monthly", "A few times", "Once",
  "Not in the past 12 months", "Unsure",
];
export const AFFECTED_CHOICES = [
  "Food for my household", "Income", "Relaxation or enjoyment",
  "Connections with family, friends, or community",
  "Traditions or sense of belonging", "Other", "None", "Unsure",
];
export const CONCERN_CHOICES = [
  "Declining fish or seafood availability", "Pollution or declining water quality",
  "Coastal development", "Damage to seagrass habitats",
  "Restricted access to important areas", "Climate-related changes",
  "Other", "No concern", "Unsure",
];
export const EXCLUSIVE_CONCERNS = ["No concern", "Unsure"];
export const SECTIONS = ["Introduction", "Introductory questions", "Mapping", "Follow-up questions"];

export const PHOTOS = [
  { src: "photos/seagrass-wakatobi.jpg", caption: "Christian Gloor, Wakatobi, Indonesia" },
  { src: "photos/seagrass-west-java.jpg", caption: "Ghofar Ismail Putra, West Java, Indonesia" },
];
