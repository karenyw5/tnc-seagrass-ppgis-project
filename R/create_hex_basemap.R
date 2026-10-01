create_hex_basemap <- function(
    bbox = NULL,
    xmin = NULL,
    ymin = NULL,
    xmax = NULL,
    ymax = NULL,
    cellsize = 0.05,
    crs = 4326
) {
  
  if (!is.null(bbox)) {
    bounds <- sf::st_bbox(bbox)
  } else {
    bounds <- sf::st_bbox(
      c(
        xmin = xmin,
        ymin = ymin,
        xmax = xmax,
        ymax = ymax
      ),
      crs = sf::st_crs(crs)
    )
  }
  
  boundary <- sf::st_as_sfc(bounds)
  
  hexes <- sf::st_make_grid(
    boundary,
    cellsize = cellsize,
    square = FALSE
  )
  
  hexes <- sf::st_sf(
    hex_id = seq_along(hexes),
    geometry = hexes
  )
  
  return(hexes)
}

