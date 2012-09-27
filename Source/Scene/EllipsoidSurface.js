/*global define*/
define([
        '../Core/combine',
        '../Core/defaultValue',
        '../Core/destroyObject',
        '../Core/BoundingSphere',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/DeveloperError',
        '../Core/Ellipsoid',
        '../Core/EllipsoidalOccluder',
        '../Core/Intersect',
        '../Core/Math',
        '../Core/Matrix4',
        '../Core/Occluder',
        '../Core/PrimitiveType',
        '../Core/BoundingRectangle',
        '../Core/CubeMapEllipsoidTessellator',
        '../Core/WebMercatorProjection',
        '../Core/MeshFilters',
        '../Core/Queue',
        '../Renderer/Command',
        './GeographicTilingScheme',
        './ImageryLayerCollection',
        './ImageryState',
        './SceneMode',
        './TerrainProvider',
        './TileState',
        './TileImagery',
        './TileLoadQueue',
        './TileReplacementQueue',
        './ViewportQuad',
        '../ThirdParty/when'
    ], function(
        combine,
        defaultValue,
        destroyObject,
        BoundingSphere,
        Cartesian2,
        Cartesian3,
        Cartesian4,
        DeveloperError,
        Ellipsoid,
        EllipsoidalOccluder,
        Intersect,
        CesiumMath,
        Matrix4,
        Occluder,
        PrimitiveType,
        BoundingRectangle,
        CubeMapEllipsoidTessellator,
        WebMercatorProjection,
        MeshFilters,
        Queue,
        Command,
        GeographicTilingScheme,
        ImageryLayerCollection,
        ImageryState,
        SceneMode,
        TerrainProvider,
        TileState,
        TileImagery,
        TileLoadQueue,
        TileReplacementQueue,
        ViewportQuad,
        when) {
    "use strict";

    /**
     * @param {TerrainProvider} description.terrainProvider
     * @param {ImageryLayerCollection} description.imageryLayerCollection
     * @param {Number} [description.maxScreenSpaceError=2]
     */
    var EllipsoidSurface = function(description) {
        if (typeof description.terrainProvider === 'undefined') {
            throw new DeveloperError('description.terrainProvider is required.');
        }
        if (typeof description.imageryLayerCollection === 'undefined') {
            throw new DeveloperError('description.imageryLayerCollection is required.');
        }

        this.terrainProvider = description.terrainProvider;
        this._imageryLayerCollection = description.imageryLayerCollection;
        this.maxScreenSpaceError = defaultValue(description.maxScreenSpaceError, 2);

        this._imageryLayerCollection.layerAdded.addEventListener(EllipsoidSurface.prototype._onLayerAdded, this);
        this._imageryLayerCollection.layerRemoved.addEventListener(EllipsoidSurface.prototype._onLayerRemoved, this);
        this._imageryLayerCollection.layerMoved.addEventListener(EllipsoidSurface.prototype._onLayerMoved, this);

        /**
         * The offset, relative to the bottom left corner of the viewport,
         * where the logo for terrain and imagery providers will be drawn.
         *
         * @type {Cartesian2}
         */
        this.logoOffset = Cartesian2.ZERO;
        this._logos = [];
        this._logoQuad = undefined;

        this._levelZeroTiles = undefined;
        this._tilesToRenderByTextureCount = [];
        this._tileCommands = [];
        this._tileCommandUniformMaps = [];
        this._tileLoadQueue = new TileLoadQueue();
        this._tileReplacementQueue = new TileReplacementQueue();
        this._tilingScheme = undefined;
        this._occluder = undefined;
        this._ellipsoidalOccluder = undefined;
        this._tileTraversalQueue = new Queue();

        this._debug = {
            boundingSphereTile : undefined,
            boundingSphereVA : undefined,

            maxDepth : 0,
            tilesVisited : 0,
            tilesCulled : 0,
            tilesRendered : 0,
            texturesRendered : 0,

            lastMaxDepth : -1,
            lastTilesVisited : -1,
            lastTilesCulled : -1,
            lastTilesRendered : -1,
            lastTexturesRendered : -1,

            suspendLodUpdate : false
        };

        var that = this;
        when(this.terrainProvider.tilingScheme, function(tilingScheme) {
            that._tilingScheme = tilingScheme;
            that._levelZeroTiles = tilingScheme.createLevelZeroTiles();
            that._occluder = new Occluder(new BoundingSphere(Cartesian3.ZERO, that.terrainProvider.tilingScheme.ellipsoid.getMinimumRadius()), Cartesian3.ZERO);
            that._ellipsoidalOccluder = new EllipsoidalOccluder(that.terrainProvider.tilingScheme.ellipsoid, Cartesian3.ZERO);
        }, function(e) {
            /*global console*/
            console.error('failed to load tiling scheme: ' + e);
        });
    };

    EllipsoidSurface.prototype._onLayerAdded = function(layer, index) {
        if (typeof this._levelZeroTiles === 'undefined') {
            return;
        }

        var newNextLayer = this._imageryLayerCollection.get(index + 1);

        // create TileImagerys for this layer for all previously loaded tiles
        var tile = this._tileReplacementQueue.head;
        while (typeof tile !== 'undefined') {
            if (layer.createTileImagerySkeletons(tile, this.terrainProvider)) {
                tile.doneLoading = false;
            }

            if (typeof newNextLayer !== 'undefined') {
                moveTileImageryObjects(tile.imagery, layer, newNextLayer);
            }
            tile = tile.replacementNext;
        }
    };

    EllipsoidSurface.prototype._onLayerRemoved = function(layer, index) {
        if (typeof this._levelZeroTiles === 'undefined') {
            return;
        }

        // destroy TileImagerys for this layer for all previously loaded tiles
        var tile = this._tileReplacementQueue.head;
        while (typeof tile !== 'undefined') {
            var tileImageryCollection = tile.imagery;
            var startIndex = -1;
            var numDestroyed = 0;
            for ( var i = 0, len = tileImageryCollection.length; i < len; ++i) {
                var imagery = tileImageryCollection[i].imagery;
                if (imagery.imageryLayer === layer) {
                    if (startIndex === -1) {
                        startIndex = i;
                    }

                    imagery.releaseReference();
                    ++numDestroyed;
                } else if (startIndex !== -1) {
                    // iterated past the section of TileImagerys belonging to this layer, no need to continue.
                    break;
                }
            }

            if (startIndex !== -1) {
                tileImageryCollection.splice(startIndex, numDestroyed);
            }
            // If the tile has no imagery left, mark it as non-renderable.
            if (tileImageryCollection.length === 0) {
                tile.renderable = false;
            }
            tile = tile.replacementNext;
        }
    };

    EllipsoidSurface.prototype._onLayerMoved = function(layer, newIndex, oldIndex) {
        if (typeof this._levelZeroTiles === 'undefined') {
            return;
        }

        var newNextLayer = this._imageryLayerCollection.get(newIndex + 1);
        var tile = this._tileReplacementQueue.head;
        while (typeof tile !== 'undefined') {
            moveTileImageryObjects(tile.imagery, layer, newNextLayer);
            tile = tile.replacementNext;
        }
    };

    EllipsoidSurface.prototype.update = function(context, frameState, commandList, colorCommandList, centralBodyUniformMap, shaderSet, renderState, mode, projection) {
        selectTilesForRendering(this, context, frameState);
        processTileLoadQueue(this, context, frameState);

        if (!this._debug.suspendLodUpdate) {
            var imageryLayerCollection = this._imageryLayerCollection;
            for (var i = 0, len = imageryLayerCollection.getLength(); i < len; i++) {
                imageryLayerCollection.get(i).updateTiles(context, frameState, this._tilesToRenderByTextureCount);
            }
        }

        createRenderCommandsForSelectedTiles(this, context, frameState, shaderSet, mode, projection, centralBodyUniformMap, colorCommandList, renderState);
        debugCreateCommandsForTileBoundingSphere(this, context, frameState, centralBodyUniformMap, shaderSet, renderState, colorCommandList);
        updateLogos(this, context, frameState, commandList);
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <br /><br />
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     *
     * @memberof EllipsoidSurface
     *
     * @return {Boolean} True if this object was destroyed; otherwise, false.
     *
     * @see EllipsoidSurface#destroy
     */
    EllipsoidSurface.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <br /><br />
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     *
     * @memberof EllipsoidSurface
     *
     * @return {undefined}
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     *
     * @see EllipsoidSurface#isDestroyed
     */
    EllipsoidSurface.prototype.destroy = function() {
        when(this.levelZeroTiles, function(levelZeroTiles) {
            for (var i = 0; i < levelZeroTiles.length; ++i) {
                levelZeroTiles[i].destroy();
            }
        });
        return destroyObject(this);
    };

    var logoData = {
        logos : undefined,
        logoIndex : 0,
        rebuildLogo : false,
        totalLogoWidth : 0,
        totalLogoHeight : 0
    };

    function updateLogos(surface, context, frameState, commandList) {
        logoData.logos = surface._logos;
        logoData.logoIndex = 0;
        logoData.rebuildLogo = false;
        logoData.totalLogoWidth = 0;
        logoData.totalLogoHeight = 0;

        checkLogo(logoData, surface.terrainProvider);

        var imageryLayerCollection = surface._imageryLayerCollection;
        for ( var i = 0, len = imageryLayerCollection.getLength(); i < len; ++i) {
            var layer = imageryLayerCollection.get(i);
            checkLogo(logoData, layer.imageryProvider);
        }

        if (logoData.rebuildLogo) {
            var width = logoData.totalLogoWidth;
            var height = logoData.totalLogoHeight;
            var logoRectangle = new BoundingRectangle(surface.logoOffset.x, surface.logoOffset.y, width, height);
            if (typeof surface._logoQuad === 'undefined') {
                surface._logoQuad = new ViewportQuad(logoRectangle);
                surface._logoQuad.enableBlending = true;
            } else {
                surface._logoQuad.setRectangle(logoRectangle);
            }

            var texture = surface._logoQuad.getTexture();
            if (typeof texture === 'undefined' || texture.getWidth() !== width || texture.getHeight() !== height) {

                if (width === 0 || height === 0) {
                    if (typeof texture !== 'undefined') {
                        surface._logoQuad.destroy();
                        surface._logoQuad = undefined;
                    }
                } else {
                    texture = context.createTexture2D({
                        width : width,
                        height : height
                    });
                    surface._logoQuad.setTexture(texture);
                }
            }

            var heightOffset = 0;
            for (i = 0, len = logoData.logos.length; i < len; i++) {
                var logo = logoData.logos[i];
                if (typeof logo !== 'undefined') {
                    texture.copyFrom(logo, 0, heightOffset);
                    heightOffset += logo.height + 2;
                }
            }
        }

        if (typeof surface._logoQuad !== 'undefined') {
            surface._logoQuad.update(context, frameState, commandList);
        }
    }

    function checkLogo(logoData, logoSource) {
        var logo;
        if (typeof logoSource.getLogo === 'function') {
            logo = logoSource.getLogo();
        } else {
            logo = undefined;
        }

        if (logoData.logos[logoData.logoIndex] !== logo) {
            logoData.rebuildLogo = true;
            logoData.logos[logoData.logoIndex] = logo;
        }
        logoData.logoIndex++;

        if (typeof logo !== 'undefined') {
            logoData.totalLogoWidth = Math.max(logoData.totalLogoWidth, logo.width);
            logoData.totalLogoHeight += logo.height + 2;
        }
    }

    function addTileToRenderList(surface, tile) {
        var readyTextureCount = 0;
        var tileImageryCollection = tile.imagery;
        for ( var i = 0, len = tileImageryCollection.length; i < len; ++i) {
            if (tileImageryCollection[i].imagery.state === ImageryState.READY) {
                ++readyTextureCount;
            }
        }

        var tileSet = surface._tilesToRenderByTextureCount[readyTextureCount];
        if (typeof tileSet === 'undefined') {
            tileSet = [];
            surface._tilesToRenderByTextureCount[readyTextureCount] = tileSet;
        }

        tileSet.push(tile);

        ++surface._debug.tilesRendered;
        surface._debug.texturesRendered += readyTextureCount;
    }

    var boundingSphereScratch = new BoundingSphere();

    function isTileVisible(surface, frameState, tile) {
        var cullingVolume = frameState.cullingVolume;

        var boundingVolume = tile.boundingSphere3D;

        if (frameState.mode !== SceneMode.SCENE3D) {
            boundingVolume = boundingSphereScratch;
            // TODO: If we show terrain heights in Columbus View, the bounding sphere
            //       needs to be expanded to include the heights.
            BoundingSphere.fromExtent2D(tile.extent, frameState.scene2D.projection, boundingVolume);
            boundingVolume.center = new Cartesian3(0.0, boundingVolume.center.x, boundingVolume.center.y);

            if (frameState.mode === SceneMode.MORPHING) {
                boundingVolume = BoundingSphere.union(tile.boundingSphere3D, boundingVolume, boundingVolume);
            }
        }

        if (cullingVolume.getVisibility(boundingVolume) === Intersect.OUTSIDE) {
            return false;
        }

        if (frameState.mode === SceneMode.SCENE3D) {
            var occludeePointInScaledSpace = tile.getOccludeePointInScaledSpace();
            if (typeof occludeePointInScaledSpace === 'undefined') {
                return true;
            }

            return surface._ellipsoidalOccluder.isScaledSpacePointVisible(occludeePointInScaledSpace);
        }

        return true;
    }

    function distanceSquaredToTile(frameState, cameraCartesianPosition, cameraCartographicPosition, tile) {
        var southwestCornerCartesian = tile.southwestCornerCartesian;
        var northeastCornerCartesian = tile.northeastCornerCartesian;
        var westNormal = tile.westNormal;
        var southNormal = tile.southNormal;
        var eastNormal = tile.eastNormal;
        var northNormal = tile.northNormal;
        var maxHeight = tile.maxHeight;

        if (frameState.mode !== SceneMode.SCENE3D) {
            southwestCornerCartesian = frameState.scene2D.projection.project(tile.extent.getSouthwest());
            southwestCornerCartesian.z = southwestCornerCartesian.y;
            southwestCornerCartesian.y = southwestCornerCartesian.x;
            southwestCornerCartesian.x = 0.0;
            northeastCornerCartesian = frameState.scene2D.projection.project(tile.extent.getNortheast());
            northeastCornerCartesian.z = northeastCornerCartesian.y;
            northeastCornerCartesian.y = northeastCornerCartesian.x;
            northeastCornerCartesian.x = 0.0;
            westNormal = Cartesian3.UNIT_Y.negate();
            eastNormal = Cartesian3.UNIT_Y;
            southNormal = Cartesian3.UNIT_Z.negate();
            northNormal = Cartesian3.UNIT_Z;
            maxHeight = 0.0;
        }

        var vectorFromSouthwestCorner = cameraCartesianPosition.subtract(southwestCornerCartesian);
        var distanceToWestPlane = vectorFromSouthwestCorner.dot(westNormal);
        var distanceToSouthPlane = vectorFromSouthwestCorner.dot(southNormal);

        var vectorFromNortheastCorner = cameraCartesianPosition.subtract(northeastCornerCartesian);
        var distanceToEastPlane = vectorFromNortheastCorner.dot(eastNormal);
        var distanceToNorthPlane = vectorFromNortheastCorner.dot(northNormal);

        var cameraHeight;
        if (frameState.mode === SceneMode.SCENE3D) {
            cameraHeight = cameraCartographicPosition.height;
        } else {
            cameraHeight = cameraCartesianPosition.x;
        }
        var distanceFromTop = cameraHeight - maxHeight;

        var result = 0.0;

        if (distanceToWestPlane > 0.0) {
            result += distanceToWestPlane * distanceToWestPlane;
        } else if (distanceToEastPlane > 0.0) {
            result += distanceToEastPlane * distanceToEastPlane;
        }

        if (distanceToSouthPlane > 0.0) {
            result += distanceToSouthPlane * distanceToSouthPlane;
        } else if (distanceToNorthPlane > 0.0) {
            result += distanceToNorthPlane * distanceToNorthPlane;
        }

        if (distanceFromTop > 0.0) {
            result += distanceFromTop * distanceFromTop;
        }

        return result;
    }

    function screenSpaceError(surface, context, frameState, cameraPosition, cameraPositionCartographic, tile) {
        if (frameState.mode === SceneMode.SCENE2D) {
            return screenSpaceError2D(surface, context, frameState, cameraPosition, cameraPositionCartographic, tile);
        }

        var extent = tile.extent;

        var latitudeFactor = 1.0;

        // Adjust by latitude in 3D only.
        if (frameState.mode === SceneMode.SCENE3D) {
            var latitudeClosestToEquator = 0.0;
            if (extent.south > 0.0) {
                latitudeClosestToEquator = extent.south;
            } else if (extent.north < 0.0) {
                latitudeClosestToEquator = extent.north;
            }

            latitudeFactor = Math.cos(latitudeClosestToEquator);
        }

        var maxGeometricError = latitudeFactor * surface.terrainProvider.getLevelMaximumGeometricError(tile.level);


        var distance = Math.sqrt(distanceSquaredToTile(frameState, cameraPosition, cameraPositionCartographic, tile));
        tile.distance = distance;

        var canvas = context.getCanvas();
        var height = canvas.clientHeight;

        var camera = frameState.camera;
        var frustum = camera.frustum;
        var fovy = frustum.fovy;

        // PERFORMANCE_TODO: factor out stuff that's constant across tiles.
        return (maxGeometricError * height) / (2 * distance * Math.tan(0.5 * fovy));
    }

    function screenSpaceError2D(surface, context, frameState, cameraPosition, cameraPositionCartographic, tile) {
        var camera = frameState.camera;
        var frustum = camera.frustum;
        var canvas = context.getCanvas();
        var width = canvas.clientWidth;
        var height = canvas.clientHeight;

        var maxGeometricError = surface.terrainProvider.getLevelMaximumGeometricError(tile.level);
        var pixelSize = Math.max(frustum.top - frustum.bottom, frustum.right - frustum.left) / Math.max(width, height);
        return maxGeometricError / pixelSize;
    }

    function queueChildrenLoadAndDetermineIfChildrenAreAllRenderable(surface, frameState, tile) {
        if (tile.level === surface.terrainProvider.maxLevel) {
            return false;
        }

        var allRenderable = true;

        var children = tile.getChildren();
        for (var i = 0, len = children.length; i < len; ++i) {
            var child = children[i];
            surface._tileReplacementQueue.markTileRendered(child);
            // TODO: should we be culling here?  Technically, we don't know the
            // bounding volume accurately until the tile geometry is loaded.
//            if (!isTileVisible(surface, frameState, child)) {
//                continue;
//            }
            if (!child.doneLoading) {
                queueTileLoad(surface, child);
            }
            if (!child.renderable) {
                allRenderable = false;
            }
        }

        return allRenderable;
    }

    function queueTileLoad(surface, tile) {
        surface._tileLoadQueue.insertBeforeInsertionPoint(tile);
    }

    function processTileLoadQueue(surface, context, frameState) {
        var tileLoadQueue = surface._tileLoadQueue;
        var terrainProvider = surface.terrainProvider;

        var tile = tileLoadQueue.head;

        var startTime = Date.now();
        var timeSlice = 10;
        var endTime = startTime + timeSlice;

        while (Date.now() < endTime && typeof tile !== 'undefined') {
            var i, len;

            // Transition terrain states.
            if (tile.state === TileState.UNLOADED) {
                tile.state = TileState.TRANSITIONING;
                terrainProvider.requestTileGeometry(tile);

                // If we've made it past the UNLOADED state, add this tile to the replacement queue
                // (replacing another tile if necessary), and create skeletons for the imagery.
                if (tile.state !== TileState.UNLOADED) {
                    surface._tileReplacementQueue.markTileRendered(tile);

                    // TODO: Base this value on the minimum number of tiles needed,
                    // the amount of memory available, or something else?
                    surface._tileReplacementQueue.trimTiles(100);

                    var imageryLayerCollection = surface._imageryLayerCollection;
                    for (i = 0, len = imageryLayerCollection.getLength(); i < len; ++i) {
                        imageryLayerCollection.get(i).createTileImagerySkeletons(tile, terrainProvider);
                    }
                }
            }

            if (tile.state === TileState.RECEIVED) {
                tile.state = TileState.TRANSITIONING;
                terrainProvider.transformGeometry(context, tile);
            }

            if (tile.state === TileState.TRANSFORMED) {
                tile.state = TileState.TRANSITIONING;
                terrainProvider.createResources(context, tile);
            }
            // TODO: what about the FAILED and INVALID states?

            var doneLoading = tile.state === TileState.READY;

            // Transition imagery states
            var tileImageryCollection = tile.imagery;
            for (i = 0, len = tileImageryCollection.length; Date.now() < endTime && i < len; ++i) {
                var tileImagery = tileImageryCollection[i];
                var imagery = tileImagery.imagery;
                var imageryLayer = imagery.imageryLayer;

                if (imagery.state === ImageryState.PLACEHOLDER) {
                    if (imageryLayer.imageryProvider.isReady()) {
                        // Remove the placeholder and add the actual skeletons (if any)
                        // at the same position.  Then continue the loop at the same index.
                        imagery.releaseReference();
                        tileImageryCollection.splice(i, 1);
                        imageryLayer.createTileImagerySkeletons(tile, terrainProvider, i);
                        --i;
                        len = tileImageryCollection.length;
                    }
                }

                if (imagery.state === ImageryState.UNLOADED) {
                    imagery.state = ImageryState.TRANSITIONING;
                    imageryLayer.requestImagery(imagery);
                }

                if (imagery.state === ImageryState.RECEIVED) {
                    imagery.state = ImageryState.TRANSITIONING;
                    imageryLayer.createTexture(context, imagery);
                }

                if (imagery.state === ImageryState.TEXTURE_LOADED) {
                    imagery.state = ImageryState.TRANSITIONING;
                    imageryLayer.reprojectTexture(context, imagery);
                }

                if (imagery.state === ImageryState.FAILED || imagery.state === ImageryState.INVALID) {
                    // re-associate TileImagery with a parent Imagery that is not failed or invalid.
                    var parent = imagery.parent;
                    while (parent.state === ImageryState.FAILED || parent.state === ImageryState.INVALID) {
                        parent = parent.parent;
                    }

                    // use that parent imagery instead, storing the original imagery
                    // in originalImagery to keep it alive
                    tileImagery.originalImagery = imagery;

                    parent.addReference();
                    tileImagery.imagery = parent;
                    imagery = parent;
                }

                var imageryDoneLoading = imagery.state === ImageryState.READY;

                if (imageryDoneLoading && typeof tileImagery.textureTranslationAndScale === 'undefined') {
                    tileImagery.textureTranslationAndScale = imageryLayer.calculateTextureTranslationAndScale(tile, tileImagery);
                }

                doneLoading = doneLoading && imageryDoneLoading;
            }

            // The tile becomes renderable when the terrain and all imagery data are loaded.
            if (i === len && doneLoading) {
                tile.renderable = true;
                tile.doneLoading = true;
                tileLoadQueue.remove(tile);
            }

            tile = tile.loadNext;
        }
    }

    EllipsoidSurface.prototype.debugShowBoundingSphereOfTileAt = function(cartographicPick) {
        // Find the tile in the render list that overlaps this extent
        var tilesToRenderByTextureCount = this._tilesToRenderByTextureCount;
        var result;
        var tile;
        for (var i = 0; i < tilesToRenderByTextureCount.length && typeof result === 'undefined'; ++i) {
            var tileSet = tilesToRenderByTextureCount[i];
            if (typeof tileSet === 'undefined') {
                continue;
            }
            for (var j = 0; j < tileSet.length; ++j) {
                tile = tileSet[j];
                if (tile.extent.contains(cartographicPick)) {
                    result = tile;
                    break;
                }
            }
        }

        if (typeof result !== 'undefined') {
            console.log('x: ' + result.x + ' y: ' + result.y + ' level: ' + result.level);
        }

        this._debug.boundingSphereTile = result;
        this._debug.boundingSphereVA = undefined;
    };

    // This is debug code to render the bounding sphere of the tile in
    // EllipsoidSurface._debug.boundingSphereTile.
    function debugCreateCommandsForTileBoundingSphere(surface, context, frameState, centralBodyUniformMap, shaderSet, renderState, colorCommandList) {
        if (typeof surface._debug !== 'undefined' && typeof surface._debug.boundingSphereTile !== 'undefined') {
            if (!surface._debug.boundingSphereVA) {
                var radius = surface._debug.boundingSphereTile.boundingSphere3D.radius;
                var sphere = CubeMapEllipsoidTessellator.compute(new Ellipsoid(radius, radius, radius), 10);
                MeshFilters.toWireframeInPlace(sphere);
                surface._debug.boundingSphereVA = context.createVertexArrayFromMesh({
                    mesh : sphere,
                    attributeIndices : MeshFilters.createAttributeIndices(sphere)
                });
            }

            var rtc2 = surface._debug.boundingSphereTile.center;

            var uniformMap2 = createTileUniformMap();
            mergeUniformMap(uniformMap2, centralBodyUniformMap);

            uniformMap2.center3D = rtc2;

            var uniformState = context.getUniformState();
            var viewMatrix = frameState.camera.getViewMatrix();
            var projectionMatrix = uniformState.getProjection();

            var centerEye2 = viewMatrix.multiplyByVector(new Cartesian4(rtc2.x, rtc2.y, rtc2.z, 1.0));
            uniformMap2.modifiedModelView = viewMatrix.setColumn(3, centerEye2, uniformMap2.modifiedModelView);
            uniformMap2.modifiedModelViewProjection = Matrix4.multiply(projectionMatrix, uniformMap2.modifiedModelView, uniformMap2.modifiedModelViewProjection);

            uniformMap2.dayTextures[0] = context.getDefaultTexture();
            uniformMap2.dayTextureTranslationAndScale[0] = new Cartesian4(0.0, 0.0, 1.0, 1.0);
            uniformMap2.dayTextureTexCoordsExtent[0] = new Cartesian4(0.0, 0.0, 1.0, 1.0);
            uniformMap2.dayTextureAlpha[0] = 1.0;

            var boundingSphereCommand = new Command();
            boundingSphereCommand.shaderProgram = shaderSet.getShaderProgram(context, 1);
            boundingSphereCommand.renderState = renderState;
            boundingSphereCommand.primitiveType = PrimitiveType.LINES;
            boundingSphereCommand.vertexArray = surface._debug.boundingSphereVA;
            boundingSphereCommand.uniformMap = uniformMap2;

            colorCommandList.push(boundingSphereCommand);
        }
    }

    EllipsoidSurface.prototype.toggleLodUpdate = function(frameState) {
        this._debug.suspendLodUpdate = !this._debug.suspendLodUpdate;
    };

    function moveTileImageryObjects(tileImageryCollection, layer, newNextLayer) {
        var oldTileImageryIndex = -1;
        var newTileImageryIndex = -1;
        var numTileImagery = 0;
        for ( var i = 0, len = tileImageryCollection.length; i < len; ++i) {
            var tileImagery = tileImageryCollection[i];
            var tileImageryLayer = tileImagery.imagery.imageryLayer;

            if (newTileImageryIndex === -1 && tileImageryLayer === newNextLayer) {
                newTileImageryIndex = i;
            } else if (tileImageryLayer === layer) {
                ++numTileImagery;
                if (oldTileImageryIndex === -1) {
                    oldTileImageryIndex = i;
                }
            } else if (newTileImageryIndex !== -1 && oldTileImageryIndex !== -1) {
                // we have all the info we need, don't need to continue iterating
                break;
            }
        }

        // splice out TileImagerys from old location
        var tileImageryObjects = tileImageryCollection.splice(oldTileImageryIndex, numTileImagery);

        // splice them back into the new location using tileImagerys as the args array with apply
        if (newTileImageryIndex === -1) {
            newTileImageryIndex = tileImageryCollection.length;
        }
        tileImageryObjects.unshift(newTileImageryIndex, 0);
        Array.prototype.splice.apply(tileImageryCollection, tileImageryObjects);
    }

    function tileDistanceSortFunction(a, b) {
        return a.distance - b.distance;
    }

    function createTileUniformMap() {
        return {
            u_center3D : function() {
                return this.center3D;
            },
            u_tileExtent : function() {
                return this.tileExtent;
            },
            u_modifiedModelView : function() {
                return this.modifiedModelView;
            },
            u_modifiedModelViewProjection : function() {
                return this.modifiedModelViewProjection;
            },
            u_dayTextures : function() {
                return this.dayTextures;
            },
            u_dayTextureTranslationAndScale : function() {
                return this.dayTextureTranslationAndScale;
            },
            u_dayTextureTexCoordsExtent : function() {
                return this.dayTextureTexCoordsExtent;
            },
            u_dayTextureAlpha : function() {
                return this.dayTextureAlpha;
            },
            u_dayIntensity : function() {
                return 0.2;
            },
            u_southLatitude : function() {
                return this.southLatitude;
            },
            u_northLatitude : function() {
                return this.northLatitude;
            },
            u_southMercatorYLow : function() {
                return this.southMercatorYLow;
            },
            u_southMercatorYHigh : function() {
                return this.southMercatorYHigh;
            },
            u_oneOverMercatorHeight : function() {
                return this.oneOverMercatorHeight;
            },

            center3D : undefined,
            modifiedModelView : new Matrix4(),
            modifiedModelViewProjection : new Matrix4(),
            tileExtent : new Cartesian4(),

            dayTextures : [],
            dayTextureTranslationAndScale : [],
            dayTextureTexCoordsExtent : [],
            dayTextureAlpha : [],

            southLatitude : 0.0,
            northLatitude : 0.0,
            southMercatorYLow : 0.0,
            southMercatorYHigh : 0.0,
            oneOverMercatorHeight : 0.0
        };
    }

    function mergeUniformMap(target, source) {
        for (var property in source) {
            if (source.hasOwnProperty(property)) {
                target[property] = source[property];
            }
        }
    }

    var float32ArrayScratch = new Float32Array(1);
    var modifiedModelViewScratch = new Matrix4();
    var modifiedModelViewProjectionScratch = new Matrix4();
    var tileExtentScratch = new Cartesian4();
    var rtcScratch = new Cartesian3();
    var centerEyeScratch = new Cartesian4();

    function selectTilesForRendering(surface, context, frameState) {
        if (surface._debug.suspendLodUpdate) {
            return;
        }

        var i, len;

        // Clear the render list.
        var tilesToRenderByTextureCount = surface._tilesToRenderByTextureCount;
        for (i = 0, len = tilesToRenderByTextureCount.length; i < len; ++i) {
            var tiles = tilesToRenderByTextureCount[i];
            if (typeof tiles !== 'undefined') {
                tiles.length = 0;
            }
        }

        // We can't render anything before the level zero tiles exist.
        if (typeof surface._levelZeroTiles === 'undefined') {
            return;
        }

        var traversalQueue = surface._tileTraversalQueue;
        traversalQueue.clear();

        surface._debug.maxDepth = 0;
        surface._debug.tilesVisited = 0;
        surface._debug.tilesCulled = 0;
        surface._debug.tilesRendered = 0;
        surface._debug.texturesRendered = 0;

        surface._tileLoadQueue.markInsertionPoint();
        surface._tileReplacementQueue.markStartOfRenderFrame();

        var cameraPosition = frameState.camera.getPositionWC();

        var ellipsoid = surface.terrainProvider.tilingScheme.ellipsoid;
        var cameraPositionCartographic = ellipsoid.cartesianToCartographic(cameraPosition);

        surface._occluder.setCameraPosition(cameraPosition);
        surface._ellipsoidalOccluder.setCameraPosition(cameraPosition);

        var tile;

        // Enqueue the root tiles that are renderable and visible.
        var levelZeroTiles = surface._levelZeroTiles;
        for (i = 0, len = levelZeroTiles.length; i < len; ++i) {
            tile = levelZeroTiles[i];
            if (!tile.doneLoading) {
                queueTileLoad(surface, tile);
            }
            if (tile.renderable && isTileVisible(surface, frameState, tile)) {
                traversalQueue.enqueue(tile);
            } else {
                ++surface._debug.tilesCulled;
            }
        }

        // Traverse the tiles in breadth-first order.
        // This ordering allows us to load bigger, lower-detail tiles before smaller, higher-detail ones.
        // This maximizes the average detail across the scene and results in fewer sharp transitions
        // between very different LODs.
        while (typeof (tile = traversalQueue.dequeue()) !== 'undefined') {
            ++surface._debug.tilesVisited;

            surface._tileReplacementQueue.markTileRendered(tile);

            if (tile.level > surface._debug.maxDepth) {
                surface._debug.maxDepth = tile.level;
            }

            // There are a few different algorithms we could use here.
            // This one doesn't load children unless we refine to them.
            // We may want to revisit this in the future.

            if (screenSpaceError(surface, context, frameState, cameraPosition, cameraPositionCartographic, tile) < surface.maxScreenSpaceError) {
                // This tile meets SSE requirements, so render it.
                addTileToRenderList(surface, tile);
            } else if (queueChildrenLoadAndDetermineIfChildrenAreAllRenderable(surface, frameState, tile)) {
                // SSE is not good enough and children are loaded, so refine.
                var children = tile.children;
                // PERFORMANCE_TODO: traverse children front-to-back so we can avoid sorting by distance later.
                for (i = 0, len = children.length; i < len; ++i) {
                    if (isTileVisible(surface, frameState, children[i])) {
                        traversalQueue.enqueue(children[i]);
                    } else {
                        ++surface._debug.tilesCulled;
                    }
                }
            } else {
                // SSE is not good enough but not all children are loaded, so render this tile anyway.
                addTileToRenderList(surface, tile);
            }
        }

        if (surface._debug.tilesVisited !== surface._debug.lastTilesVisited ||
            surface._debug.tilesRendered !== surface._debug.lastTilesRendered ||
            surface._debug.texturesRendered !== surface._debug.lastTexturesRendered ||
            surface._debug.tilesCulled !== surface._debug.lastTilesCulled ||
            surface._debug.maxDepth !== surface._debug.lastMaxDepth) {

            console.log('Visited ' + surface._debug.tilesVisited + ', Rendered: ' + surface._debug.tilesRendered + ', Textures: ' + surface._debug.texturesRendered + ', Culled: ' + surface._debug.tilesCulled + ', Max Depth: ' + surface._debug.maxDepth);

            surface._debug.lastTilesVisited = surface._debug.tilesVisited;
            surface._debug.lastTilesRendered = surface._debug.tilesRendered;
            surface._debug.lastTexturesRendered = surface._debug.texturesRendered;
            surface._debug.lastTilesCulled = surface._debug.tilesCulled;
            surface._debug.lastMaxDepth = surface._debug.maxDepth;
        }
    }

    function createRenderCommandsForSelectedTiles(surface, context, frameState, shaderSet, mode, projection, centralBodyUniformMap, colorCommandList, renderState) {
        var uniformState = context.getUniformState();
        var viewMatrix = frameState.camera.getViewMatrix();
        var projectionMatrix = uniformState.getProjection();

        var maxTextures = context.getMaximumTextureImageUnits();

        var tileCommands = surface._tileCommands;
        var tileCommandUniformMaps = surface._tileCommandUniformMaps;
        var tileCommandIndex = -1;

        var tilesToRenderByTextureCount = surface._tilesToRenderByTextureCount;
        for (var tileSetIndex = 0, tileSetLength = tilesToRenderByTextureCount.length; tileSetIndex < tileSetLength; ++tileSetIndex) {
            var tileSet = tilesToRenderByTextureCount[tileSetIndex];
            if (typeof tileSet === 'undefined' || tileSet.length === 0) {
                continue;
            }

            tileSet.sort(tileDistanceSortFunction);

            var shaderProgram = shaderSet.getShaderProgram(context, tileSetIndex);

            for (var i = 0, len = tileSet.length; i < len; i++) {
                var tile = tileSet[i];

                var rtc = tile.center;

                // Not used in 3D.
                var tileExtent = tileExtentScratch;

                // Only used for Mercator projections.
                var southLatitude = 0.0;
                var northLatitude = 0.0;
                var southMercatorYHigh = 0.0;
                var southMercatorYLow = 0.0;
                var oneOverMercatorHeight = 0.0;

                if (mode !== SceneMode.SCENE3D) {
                    var southwest = projection.project(tile.extent.getSouthwest());
                    var northeast = projection.project(tile.extent.getNortheast());

                    tileExtent.x = southwest.x;
                    tileExtent.y = southwest.y;
                    tileExtent.z = northeast.x;
                    tileExtent.w = northeast.y;

                    // In 2D, use the center of the tile for RTC rendering.
                    if (mode === SceneMode.SCENE2D) {
                        rtc = rtcScratch;
                        rtc.x = 0.0;
                        rtc.y = (tileExtent.z + tileExtent.x) * 0.5;
                        rtc.z = (tileExtent.w + tileExtent.y) * 0.5;
                        tileExtent.x -= rtc.y;
                        tileExtent.y -= rtc.z;
                        tileExtent.z -= rtc.y;
                        tileExtent.w -= rtc.z;
                    }

                    if (projection instanceof WebMercatorProjection) {
                        southLatitude = tile.extent.south;
                        northLatitude = tile.extent.north;

                        var southMercatorY = WebMercatorProjection.geodeticLatitudeToMercatorAngle(southLatitude);
                        var northMercatorY = WebMercatorProjection.geodeticLatitudeToMercatorAngle(northLatitude);

                        float32ArrayScratch[0] = southMercatorY;
                        southMercatorYHigh = float32ArrayScratch[0];
                        southMercatorYLow = southMercatorY - float32ArrayScratch[0];

                        oneOverMercatorHeight = 1.0 / (northMercatorY - southMercatorY);
                    }
                }

                var centerEye = centerEyeScratch;
                centerEye.x = rtc.x;
                centerEye.y = rtc.y;
                centerEye.z = rtc.z;
                centerEye.w = 1.0;

                Matrix4.multiplyByVector(viewMatrix, centerEye, centerEye);
                viewMatrix.setColumn(3, centerEye, modifiedModelViewScratch);
                Matrix4.multiply(projectionMatrix, modifiedModelViewScratch, modifiedModelViewProjectionScratch);

                var tileImageryCollection = tile.imagery;
                var imageryIndex = 0;
                var imageryLen = tileImageryCollection.length;

                do {
                    var numberOfDayTextures = 0;

                    ++tileCommandIndex;
                    var command = tileCommands[tileCommandIndex];
                    if (typeof command === 'undefined') {
                        command = new Command();
                        tileCommands[tileCommandIndex] = command;
                        tileCommandUniformMaps[tileCommandIndex] = createTileUniformMap();
                    }
                    var uniformMap = tileCommandUniformMaps[tileCommandIndex];

                    mergeUniformMap(uniformMap, centralBodyUniformMap);

                    uniformMap.center3D = tile.center;

                    Cartesian4.clone(tileExtent, uniformMap.tileExtent);
                    uniformMap.southLatitude = southLatitude;
                    uniformMap.northLatitude = northLatitude;
                    uniformMap.southMercatorYHigh = southMercatorYHigh;
                    uniformMap.southMercatorYLow = southMercatorYLow;
                    uniformMap.oneOverMercatorHeight = oneOverMercatorHeight;
                    Matrix4.clone(modifiedModelViewScratch, uniformMap.modifiedModelView);
                    Matrix4.clone(modifiedModelViewProjectionScratch, uniformMap.modifiedModelViewProjection);

                    while (numberOfDayTextures < maxTextures && imageryIndex < imageryLen) {
                        var tileImagery = tileImageryCollection[imageryIndex];
                        var imagery = tileImagery.imagery;
                        var imageryLayer = imagery.imageryLayer;
                        ++imageryIndex;

                        if (imagery.state !== ImageryState.READY) {
                            continue;
                        }

                        uniformMap.dayTextures[numberOfDayTextures] = imagery.texture;
                        uniformMap.dayTextureTranslationAndScale[numberOfDayTextures] = tileImagery.textureTranslationAndScale;
                        uniformMap.dayTextureTexCoordsExtent[numberOfDayTextures] = tileImagery.textureCoordinateExtent;
                        uniformMap.dayTextureAlpha[numberOfDayTextures] = imageryLayer.alpha;

                        ++numberOfDayTextures;
                    }

                    // trim texture array to the used length so we don't end up using old textures
                    // which might get destroyed eventually
                    uniformMap.dayTextures.length = numberOfDayTextures;

                    colorCommandList.push(command);

                    command.shaderProgram = shaderProgram;
                    command.renderState = renderState;
                    command.primitiveType = TerrainProvider.wireframe ? PrimitiveType.LINES : PrimitiveType.TRIANGLES;
                    command.vertexArray = tile.vertexArray;
                    command.uniformMap = uniformMap;

                    var boundingVolume = tile.boundingSphere3D;

                    if (frameState.mode !== SceneMode.SCENE3D) {
                        boundingVolume = boundingSphereScratch;
                        // TODO: If we show terrain heights in Columbus View, the bounding sphere
                        //       needs to be expanded to include the heights.
                        BoundingSphere.fromExtent2D(tile.extent, frameState.scene2D.projection, boundingVolume);
                        boundingVolume.center = new Cartesian3(0.0, boundingVolume.center.x, boundingVolume.center.y);

                        if (frameState.mode === SceneMode.MORPHING) {
                            boundingVolume = BoundingSphere.union(tile.boundingSphere3D, boundingVolume, boundingVolume);
                        }
                    }

                    command.boundingVolume = boundingVolume;

                } while (imageryIndex < imageryLen);
            }
        }

        // trim command list to the number actually needed
        tileCommands.length = Math.max(0, tileCommandIndex);
    }

    return EllipsoidSurface;
});
