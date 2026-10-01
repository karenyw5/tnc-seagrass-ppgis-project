#' Create a hexagon basemap
#'
#' Creates an sf hexagon grid from either:
#' 1) the bounding box of an existing sf object, or
#' 2) manually supplied xmin/ymin/xmax/ymax coordinates.
#'
#' @param bbox Optional sf object used to define the bounding box.
#' @param xmin Minimum x coordinate / longitude.
#' @param ymin Minimum y coordinate / latitude.
#' @param xmax Maximum x coordinate / longitude.
#' @param ymax Maximum y coordinate / latitude.
#' @param cellsize Hexagon cell size.
#' @param crs Coordinate reference system. Default is EPSG:4326.
#'
#' @return An sf object containing hexagonal polygons.
#'
#' @export
create_hex_basemap <- function(
    bbox = NULL,
    xmin = NULL,
    ymin = NULL,
    xmax = NULL,
    ymax = NULL,
    cellsize = 0.02,
    crs = 4326
) {
  
  if (!is.null(bbox)) {
    
    bounds <- sf::st_bbox(bbox)
    
  } else {
    
    if (any(vapply(
      list(xmin, ymin, xmax, ymax),
      is.null,
      logical(1)
    ))) {
      stop(
        "Provide either 'bbox' or all of xmin, ymin, xmax, and ymax."
      )
    }
    
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
  
  grid <- sf::st_make_grid(
    boundary,
    cellsize = cellsize,
    square = FALSE
  )
  
  sf::st_sf(
    hex_id = seq_along(grid),
    geometry = grid
  )
}
