# install.packages("devtools")
# packageVersion("vctrs")

# install_github("GLISA-umich/PPGISr")
# devtools::install_github("GLISA-umich/PPGISr", dependencies = TRUE)

# install.packages("pak")
# pak::pak("ElsevierSoftwareX/SOFTX-D-23-00109")

library(PPGISr)
library(sf)

PPGISr::run_app(
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

