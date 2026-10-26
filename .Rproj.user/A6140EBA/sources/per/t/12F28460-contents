# pak::pak("local::PPGISr-patched/PPGISr-main")

library(PPGISr)
library(sf)

PPGISr::run_app(
  editable_map = PPGISr::duluthEditablemap,
  base_map = PPGISr::duluthBasemap,
  basemap_name = "Reference Basemap",
  mapping_categories = c(
    "Supporting",
    "Provisioning",
    "Regulating",
    "Cultural"
  ),
  mapping_colors = c(
    "coral1",
    "seagreen2",
    "royalblue1",
    "darkorange"
  )
)
