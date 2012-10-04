/*global define*/
define([
        '../Core/defaultValue',
        '../Core/loadImage',
        '../Core/DeveloperError',
        '../Core/Extent',
        './GeographicTilingScheme'
    ], function(
        defaultValue,
        loadImage,
        DeveloperError,
        Extent,
        GeographicTilingScheme) {
    "use strict";

    /**
     * Provides a single, top-level imagery tile.  The single image is assumed to use a
     * {@link GeographicTilingScheme}.
     *
     * @alias SingleTileImageryProvider
     * @constructor
     *
     * @param {String} description.url The url for the tile.
     * @param {Extent} [description.extent=Extent.MAX_VALUE] The extent, in radians, covered by the image.
     * @param {String} [description.credit] A string crediting the data source, which is displayed on the canvas.
     * @param {Object} [description.proxy] A proxy to use for requests. This object is expected to have a getURL function which returns the proxied URL, if needed.
     *
     * @exception {DeveloperError} description.url is required.
     *
     * @see ArcGisMapServerImageryProvider
     * @see BingMapsImageryProvider
     * @see OpenStreetMapImageryProvider
     * @see WebMapServiceImageryProvider
     */
    var SingleTileImageryProvider = function(description) {
        description = defaultValue(description, {});

        var url = description.url;
        if (typeof url === 'undefined') {
            throw new DeveloperError('url is required.');
        }

        this._url = url;

        var proxy = description.proxy;
        this._proxy = proxy;

        this._maximumLevel = 0;

        var extent = defaultValue(description.extent, Extent.MAX_VALUE);
        var tilingScheme = new GeographicTilingScheme({
            extent : extent,
            numberOfLevelZeroTilesX : 1,
            numberOfLevelZeroTilesY : 1
        });
        this._tilingScheme = tilingScheme;

        this._image = undefined;
        this._texture = undefined;

        this._ready = false;

        var imageUrl = url;
        if (typeof proxy !== 'undefined') {
            imageUrl = proxy.getURL(imageUrl);
        }

        // Create the credit message.
        if (typeof description.credit !== 'undefined') {
            // Create the copyright message.
            this._logo = writeTextToCanvas(description.credit, {
                font : '12px sans-serif'
            });
        }

        var that = this;
        loadImage(imageUrl).then(function(image) {
            that._image = image;
            that._ready = true;
        });
    };

    /**
     * Gets the URL of the single, top-level imagery tile.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {String} The URL.
     */
    SingleTileImageryProvider.prototype.getUrl = function() {
        return this._url;
    };

    /**
     * Gets the width of each tile, in pixels.  This function should
     * not be called before {@link SingleTileImageryProvider#isReady} returns true.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {Number} The width.
     */
    SingleTileImageryProvider.prototype.getTileWidth = function() {
        return this._tileWidth;
    };

    /**
     * Gets the height of each tile, in pixels.  This function should
     * not be called before {@link SingleTileImageryProvider#isReady} returns true.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {Number} The height.
     */
    SingleTileImageryProvider.prototype.getTileHeight = function() {
        return this._tileHeight;
    };

    /**
     * Gets the maximum level-of-detail that can be requested.  This function should
     * not be called before {@link SingleTileImageryProvider#isReady} returns true.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {Number} The maximum level.
     */
    SingleTileImageryProvider.prototype.getMaximumLevel = function() {
        return this._maximumLevel;
    };

    /**
     * Gets the tiling scheme used by this provider.  This function should
     * not be called before {@link SingleTileImageryProvider#isReady} returns true.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {TilingScheme} The tiling scheme.
     * @see WebMercatorTilingScheme
     * @see GeographicTilingScheme
     */
    SingleTileImageryProvider.prototype.getTilingScheme = function() {
        return this._tilingScheme;
    };

    /**
     * Gets the extent, in radians, of the imagery provided by this instance.  This function should
     * not be called before {@link SingleTileImageryProvider#isReady} returns true.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {Extent} The extent.
     */
    SingleTileImageryProvider.prototype.getExtent = function() {
        return this._tilingScheme.getExtent();
    };

    /**
     * Gets the tile discard policy.  If not undefined, the discard policy is responsible
     * for filtering out "missing" tiles via its shouldDiscardImage function.  If this function
     * returns undefined, no tiles are filtered.  This function should
     * not be called before {@link SingleTileImageryProvider#isReady} returns true.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {TileDiscardPolicy} The discard policy.
     *
     * @see DiscardMissingTileImagePolicy
     * @see NeverTileDiscardPolicy
     */
    SingleTileImageryProvider.prototype.getTileDiscardPolicy = function() {
        return this._tileDiscardPolicy;
    };

    /**
     * Gets a value indicating whether or not the provider is ready for use.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {Boolean} True if the provider is ready to use; otherwise, false.
     */
    SingleTileImageryProvider.prototype.isReady = function() {
        return this._ready;
    };

    /**
     * Requests the image for a given tile.  This function should
     * not be called before {@link SingleTileImageryProvider#isReady} returns true.
     *
     * @memberof SingleTileImageryProvider
     *
     * @param {Number} x The tile X coordinate.
     * @param {Number} y The tile Y coordinate.
     * @param {Number} level The tile level.
     *
     * @returns {Promise} A promise for the image that will resolve when the image is available, or
     *          undefined if there are too many active requests to the server, and the request
     *          should be retried later.  The resolved image may be either an
     *          Image or a Canvas DOM object.
     */
    SingleTileImageryProvider.prototype.requestImage = function(x, y, level) {
        return this._image;
    };

    /**
     * Gets the logo to display when this imagery provider is active.  Typically this is used to credit
     * the source of the imagery.  This function should not be called before {@link SingleTileImageryProvider#isReady} returns true.
     *
     * @memberof SingleTileImageryProvider
     *
     * @returns {Image|Canvas} A canvas or image containing the log to display, or undefined if there is no logo.
     */
    SingleTileImageryProvider.prototype.getLogo = function() {
        return this._logo;
    };

    return SingleTileImageryProvider;
});