/*global define*/
define([
        '../Core/defaultValue',
        '../Core/DeveloperError',
        '../Core/Math',
        '../Core/BoundingSphere',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartographic',
        '../Core/ExtentTessellator',
        '../Core/PlaneTessellator',
        '../Core/TaskProcessor',
        './TerrainProvider',
        './TileState',
        './WebMercatorTilingScheme',
        '../ThirdParty/when'
    ], function(
        defaultValue,
        DeveloperError,
        CesiumMath,
        BoundingSphere,
        Cartesian2,
        Cartesian3,
        Cartographic,
        ExtentTessellator,
        PlaneTessellator,
        TaskProcessor,
        TerrainProvider,
        TileState,
        WebMercatorTilingScheme,
        when) {
    "use strict";

    /**
     * A very simple {@link TerrainProvider} that produces geometry by tessellating an ellipsoidal
     * surface.
     *
     * @alias EllipsoidTerrainProvider
     * @constructor
     *
     * @param {TilingScheme} [tilingScheme] The tiling scheme indicating how the ellipsoidal
     * surface is broken into tiles.  If this parameter is not provided, a
     * {@link MercatorTilingScheme} on the surface of the WGS84 ellipsoid is used.
     *
     * @see TerrainProvider
     */
    function EllipsoidTerrainProvider(tilingScheme) {
        /**
         * The tiling scheme used to tile the surface.
         *
         * @type TilingScheme
         */
        this.tilingScheme = defaultValue(tilingScheme, new WebMercatorTilingScheme());
    }

    function computeDesiredGranularity(tilingScheme, tile) {
        var ellipsoid = tilingScheme.ellipsoid;
        var level = tile.level;

        // The more vertices we use to tessellate the extent, the less geometric error
        // in the tile.  We only need to use enough vertices to be at or below the
        // geometric error expected for this level.
        var maxErrorMeters = tilingScheme.getLevelMaximumGeometricError(level);

        // Convert the max error in meters to radians at the equator.
        // TODO: we should take the latitude into account to avoid over-tessellation near the poles.
        var maxErrorRadians = maxErrorMeters / ellipsoid.getRadii().x;

        return maxErrorRadians * 10;
    }

    EllipsoidTerrainProvider.prototype.requestTileGeometry = function(tile) {
        tile.state = TileState.RECEIVED;
    };

    var taskProcessor = new TaskProcessor('createVerticesFromExtent');

    EllipsoidTerrainProvider.prototype.transformGeometry = function(context, tile) {
        var tilingScheme = this.tilingScheme;
        var ellipsoid = tilingScheme.ellipsoid;
        var extent = tile.extent;

        var granularity = computeDesiredGranularity(tilingScheme, tile);

        tile.center = this.tilingScheme.ellipsoid.cartographicToCartesian(tile.extent.getCenter());

        var width = Math.ceil((extent.east - extent.west) / granularity) + 1;
        var height = Math.ceil((extent.north - extent.south) / granularity) + 1;

        var verticesPromise = taskProcessor.scheduleTask({
            extent : extent,
            altitude : 0,
            width : width,
            height : height,
            relativeToCenter : tile.center,
            radiiSquared : ellipsoid.getRadiiSquared()
        });

        if (typeof verticesPromise === 'undefined') {
            //postponed
            tile.state = TileState.RECEIVED;
            return;
        }

        when(verticesPromise, function(result) {
            tile.geometry = undefined;
            tile.transformedGeometry = {
                vertices : result.vertices,
                indices : TerrainProvider.getRegularGridIndices(width, height)
            };
            tile.state = TileState.TRANSFORMED;
        }, function(e) {
            /*global console*/
            console.error('failed to load transform geometry: ' + e);
        });
    };

    EllipsoidTerrainProvider.prototype.createResources = function(context, tile) {
        var buffers = tile.transformedGeometry;
        tile.transformedGeometry = undefined;
        TerrainProvider.createTileEllipsoidGeometryFromBuffers(context, tile, buffers);
        tile.maxHeight = 0;
        tile._boundingSphere3D = BoundingSphere.fromFlatArray(buffers.vertices, tile.center, 5);

        var ellipsoid = this.tilingScheme.ellipsoid;
        tile.southwestCornerCartesian = ellipsoid.cartographicToCartesian(tile.extent.getSouthwest());
        tile.southeastCornerCartesian = ellipsoid.cartographicToCartesian(tile.extent.getSoutheast());
        tile.northeastCornerCartesian = ellipsoid.cartographicToCartesian(tile.extent.getNortheast());
        tile.northwestCornerCartesian = ellipsoid.cartographicToCartesian(tile.extent.getNorthwest());

        var scratch = new Cartesian3();
        tile.westNormal = Cartesian3.UNIT_Z.cross(tile.southwestCornerCartesian.negate(scratch), scratch).normalize();
        tile.eastNormal = tile.northeastCornerCartesian.negate(scratch).cross(Cartesian3.UNIT_Z, scratch).normalize();
        tile.southNormal = ellipsoid.geodeticSurfaceNormal(tile.southeastCornerCartesian).cross(tile.southwestCornerCartesian.subtract(tile.southeastCornerCartesian, scratch)).normalize();
        tile.northNormal = ellipsoid.geodeticSurfaceNormal(tile.northwestCornerCartesian).cross(tile.northeastCornerCartesian.subtract(tile.northwestCornerCartesian, scratch)).normalize();

        tile.state = TileState.READY;
    };

    /**
     * Populates a {@link Tile} with plane-mapped surface geometry from this
     * tile provider.
     *
     * @memberof EllipsoidTerrainProvider
     *
     * @param {Context} context The rendered context to use to create renderer resources.
     * @param {Tile} tile The tile to populate with surface geometry.
     * @param {Projection} projection The map projection to use.
     * @returns {Boolean|Promise} A boolean value indicating whether the tile was successfully
     * populated with geometry, or a promise for such a value in the future.
     */
    EllipsoidTerrainProvider.prototype.createTilePlaneGeometry = function(context, tile, projection) {
        var tilingScheme = this.tilingScheme;
        var ellipsoid = tilingScheme.ellipsoid;
        var extent = tile.extent;

        var granularity = computeDesiredGranularity(tilingScheme, tile);

        var vertices = [];
        var width = tile.extent.east - tile.extent.west;
        var height = tile.extent.north - tile.extent.south;
        var lonScalar = 1.0 / width;
        var latScalar = 1.0 / height;

        var center = tile.get3DBoundingSphere().center;
        var projectedRTC = tile.get2DBoundingSphere(projection).center.clone();

        var mesh = PlaneTessellator.compute({
            resolution : {
                x : Math.max(Math.ceil(width / granularity), 2.0),
                y : Math.max(Math.ceil(height / granularity), 2.0)
            },
            onInterpolation : function(time) {
                var lonLat = new Cartographic(CesiumMath.lerp(extent.west, extent.east, time.x),
                                              CesiumMath.lerp(extent.south, extent.north, time.y));

                var p = ellipsoid.cartographicToCartesian(lonLat).subtract(center);
                vertices.push(p.x, p.y, p.z);

                var u = (lonLat.longitude - extent.west) * lonScalar;
                var v = (lonLat.latitude - extent.south) * latScalar;
                vertices.push(u, v);

                // TODO: This will not work if the projection's ellipsoid is different
                // than the central body's ellipsoid.  Throw an exception?
                var projectedLonLat = projection.project(lonLat).subtract(projectedRTC);
                vertices.push(projectedLonLat.x, projectedLonLat.y);
            }
        });

        TerrainProvider.createTilePlaneGeometryFromBuffers(context, tile, {
            vertices: vertices,
            indices: mesh.indexLists[0].values
        });


        tile._drawUniforms = {
            u_center3D : function() {
                return center;
            },
            u_center2D : function() {
                return (projectedRTC) ? projectedRTC.getXY() : Cartesian2.ZERO;
            },
            u_modifiedModelView : function() {
                return tile.modelView;
            }
        };

        return true;
    };

    return EllipsoidTerrainProvider;
});